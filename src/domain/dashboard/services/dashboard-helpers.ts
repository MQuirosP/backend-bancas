import { Prisma } from "../../../generated/prisma/client";
import { tz } from "../../../utils/timezone";
import { DashboardFilters } from "../dashboard.types";

export function toCostaRicaDateString(date: Date): string {
  return tz.toDateStr(date);
}

/**
 * Formatea un Date a ISO 8601 con offset de Costa Rica (-06:00)
 */
export function formatCostaRicaISO(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}-06:00`;
}

/**
 * Formatea un Date a YYYY-MM-DD en zona horaria de Costa Rica
 */
export function formatCostaRicaDate(date: Date): string {
  return tz.fromPrismaDate(date);
}

/**
 * Formatea label según granularity
 */
export function formatTimeSeriesLabel(date: Date, granularity: 'hour' | 'day' | 'week' | 'month'): string {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  switch (granularity) {
    case 'hour': {
      const hours = date.getUTCHours();
      const minutes = date.getUTCMinutes();
      const displayHours = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    }
    case 'day': {
      const day = date.getUTCDate();
      const month = months[date.getUTCMonth()];
      return `${day} ${month}`;
    }
    case 'week': {
      const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const daysSinceStart = Math.floor((date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
      const weekNumber = Math.ceil((daysSinceStart + startOfYear.getUTCDay() + 1) / 7);
      return `Sem ${weekNumber}`;
    }
    case 'month': {
      return months[date.getUTCMonth()];
    }
    default:
      return formatCostaRicaDate(date);
  }
}

/**
 * Calcula el período anterior para comparación
 */
export function calculatePreviousPeriodDates(fromDate: Date, toDate: Date): { fromDate: Date; toDate: Date } {
  const diffMs = toDate.getTime() - fromDate.getTime();
  const previousToDate = new Date(fromDate.getTime() - 1);
  const previousFromDate = new Date(previousToDate.getTime() - diffMs);
  return { fromDate: previousFromDate, toDate: previousToDate };
}

export function getBusinessDateRangeStrings(filters: DashboardFilters) {
  const fromDateStr = toCostaRicaDateString(filters.fromDate);
  const toDateStr = toCostaRicaDateString(filters.toDate);
  return { fromDateStr, toDateStr };
}

export function ticketBusinessDateCondition(alias: string, fromDateStr: string, toDateStr: string) {
  return Prisma.sql`
    ${Prisma.raw(`${alias}."businessDate"`)} BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
  `;
}

export function buildTicketBaseFilters(
  alias: string,
  filters: DashboardFilters,
  fromDateStr: string,
  toDateStr: string,
  skipExclusion: boolean = false,
  includeAllSorteos: boolean = false
) {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(`${alias}."deletedAt"`)} IS NULL`,
    Prisma.sql`${Prisma.raw(`${alias}."isActive"`)} = true`,
    Prisma.sql`${Prisma.raw(`${alias}."status"`)} IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
    ticketBusinessDateCondition(alias, fromDateStr, toDateStr),
  ];

  if (!includeAllSorteos) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Sorteo" s
      WHERE s.id = ${Prisma.raw(`${alias}."sorteoId"`)}
      AND s.status = 'EVALUATED'
    )`);
  }

  if (!skipExclusion) {
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "sorteo_lista_exclusion" sle
      JOIN "User" u ON u.id = sle.ventana_id
      WHERE sle.sorteo_id = ${Prisma.raw(`${alias}."sorteoId"`)}
      AND u."ventanaId" = ${Prisma.raw(`${alias}."ventanaId"`)}
      AND (sle.vendedor_id IS NULL OR sle.vendedor_id = ${Prisma.raw(`${alias}."vendedorId"`)})
      AND sle.multiplier_id IS NULL
    )`);
  }

  if (filters.ventanaId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."ventanaId"`)} = CAST(${filters.ventanaId} AS uuid)`);
  }

  if (filters.bancaId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."bancaId"`)} = CAST(${filters.bancaId} AS uuid)`);
  }

  if (filters.loteriaId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."loteriaId"`)} = CAST(${filters.loteriaId} AS uuid)`);
  }

  if (filters.vendedorId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."vendedorId"`)} = CAST(${filters.vendedorId} AS uuid)`);
  }

  let combined = conditions[0];
  for (let i = 1; i < conditions.length; i++) {
    combined = Prisma.sql`${combined} AND ${conditions[i]}`;
  }

  return combined;
}

export function parseDateStartCR(dateStr: string): Date {
  return tz.startOfDay(dateStr);
}

export function parseDateEndCR(dateStr: string): Date {
  return tz.endOfDay(dateStr);
}

export function parseDateStartDbDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function parseDateEndDbDate(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}
