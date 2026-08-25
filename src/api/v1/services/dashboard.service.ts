import { Prisma, Role, BetType } from "../../../generated/prisma/client";
import { getCRLocalComponents } from '../../../utils/businessDate';
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { commissionResolver } from "../../../services/commission/CommissionResolver";
import { getPreviousMonthFinalBalance, getPreviousMonthFinalBalancesBatch } from "./accounts/accounts.balances";
import { getMonthlyRemainingBalance, getMonthlyRemainingBalancesBatch } from "./accounts/accounts.service";
import { resolveDateRange } from "../../../utils/dateRange";
import { crDateService } from "../../../utils/crDateService";
import { tz } from "../../../utils/timezone";
import { PerformanceMonitor, measureAsync } from "../../../utils/performanceMonitor";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { CacheService } from "../../../core/cache.service";
import { ReportCache } from "../../../utils/reportCache";

/**
 * Dashboard Service
 * Calcula métricas financieras: Ganancia, CxC (Cuentas por Cobrar), CxP (Cuentas por Pagar)
 */

interface DashboardFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string; // Para RBAC
  vendedorId?: string; //  NUEVO: Filtro global por vendedor
  bancaId?: string; // Para filtrar por banca activa (ADMIN multibanca)
  loteriaId?: string; // Filtro por lotería
  betType?: 'NUMERO' | 'REVENTADO'; // Filtro por tipo de apuesta
  status?: string; //  NUEVO: Filtro por estado del sorteo (OPEN, EVALUATED, CLOSED)
  scope?: 'all' | 'byVentana';
  dimension?: 'ventana' | 'loteria' | 'vendedor'; // Agrupación
  top?: number; // Limitar resultados
  orderBy?: string; // Campo para ordenar
  order?: 'asc' | 'desc'; // Dirección
  page?: number; // Paginación
  pageSize?: number; // Tamaño de página
  interval?: 'day' | 'hour' | 'week' | 'month'; // Para timeseries
  aging?: boolean; // Para CxC aging
  compare?: boolean; // Para comparación con período anterior
  cxcDimension?: 'ventana' | 'vendedor'; //  NUEVO: Dimensión para CxC/CxP (default: 'ventana')
}

interface GananciaResult {
  totalAmount: number; // mantiene compatibilidad: comisiones totales (usuario + ventana)
  totalSales: number;
  totalPayouts: number;
  totalNet: number;
  margin: number;
  commissionUserTotal: number;
  commissionVentanaTotal: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    sales: number;
    amount: number; // compatibilidad: comisiones totales
    commissions: number;
    commissionUser: number;
    commissionVentana: number;
    payout: number;
    net: number;
    margin: number;
    tickets: number;
    winners: number;
    winRate: number;
    isActive: boolean;
    periodBalance: number; //  NUEVO: Saldo del periodo filtrado
  }>;
  byLoteria: Array<{
    loteriaId: string;
    loteriaName: string;
    sales: number;
    amount: number; // compatibilidad: comisiones totales
    commissions: number;
    commissionUser: number;
    commissionVentana: number;
    payout: number;
    net: number;
    margin: number;
    tickets: number;
    winners: number;
    isActive: boolean;
  }>;
}

interface CxCResult {
  totalAmount: number;
  byVentana?: Array<{
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    amount: number; // compatibilidad: saldo positivo (CxC)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; //  NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
    };
    isActive: boolean;
  }>;
  byVendedor?: Array<{
    vendedorId: string;
    vendedorName: string;
    vendedorCode?: string;
    ventanaId?: string;
    ventanaName?: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    amount: number; // compatibilidad: saldo positivo (CxC)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; //  NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
    };
    isActive: boolean;
  }>;
}

interface CxPResult {
  totalAmount: number;
  byVentana?: Array<{
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    totalPaidToVentana: number; // Para CxP según documento
    amount: number; // compatibilidad: saldo positivo (CxP)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; //  NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
    };
    isActive: boolean;
  }>;
  byVendedor?: Array<{
    vendedorId: string;
    vendedorName: string;
    vendedorCode?: string;
    ventanaId?: string;
    ventanaName?: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    totalPaidToVentana: number; // Para CxP según documento
    amount: number; // compatibilidad: saldo positivo (CxP)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; //  NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
    };
    isActive: boolean;
  }>;
}

interface DashboardSummary {
  totalSales: number;
  totalPayouts: number;
  totalCommissions: number;
  commissionUser: number;
  commissionVentana: number;
  commissionVentanaTotal: number; // Alias para compatibilidad con frontend
  gananciaListeros?: number; //  NUEVO: Ganancia neta de listeros (commissionVentana - commissionUser)
  gananciaBanca?: number; //  NUEVO: Alias conceptual para net
  totalTickets: number;
  winningTickets: number;
  net: number;
  margin: number; //  PORCENTAJE: Margen neto con máximo 2 decimales (toFixed(2))
  winRate: number; //  PORCENTAJE: Tasa de ganancia con máximo 2 decimales (toFixed(2))
}

const COSTA_RICA_OFFSET_HOURS = -6; // mantenido para compatibilidad, ya no se usa en matemáticas

function toCostaRicaDateString(date: Date): string {
  return tz.toDateStr(date);
}

/**
 * Formata un Date a ISO 8601 con offset de Costa Rica (-06:00)
 * El Date viene de PostgreSQL que ya aplicó AT TIME ZONE 'America/Costa_Rica'.
 * Prisma interpreta ese timestamp como UTC, pero sus componentes UTC
 * ya representan la hora local CR correctamente.
 */
function formatCostaRicaISO(date: Date): string {
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
function formatCostaRicaDate(date: Date): string {
  return tz.fromPrismaDate(date);
}

/**
 * Formatea label según granularity
 * hour → "14:00", "15:00", etc.
 * day → "15 ene", "16 ene", etc.
 * week → "Sem 1", "Sem 2", etc.
 * month → "ene", "feb", etc.
 */
function formatTimeSeriesLabel(date: Date, granularity: 'hour' | 'day' | 'week' | 'month'): string {
  // Date viene de Postgres con AT TIME ZONE. Prisma lo interpreta como UTC,
  // pero sus componentes UTC ya representan la hora local CR.
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
function calculatePreviousPeriod(fromDate: Date, toDate: Date): { fromDate: Date; toDate: Date } {
  const diffMs = toDate.getTime() - fromDate.getTime();
  const previousToDate = new Date(fromDate.getTime() - 1); // Un día antes del inicio
  const previousFromDate = new Date(previousToDate.getTime() - diffMs);
  return { fromDate: previousFromDate, toDate: previousToDate };
}

function getBusinessDateRangeStrings(filters: DashboardFilters) {
  const fromDateStr = toCostaRicaDateString(filters.fromDate);
  const toDateStr = toCostaRicaDateString(filters.toDate);
  return { fromDateStr, toDateStr };
}

function ticketBusinessDateCondition(alias: string, fromDateStr: string, toDateStr: string) {
  // businessDate siempre está poblado en producción (validado 2026-02-28).
  // Filtro directo sobre la columna indexada: sin COALESCE ni OR que rompan sargability.
  return Prisma.sql`
    ${Prisma.raw(`${alias}."businessDate"`)} BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
  `;
}

function buildTicketBaseFilters(
  alias: string,
  filters: DashboardFilters,
  fromDateStr: string,
  toDateStr: string,
  skipExclusion: boolean = false,
  includeAllSorteos: boolean = false //  NUEVO: Permitir incluir sorteos OPEN/CLOSED
) {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(`${alias}."deletedAt"`)} IS NULL`,
    Prisma.sql`${Prisma.raw(`${alias}."isActive"`)} = true`,
    Prisma.sql`${Prisma.raw(`${alias}."status"`)} IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
    ticketBusinessDateCondition(alias, fromDateStr, toDateStr),
  ];

  //  CAMBIO STRICT: Solo incluir sorteos EVALUATED por defecto
  if (!includeAllSorteos) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Sorteo" s
      WHERE s.id = ${Prisma.raw(`${alias}."sorteoId"`)}
      AND s.status = 'EVALUATED'
    )`);
  }

  // Excluir tickets de listas bloqueadas (solo si hay exclusiones activas)
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

  // Filtrar por banca activa (para ADMIN multibanca)
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

/**
 * Retorna el fragmento WITH del CTE de exclusiones por jugada que precede a tickets_in_range
 * en las queries de calculateGanancia.
 * Sin MATERIALIZED: el planner puede elegir hash anti-join (O(n)) en lugar de
 * sequential scan O(n×m) contra una tabla temporal.
 */
function buildExclusionCTEsPreamble(skipExclusion: boolean = false): Prisma.Sql {
  if (skipExclusion) {
    // Stub vacío — sin scan a sorteo_lista_exclusion, NOT EXISTS siempre retorna vacío (sin efecto)
    return Prisma.sql`
      jugada_exclusions AS (
        SELECT CAST(NULL AS uuid) AS sorteo_id, CAST(NULL AS uuid) AS "ventanaId", CAST(NULL AS uuid) AS vendedor_id, CAST(NULL AS uuid) AS multiplier_id
        WHERE 1 = 0
      ),
    `;
  }
  return Prisma.sql`
    jugada_exclusions AS (
      SELECT sle.sorteo_id, u."ventanaId", sle.vendedor_id, sle.multiplier_id
      FROM   "sorteo_lista_exclusion" sle
      JOIN   "User" u ON u.id = sle.ventana_id
      WHERE  sle.multiplier_id IS NOT NULL
    ),
  `;
}

function parseDateStartCR(dateStr: string): Date {
  return tz.startOfDay(dateStr);
}

function parseDateEndCR(dateStr: string): Date {
  return tz.endOfDay(dateStr);
}

function parseDateStartDbDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function parseDateEndDbDate(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function buildTicketWhereInput(
  filters: DashboardFilters,
  fromDateStr: string,
  toDateStr: string
): Prisma.TicketWhereInput {
  const rangeStartCR = parseDateStartCR(fromDateStr);
  const rangeEndCR = parseDateEndCR(toDateStr);
  
  const rangeStartDbDate = parseDateStartDbDate(fromDateStr);
  const rangeEndDbDate = parseDateEndDbDate(toDateStr);

  const baseWhere: Prisma.TicketWhereInput = {
    deletedAt: null,
    isActive: true,
    status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
    //  CAMBIO STRICT: Solo incluir tickets de sorteos EVALUATED
    sorteo: {
      status: "EVALUATED",
    },
    AND: [
      {
        OR: [
          {
            businessDate: {
              gte: rangeStartDbDate,
              lte: rangeEndDbDate,
            },
          },
          {
            businessDate: null,
            createdAt: {
              gte: rangeStartCR,
              lte: rangeEndCR,
            },
          },
        ],
      },
    ],
  };

  if (filters.ventanaId) {
    baseWhere.ventanaId = filters.ventanaId;
  }

  // Filtrar por banca activa (para ADMIN multibanca)
  if (filters.bancaId) {
    baseWhere.ventana = {
      bancaId: filters.bancaId,
    };
  }

  if (filters.loteriaId) {
    baseWhere.loteriaId = filters.loteriaId;
  }

  if (filters.vendedorId) {
    baseWhere.vendedorId = filters.vendedorId;
  }

  return baseWhere;
}

async function computeVentanaCommissionFromPolicies(filters: DashboardFilters) {
  const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
  const ticketWhere = buildTicketWhereInput(filters, fromDateStr, toDateStr);

  const jugadas = await prisma.jugada.findMany({
    where: {
      deletedAt: null,
      ticket: ticketWhere,
    },
    select: {
      amount: true,
      type: true,
      finalMultiplierX: true,
      ticket: {
        select: {
          ventanaId: true,
          loteriaId: true,
          ventana: {
            select: {
              commissionPolicyJson: true,
              banca: {
                select: {
                  commissionPolicyJson: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (jugadas.length === 0) {
    return {
      totalVentanaCommission: 0,
      extrasByVentana: new Map<string, number>(),
      extrasByLoteria: new Map<string, number>(),
    };
  }

  const ventanaIds = Array.from(
    new Set(
      jugadas
        .map((j) => j.ticket?.ventanaId)
        .filter((id): id is string => typeof id === "string")
    )
  );

  const ventanaUsers = ventanaIds.length
    ? await prisma.user.findMany({
      where: {
        role: Role.VENTANA,
        isActive: true,
        deletedAt: null,
        ventanaId: { in: ventanaIds },
      },
      select: {
        id: true,
        ventanaId: true,
        commissionPolicyJson: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    })
    : [];

  const userPolicyByVentana = new Map<string, any>();
  const ventanaUserIdByVentana = new Map<string, string>();
  for (const user of ventanaUsers) {
    if (!user.ventanaId) continue;
    if (!userPolicyByVentana.has(user.ventanaId)) {
      userPolicyByVentana.set(user.ventanaId, user.commissionPolicyJson ?? null);
      ventanaUserIdByVentana.set(user.ventanaId, user.id);
    }
  }

  const extrasByVentana = new Map<string, number>();
  const extrasByLoteria = new Map<string, number>();
  let totalVentanaCommission = 0;

  for (const jugada of jugadas) {
    const ticket = jugada.ticket;
    if (!ticket?.ventanaId) continue;

    const userPolicyJson = userPolicyByVentana.get(ticket.ventanaId) ?? null;
    const ventanaUserId = ventanaUserIdByVentana.get(ticket.ventanaId) ?? "";
    const ventanaPolicy = (ticket.ventana?.commissionPolicyJson as any) ?? null;
    const bancaPolicy = (ticket.ventana?.banca?.commissionPolicyJson as any) ?? null;

    let ventanaAmount = 0;

    if (userPolicyJson) {
      try {
        const policy = commissionResolver.parsePolicy(userPolicyJson, "USER");
        const resolution = commissionResolver.resolveFromPolicy(policy, {
          userId: ventanaUserId,
          loteriaId: ticket.loteriaId,
          betType: jugada.type as BetType,
          finalMultiplierX: jugada.finalMultiplierX ?? undefined,
        });
        ventanaAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
      } catch (err) {
        const fallback = commissionResolver.resolveVendedorCommission(
          {
            loteriaId: ticket.loteriaId,
            betType: jugada.type as BetType,
            finalMultiplierX: jugada.finalMultiplierX || 0,
            amount: jugada.amount,
          },
          null,
          ventanaPolicy,
          bancaPolicy
        );
        ventanaAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
      }
    } else {
      const fallback = commissionResolver.resolveVendedorCommission(
        {
          loteriaId: ticket.loteriaId,
          betType: jugada.type as BetType,
          finalMultiplierX: jugada.finalMultiplierX || 0,
          amount: jugada.amount,
        },
        null,
        ventanaPolicy,
        bancaPolicy
      );
      ventanaAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
    }

    if (ventanaAmount <= 0) continue;

    totalVentanaCommission += ventanaAmount;
    extrasByVentana.set(ticket.ventanaId, (extrasByVentana.get(ticket.ventanaId) || 0) + ventanaAmount);

    if (ticket.loteriaId) {
      extrasByLoteria.set(ticket.loteriaId, (extrasByLoteria.get(ticket.loteriaId) || 0) + ventanaAmount);
    }
  }

  return {
    totalVentanaCommission,
    extrasByVentana,
    extrasByLoteria,
  };
}

export const DashboardService = {
  /**
   * Calcula ganancia: Sum de comisiones + premium retenido
   * Incluye desglose completo por ventana y lotería
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async calculateGanancia(filters: DashboardFilters, role?: Role): Promise<GananciaResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);

    let byVentanaResult: Array<{
      ventana_id: string;
      ventana_name: string;
      is_active: boolean;
      total_sales: number;
      total_payouts: number;
      total_tickets: number;
      winning_tickets: number;
      commission_user: number;
      commission_ventana: number;
    }> = [];

    // Siempre consultar desde AccountStatement (fase I optimización)
    const statements = await prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          v.id AS ventana_id,
          v.name AS ventana_name,
          v."isActive" AS is_active,
          COALESCE(SUM(a."totalSales"), 0) AS total_sales,
          COALESCE(SUM(a."totalPayouts"), 0) AS total_payouts,
          COALESCE(SUM(a."ticketCount"), 0) AS total_tickets,
          COALESCE(SUM(a."vendedorCommission"), 0) AS commission_user,
          COALESCE(SUM(a."listeroCommission"), 0) AS commission_ventana
        FROM "Ventana" v
        LEFT JOIN "AccountStatement" a ON a."ventanaId" = v.id 
          AND a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          AND a."vendedorId" IS NULL
        WHERE v."isActive" = true
            ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
          GROUP BY v.id, v.name, v."isActive"
          ORDER BY total_sales DESC
        `
      );

      // ⚡ OPTIMIZACIÓN: Contar ganadores con SQL crudo para forzar uso del índice parcial idx_ticket_winner_status_date
      const winnerCountRows = await prisma.$queryRaw<Array<{ ventana_id: string; count: number }>>(
        Prisma.sql`
          SELECT "ventanaId" AS ventana_id, COUNT(*)::int AS count
          FROM "Ticket"
          WHERE "isWinner" = true
            AND "deletedAt" IS NULL
            AND "isActive" = true
            AND "businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND "bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY "ventanaId"
        `
      );

      const winnersMap = new Map<string, number>();
      for (const w of winnerCountRows) {
        if (w.ventana_id) {
          winnersMap.set(w.ventana_id, Number(w.count) || 0);
        }
      }

      byVentanaResult = statements.map(st => ({
        ventana_id: st.ventana_id,
        ventana_name: st.ventana_name,
        is_active: st.is_active,
        total_sales: Number(st.total_sales) || 0,
        total_payouts: Number(st.total_payouts) || 0,
        total_tickets: Number(st.total_tickets) || 0,
        winning_tickets: winnersMap.get(st.ventana_id) || 0,
        commission_user: Number(st.commission_user) || 0,
        commission_ventana: Number(st.commission_ventana) || 0
      }));

    let byLoteriaResult = await prisma.$queryRaw<any[]>(
        Prisma.sql`
          SELECT
            l.id AS loteria_id,
            l.name AS loteria_name,
            l."isActive" AS is_active,
            COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
            COALESCE(SUM(t."totalPayout"), 0) AS total_payouts,
            COUNT(t.id) AS total_tickets,
            COUNT(CASE WHEN t."isWinner" = true THEN 1 END) AS winning_tickets,
            COALESCE(SUM(t."totalCommission"), 0) AS commission_user,
            COALESCE(SUM(t."totalListeroCommission"), 0) AS commission_ventana
          FROM "Loteria" l
          LEFT JOIN "Ticket" t ON t."loteriaId" = l.id
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          WHERE l."isActive" = true
          GROUP BY l.id, l.name, l."isActive"
          ORDER BY total_sales DESC
        `
      );

    //  NUEVO: Obtener pagos y cobros del periodo para calcular periodBalance
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const paymentsWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      isReversed: false,
      ventanaId: { not: null },
    };

    if (filters.ventanaId) {
      paymentsWhere.ventanaId = filters.ventanaId;
    }
    if (filters.bancaId) {
      paymentsWhere.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const payments = await prisma.accountPayment.findMany({
      where: paymentsWhere,
      select: {
        ventanaId: true,
        type: true,
        amount: true,
      },
    });

    // Agrupar pagos y cobros por ventana
    const paymentsByVentana = new Map<string, { paid: number; collected: number }>();
    for (const payment of payments) {
      if (!payment.ventanaId) continue;

      const existing = paymentsByVentana.get(payment.ventanaId) || { paid: 0, collected: 0 };
      if (payment.type === 'payment') {
        existing.paid += payment.amount;
      } else if (payment.type === 'collection') {
        existing.collected += payment.amount;
      }
      paymentsByVentana.set(payment.ventanaId, existing);
    }

    const totalSales = byVentanaResult.reduce((sum, v) => sum + Number(v.total_sales || 0), 0);
    const totalPayouts = byVentanaResult.reduce((sum, v) => sum + Number(v.total_payouts || 0), 0);
    const commissionUserTotal = byVentanaResult.reduce((sum, v) => sum + Number(v.commission_user || 0), 0);
    //  CAMBIO: Usar SOLO snapshot del SQL (listeroCommissionAmount), NO recalculado desde políticas
    const commissionVentanaTotal = byVentanaResult.reduce((sum, v) => sum + Number(v.commission_ventana || 0), 0);
    const totalAmount = commissionUserTotal + commissionVentanaTotal;

    //  CRÍTICO: Ganancia Global SIEMPRE usa commissionVentanaTotal (comisión del listero)
    // Según especificaciones del cliente: la Ganancia Global de la Banca se calcula
    // restando las comisiones de los listeros (ventanas), NO las comisiones de usuarios
    const totalNet = totalSales - totalPayouts - commissionVentanaTotal;
    const margin = totalSales > 0 ? (totalNet / totalSales) * 100 : 0;

    return {
      totalAmount,
      totalSales,
      totalPayouts,
      totalNet,
      margin: parseFloat(margin.toFixed(2)),
      commissionUserTotal,
      commissionVentanaTotal,
      byVentana: byVentanaResult.map((row) => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.total_payouts) || 0;
        const tickets = Number(row.total_tickets) || 0;
        const winners = Number(row.winning_tickets) || 0;
        const commissionUser = Number(row.commission_user) || 0;
        //  CAMBIO: Usar SOLO snapshot del SQL (row.commission_ventana = SUM(listeroCommissionAmount))
        const commissionVentana = Number(row.commission_ventana) || 0;
        const commissions = commissionUser + commissionVentana;
        //  CRÍTICO: byVentana[].net SIEMPRE usa commissionVentana (comisión del listero)
        // Según especificaciones del cliente: el desglose por ventanas debe usar
        // las comisiones de los listeros, NO las comisiones de usuarios
        const net = sales - payout - commissionVentana;
        const ventanaMargin = sales > 0 ? (net / sales) * 100 : 0;
        const winRate = tickets > 0 ? (winners / tickets) * 100 : 0;

        //  NUEVO: Calcular periodBalance (saldo del periodo filtrado)
        // periodBalance = sales - payout - commissionVentana - paid + collected
        const paymentsInfo = paymentsByVentana.get(row.ventana_id) || { paid: 0, collected: 0 };
        const periodBalance = sales - payout - commissionVentana - paymentsInfo.collected + paymentsInfo.paid;

        return {
          ventanaId: row.ventana_id,
          ventanaName: row.ventana_name,
          sales,
          amount: commissions,
          commissions,
          commissionUser,
          commissionVentana,
          payout,
          net,
          margin: parseFloat(ventanaMargin.toFixed(2)),
          tickets,
          winners,
          winRate: parseFloat(winRate.toFixed(2)),
          isActive: row.is_active,
          periodBalance: parseFloat(periodBalance.toFixed(2)), //  NUEVO: Saldo del periodo
        };
      }),
      byLoteria: byLoteriaResult.map((row) => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.total_payouts) || 0;
        const tickets = Number(row.total_tickets) || 0;
        const winners = Number(row.winning_tickets) || 0;
        const commissionUser = Number(row.commission_user) || 0;
        //  CAMBIO: Usar SOLO snapshot del SQL (row.commission_ventana = SUM(listeroCommissionAmount))
        const commissionVentana = Number(row.commission_ventana) || 0;
        const commissions = commissionUser + commissionVentana;
        // Calcular ganancia neta: Banca viendo loterías siempre resta solo commissionVentana
        const net = sales - payout - commissionVentana;
        const loteriaMargin = sales > 0 ? (net / sales) * 100 : 0;

        return {
          loteriaId: row.loteria_id,
          loteriaName: row.loteria_name,
          sales,
          amount: commissions,
          commissions,
          commissionUser,
          commissionVentana,
          payout,
          net,
          margin: parseFloat(loteriaMargin.toFixed(2)),
          tickets,
          winners,
          isActive: row.is_active,
        };
      }),
    };
  },

  /**
   * Calcula CxC: Monto que ventana debe al banco por premios no pagados
   * CxC = Total de ventas - Total de premios pagados
   */
  async calculateCxC(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    const dimension = filters.cxcDimension || 'ventana';

    if (dimension === 'vendedor') {
      return this.calculateCxCByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);
    const skipExclusion = await isExclusionListEmpty();
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
    const jugadaExclusionFilter = skipExclusion ? Prisma.empty : Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId" AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId") AND sle.multiplier_id = j."multiplierId"
        )`;

    // SQL consolidada para evitar picos de memoria y múltiples round-trips
    const ventanaData = await prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "ventanaId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL
        GROUP BY "ventanaId"
      ),
      collections_agg AS (
        SELECT "ventanaId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "ventanaId"
      ),
      ticket_payments_agg AS (
        SELECT t."ventanaId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL
        GROUP BY t."ventanaId"
      )
      SELECT v.id AS ventana_id, v.name AS ventana_name, v."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "Ventana" v
      LEFT JOIN account_agg aa ON aa."ventanaId" = v.id
      LEFT JOIN collections_agg ca ON ca."ventanaId" = v.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."ventanaId" = v.id
      WHERE v."isActive" = true
      ${filters.ventanaId ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
      ORDER BY total_sales DESC
    `);

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVentanaIds = ventanaData.map(v => v.ventana_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "ventana", allVentanaIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIds,
        filters.bancaId
      )
    ]);

    const byVentana = ventanaData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.ventana_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      // Saldo acumulado real (Saldo a Hoy)
      const accumulatedBalance = accumulatedBalances.get(v.ventana_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        // amount se usa para el total del dashboard y la alerta
        // Para una alerta de CxC, usamos el saldo acumulado real si es positivo
        amount: accumulatedBalance > 0 ? accumulatedBalance : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVentana.reduce((sum, v) => sum + v.amount, 0), 
      byVentana 
    };
  },

  /**
   * Calcula CxC agrupado por vendedor
   * Similar a calculateCxC pero agrupa por vendedorId en lugar de ventanaId
   */
  async calculateCxCByVendedor(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);
    const skipExclusion = await isExclusionListEmpty();
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
    const jugadaExclusionFilter = skipExclusion ? Prisma.empty : Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId" AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId") AND sle.multiplier_id = j."multiplierId"
        )`;

    const vendedorData = await prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "vendedorId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL
        GROUP BY "vendedorId"
      ),
      collections_agg AS (
        SELECT "vendedorId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "vendedorId"
      ),
      ticket_payments_agg AS (
        SELECT t."vendedorId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL AND t."vendedorId" IS NOT NULL
        GROUP BY t."vendedorId"
      )
      SELECT u.id AS vendedor_id, u.name AS vendedor_name, u.code AS vendedor_code, 
             u."ventanaId" AS ventana_id, v.name AS ventana_name, u."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "User" u
      LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
      LEFT JOIN account_agg aa ON aa."vendedorId" = u.id
      LEFT JOIN collections_agg ca ON ca."vendedorId" = u.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."vendedorId" = u.id
      WHERE u."isActive" = true AND u.role = 'VENDEDOR'
      ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
    `);

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVendedorIds = vendedorData.map(v => v.vendedor_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "vendedor", allVendedorIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIds,
        filters.bancaId
      )
    ]);

    const byVendedor = vendedorData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.vendedor_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      // Saldo acumulado real (Saldo a Hoy)
      const accumulatedBalance = accumulatedBalances.get(v.vendedor_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        vendedorId: v.vendedor_id,
        vendedorName: v.vendedor_name,
        vendedorCode: v.vendedor_code,
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        // El amount se usa para el total del dashboard y alertas
        amount: accumulatedBalance > 0 ? accumulatedBalance : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVendedor.reduce((sum, v) => sum + v.amount, 0), 
      byVendedor 
    };
  },

  /**
   * Calcula CxP: Monto que banco debe a ventana por overpayment
   * CxP ocurre cuando ventana paga más de lo que vendió
   */
  async calculateCxP(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const dimension = filters.cxcDimension || 'ventana';

    if (dimension === 'vendedor') {
      return this.calculateCxPByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);
    const skipExclusion = await isExclusionListEmpty();
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
    const jugadaExclusionFilter = skipExclusion ? Prisma.empty : Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId" AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId") AND sle.multiplier_id = j."multiplierId"
        )`;

    // SQL consolidada para evitar picos de memoria y múltiples round-trips
    const ventanaData = await prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "ventanaId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL
        GROUP BY "ventanaId"
      ),
      collections_agg AS (
        SELECT "ventanaId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "ventanaId"
      ),
      ticket_payments_agg AS (
        SELECT t."ventanaId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL
        GROUP BY t."ventanaId"
      )
      SELECT v.id AS ventana_id, v.name AS ventana_name, v."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "Ventana" v
      LEFT JOIN account_agg aa ON aa."ventanaId" = v.id
      LEFT JOIN collections_agg ca ON ca."ventanaId" = v.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."ventanaId" = v.id
      WHERE v."isActive" = true
      ${filters.ventanaId ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
      ORDER BY total_sales DESC
    `);

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVentanaIds = ventanaData.map(v => v.ventana_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "ventana", allVentanaIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIds,
        filters.bancaId
      )
    ]);

    const byVentana = ventanaData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.ventana_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      // Saldo acumulado real (Saldo a Hoy)
      const accumulatedBalance = accumulatedBalances.get(v.ventana_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        totalPaidToVentana: 0,
        // CxP = Saldo a favor de la ventana (acumulado < 0)
        amount: accumulatedBalance < 0 ? Math.abs(accumulatedBalance) : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVentana.reduce((sum, v) => sum + v.amount, 0), 
      byVentana 
    };
  },

  /**
   * Calcula CxP agrupado por vendedor
   * Similar a calculateCxP pero agrupa por vendedorId en lugar de ventanaId
   */

  async calculateCxPByVendedor(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);
    const skipExclusion = await isExclusionListEmpty();
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
    const jugadaExclusionFilter = skipExclusion ? Prisma.empty : Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId" AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId") AND sle.multiplier_id = j."multiplierId"
        )`;

    const vendedorData = await prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "vendedorId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL
        GROUP BY "vendedorId"
      ),
      collections_agg AS (
        SELECT "vendedorId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "vendedorId"
      ),
      ticket_payments_agg AS (
        SELECT t."vendedorId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL AND t."vendedorId" IS NOT NULL
        GROUP BY t."vendedorId"
      )
      SELECT u.id AS vendedor_id, u.name AS vendedor_name, u.code AS vendedor_code, 
             u."ventanaId" AS ventana_id, v.name AS ventana_name, u."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "User" u
      LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
      LEFT JOIN account_agg aa ON aa."vendedorId" = u.id
      LEFT JOIN collections_agg ca ON ca."vendedorId" = u.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."vendedorId" = u.id
      WHERE u."isActive" = true AND u.role = 'VENDEDOR'
      ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
    `);

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVendedorIds = vendedorData.map(v => v.vendedor_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "vendedor", allVendedorIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIds,
        filters.bancaId
      )
    ]);

    const byVendedor = vendedorData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.vendedor_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      // Saldo acumulado real (Saldo a Hoy)
      const accumulatedBalance = accumulatedBalances.get(v.vendedor_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        vendedorId: v.vendedor_id,
        vendedorName: v.vendedor_name,
        vendedorCode: v.vendedor_code,
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        totalPaidToVentana: 0,
        // CxP = Saldo a favor del vendedor (acumulado < 0)
        amount: accumulatedBalance < 0 ? Math.abs(accumulatedBalance) : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVendedor.reduce((sum, v) => sum + v.amount, 0), 
      byVendedor 
    };
  },

  /**
   * Obtiene saldos acumulados mensuales (Saldo a Hoy) en lote para un conjunto de entidades.
   * Método optimizado para ser llamado por separado desde el frontend.
   */
  async getAccumulatedBalancesBatch(
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string
  ): Promise<Record<string, number>> {
    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);

    const balancesMap = await getMonthlyRemainingBalancesBatch(
      effectiveMonth,
      dimension,
      entityIds,
      bancaId
    );

    const result: Record<string, number> = {};
    balancesMap.forEach((balance, id) => {
      result[id] = balance;
    });

    return result;
  },

  /**
   * Resumen general: totales de ventas, pagos, comisiones
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async getSummary(filters: DashboardFilters, role?: Role): Promise<DashboardSummary> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = toDateStr >= todayCRStr;
    const ttlSeconds = isToday ? 15 : 3600; // 15s para live de hoy, 1 hora para histórico
    const cacheKey = `dashboard:summary:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${fromDateStr}:${toDateStr}:${role || 'all'}`;

    return ReportCache.getOrCompute(cacheKey, ttlSeconds, async () => {
      let summary: {
        total_sales: number;
        total_payouts: number;
        total_tickets: number;
        winning_tickets: number;
        commission_user: number;
        commission_ventana: number;
      };

      // ⚡ OPTIMIZACIÓN FASE I: Consultar desde AccountStatement
      const statementSummaryRows = await prisma.$queryRaw<any[]>(
        Prisma.sql`
          SELECT
            COALESCE(SUM(a."totalSales"), 0) as total_sales,
            COALESCE(SUM(a."totalPayouts"), 0) as total_payouts,
            COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
            COALESCE(SUM(a."vendedorCommission"), 0) as commission_user,
            COALESCE(SUM(a."listeroCommission"), 0) as commission_ventana
          FROM "AccountStatement" a
          WHERE a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND a."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
            ${(!filters.ventanaId && !filters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
        `
      );

      // ⚡ OPTIMIZACIÓN: Contar ganadores con SQL crudo para forzar uso del índice parcial idx_ticket_winner_status_date
      const winningCountRows = await prisma.$queryRaw<Array<{ count: number }>>(
        Prisma.sql`
          SELECT COUNT(*)::int AS count
          FROM "Ticket"
          WHERE "isWinner" = true
            AND "deletedAt" IS NULL
            AND "isActive" = true
            AND "businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND "bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        `
      );
      const winningCount = Number(winningCountRows[0]?.count) || 0;

      const row = statementSummaryRows[0] || {
        total_sales: 0,
        total_payouts: 0,
        total_tickets: 0,
        commission_user: 0,
        commission_ventana: 0,
      };

      summary = {
        total_sales: Number(row.total_sales) || 0,
        total_payouts: Number(row.total_payouts) || 0,
        total_tickets: Number(row.total_tickets) || 0,
        winning_tickets: winningCount,
        commission_user: Number(row.commission_user) || 0,
        commission_ventana: Number(row.commission_ventana) || 0,
      };

      const totalSales = summary.total_sales;
      const totalPayouts = Number(summary.total_payouts) || 0;
      const totalTickets = Number(summary.total_tickets) || 0;
      const winningTickets = Number(summary.winning_tickets) || 0;
      const commissionUser = Number(summary.commission_user) || 0;
      const commissionVentana = Number(summary.commission_ventana) || 0;
      const totalCommissions = commissionUser + commissionVentana;
      const net = role === Role.ADMIN
        ? totalSales - totalPayouts - commissionVentana
        : totalSales - totalPayouts - commissionUser;
      const margin = totalSales > 0 ? (net / totalSales) * 100 : 0;
      const winRate = totalTickets > 0 ? (winningTickets / totalTickets) * 100 : 0;

      const gananciaListeros = commissionVentana - commissionUser;
      const gananciaBanca = net;

      return {
        totalSales,
        totalPayouts,
        totalCommissions,
        commissionUser,
        commissionVentana,
        commissionVentanaTotal: commissionVentana,
        gananciaListeros,
        gananciaBanca,
        totalTickets,
        winningTickets,
        net,
        margin: parseFloat(margin.toFixed(2)),
        winRate: parseFloat(winRate.toFixed(2)),
      };
    });
  },

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async getFullDashboard(filters: DashboardFilters, role?: Role) {
    const fromDateStr = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = toDateStr >= todayCRStr;
    const ttl = isToday ? 15 : 300; // 15s para live (cutoff), 5 min para histórico
    const cacheKey = `dashboard:full:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${filters.loteriaId || 'all'}:${filters.scope || 'all'}:${filters.dimension || 'all'}:${filters.interval || 'day'}:${fromDateStr}:${toDateStr}:${role || 'all'}`;

    return ReportCache.getOrCompute(
      cacheKey,
      ttl,
      async () => {
        // 🔴 INICIO: Capturar estado inicial
        const monitor = new PerformanceMonitor('dashboard.getFullDashboard');
        monitor.start('INIT');

        const startTime = Date.now();
        let queryCount = 0;

        // 🟡 CHECKPOINT: Antes de Promise.all
        monitor.checkpoint('BEFORE_PARALLEL_QUERIES');

        // ⚡ OPTIMIZACIÓN: Para rangos > 7 días, la exposición de riesgo solo es accionable
        // para los sorteos OPEN del día actual. Limitar calculateExposure a hoy evita
        // el scan de 30 días de tickets históricos (query más lenta: ~8.6 s media).
        const rangeMs = filters.toDate.getTime() - filters.fromDate.getTime();
        const LARGE_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
        const isLargeRange = rangeMs > LARGE_RANGE_MS;
        let exposureTrimmed = false;
        let exposureFilters: DashboardFilters = filters;
        if (isLargeRange) {
          const todayRange = resolveDateRange('today');
          exposureFilters = {
            ...filters,
            fromDate: todayRange.fromAt,
            toDate: todayRange.toAt,
          };
          exposureTrimmed = true;
        }

        // FASE 1: Datos críticos (los que el usuario ve primero)
        //  SEMI-OPTIMIZADO: Comentamos CxC y CxP por desuso y riesgos de performance en Prisma (intermitencia)
        //  REFATOR: Ejecución secuencial para proteger el pool de conexiones (límite 15)
        const mGanancia = await measureAsync('calculateGanancia', () => this.calculateGanancia(filters, role).then((r) => {
          queryCount += 2;
          return r;
        }));
        /* const mCxC = await measureAsync('calculateCxC', () => this.calculateCxC(filters).then((r) => {
          queryCount += 1;
          return r;
        }));
        const mCxP = await measureAsync('calculateCxP', () => this.calculateCxP(filters).then((r) => {
          queryCount += 1;
          return r;
        })); */
        const mSummary = await measureAsync('getSummary', () => this.getSummary(filters, role).then((r) => {
          queryCount += 1;
          return r;
        }));
        const measuredPhase1 = [mGanancia, mSummary];

        // FASE 2: Datos complementarios (gráficas, comparativas)
        const mTimeSeries = await measureAsync('getTimeSeries', () => this.getTimeSeries({ ...filters, interval: filters.interval || 'day' }).then((r) => {
          queryCount += 1;
          return r;
        }));
        // ⚡ Pasar exposureFilters (puede ser rango trimmed a hoy si range > 7 días)
        const mExposure = await measureAsync('calculateExposure', () => this.calculateExposure(exposureFilters).then((r) => {
          queryCount += 3;
          return r;
        }));
        const mPreviousPeriod = await measureAsync('calculatePreviousPeriod', () => this.calculatePreviousPeriod(filters, role).then((r) => {
          queryCount += 1;
          return r;
        }));
        const measuredPhase2 = [mTimeSeries, mExposure, mPreviousPeriod];

        const measured = [...measuredPhase1, ...measuredPhase2];

        // Extraer resultados directamente (tipado correcto en TS)
        const ganancia = mGanancia.result;
        const summary = mSummary.result;
        
        // Valores dummy para CxC/CxP (comentados por performance)
        const cxc = { totalAmount: 0, byVentana: [] };
        const cxp = { totalAmount: 0, byVentana: [] };

        const timeSeries = mTimeSeries.result;
        const exposure = mExposure.result;
        const previousPeriod = mPreviousPeriod.result;

        // 🟡 CHECKPOINT: Después de queries, antes de alerts
        monitor.checkpoint('AFTER_PARALLEL_QUERIES');

        // Log individual de tiempos y memoria por operación
        logger.info({
          layer: 'performance',
          action: 'DASHBOARD_OPERATIONS_BREAKDOWN',
          meta: {
            operations: measured.map(({ durationMs, memoryDeltaMB }, idx) => ({
              name: ['ganancia', 'summary', 'timeSeries', 'exposure', 'previousPeriod'][idx],
              durationMs,
              memoryDeltaMB: parseFloat(memoryDeltaMB.toFixed(2)),
            })),
          },
        });

        const alerts = this.generateAlerts({ ganancia, cxc, cxp, summary, exposure });

        // 🟡 CHECKPOINT: Antes de construir respuesta
        monitor.checkpoint('BEFORE_RESPONSE_BUILD');

        const response = {
          ganancia,
          cxc,
          cxp,
          summary,
          timeSeries: (timeSeries as any).timeSeries,
          exposure,
          previousPeriod,
          alerts,
          meta: {
            range: {
              fromAt: filters.fromDate.toISOString(),
              toAt: filters.toDate.toISOString(),
              tz: 'America/Costa_Rica',
            },
            // ⚡ Si el rango era > 7 días, la exposición es solo del día actual
            exposureTrimmedToToday: exposureTrimmed,
            scope: filters.scope || 'all',
            generatedAt: new Date().toISOString(),
            queryExecutionTime: Date.now() - startTime,
            totalQueries: queryCount,
          },
        };

        // 🔴 FIN: Capturar estado final y generar resumen
        const performanceSummary = monitor.end('RESPONSE_READY');

        // Agregar métricas al meta del response (útil para debugging en dev)
        if (process.env.NODE_ENV !== 'production') {
          (response.meta as any).performance = {
            totalTimeMs: performanceSummary.totalTimeMs,
            peakHeapUsedMB: parseFloat(performanceSummary.peakHeapUsedMB.toFixed(2)),
            heapGrowthMB: parseFloat(performanceSummary.heapGrowthMB.toFixed(2)),
          };
        }

        return response;
      }
    );
  },

  /**
   * Serie temporal: datos agrupados por día u hora para gráficos
   */
  async getTimeSeries(filters: DashboardFilters) {
    const interval = filters.interval || 'day';
    const granularity = interval; // Usar interval como granularity para formateo de labels

    // Validación: interval=hour solo si rango <= 7 días
    if (interval === 'hour') {
      const diffDays = Math.ceil((filters.toDate.getTime() - filters.fromDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) {
        throw new AppError('interval=hour solo permitido para rangos <= 7 días', 422);
      }
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isHistorical = toDateStr < todayCRStr && interval !== 'hour';
    const skipExclusion = await isExclusionListEmpty();

    let result: Array<{
      date_bucket: Date;
      total_sales: number;
      total_commissions: number;
      total_tickets: number;
      total_payout: number;
      total_winners: number;
    }> = [];

    if (isHistorical) {
      // ⚡ OPTIMIZACIÓN FASE I: Consultar desde AccountStatement para rangos pasados
      let selectClause = Prisma.sql`a.date`;
      let groupByClause = Prisma.sql`a.date`;
      if (interval === 'week') {
        selectClause = Prisma.sql`DATE_TRUNC('week', a.date)`;
        groupByClause = selectClause;
      } else if (interval === 'month') {
        selectClause = Prisma.sql`DATE_TRUNC('month', a.date)`;
        groupByClause = selectClause;
      }

      result = await prisma.$queryRaw<any[]>(
        Prisma.sql`
          SELECT
            ${selectClause} as date_bucket,
            COALESCE(SUM(a."totalSales"), 0) as total_sales,
            COALESCE(SUM(a."vendedorCommission" + a."listeroCommission"), 0) as total_commissions,
            COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
            COALESCE(SUM(a."totalPayouts"), 0) as total_payout,
            0 as total_winners
          FROM "AccountStatement" a
          WHERE a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND a."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
            ${(!filters.ventanaId && !filters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
          GROUP BY ${groupByClause}
          ORDER BY date_bucket ASC
        `
      );
    } else {
      // Consulta en tiempo real (involucra hoy o es por hora)
      const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
      const dateFormat =
        interval === 'day' || interval === 'week' || interval === 'month'
          ? Prisma.sql`COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )`
          : Prisma.sql`DATE_TRUNC(
              'hour',
              (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
            )`;

      let groupByClause = Prisma.sql`date_bucket`;
      let selectClause = dateFormat;
      if (interval === 'week') {
        selectClause = Prisma.sql`
          DATE_TRUNC('week', 
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )
          )
        `;
        groupByClause = selectClause;
      } else if (interval === 'month') {
        selectClause = Prisma.sql`
          DATE_TRUNC('month', 
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )
          )
        `;
        groupByClause = selectClause;
      }

      result = await prisma.$queryRaw<any[]>(
        Prisma.sql`
          SELECT
            ${selectClause} as date_bucket,
            COALESCE(SUM(t."totalAmount"), 0) as total_sales,
            COALESCE(SUM(t."totalCommission"), 0) as total_commissions,
            COUNT(DISTINCT t.id) as total_tickets,
            COALESCE(SUM(t."totalPayout"), 0) as total_payout,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as total_winners
          FROM "Ticket" t
          WHERE ${baseFilters}
          GROUP BY ${groupByClause}
          ORDER BY date_bucket ASC
        `
      );
    }

    // Calcular período anterior si compare=true
    let comparisonData: Array<{
      date: string;
      timestamp: string;
      label: string;
      sales: number;
      commissions: number;
      tickets: number;
      payout: number;
      winners: number;
    }> = [];

    if (filters.compare) {
      const previousPeriod = calculatePreviousPeriod(filters.fromDate, filters.toDate);
      const previousFilters = {
        ...filters,
        fromDate: previousPeriod.fromDate,
        toDate: previousPeriod.toDate,
        compare: false, // Evitar recursión infinita
      };
      const { fromDateStr: prevFromDateStr, toDateStr: prevToDateStr } = getBusinessDateRangeStrings(previousFilters);
      const isPrevHistorical = prevToDateStr < todayCRStr && interval !== 'hour';

      let prevResult: Array<{
        date_bucket: Date;
        total_sales: number;
        total_commissions: number;
        total_tickets: number;
        total_payout: number;
        total_winners: number;
      }> = [];

      if (isPrevHistorical) {
        let selectClause = Prisma.sql`a.date`;
        let groupByClause = Prisma.sql`a.date`;
        if (interval === 'week') {
          selectClause = Prisma.sql`DATE_TRUNC('week', a.date)`;
          groupByClause = selectClause;
        } else if (interval === 'month') {
          selectClause = Prisma.sql`DATE_TRUNC('month', a.date)`;
          groupByClause = selectClause;
        }

        prevResult = await prisma.$queryRaw<any[]>(
          Prisma.sql`
            SELECT
              ${selectClause} as date_bucket,
              COALESCE(SUM(a."totalSales"), 0) as total_sales,
              COALESCE(SUM(a."vendedorCommission" + a."listeroCommission"), 0) as total_commissions,
              COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
              COALESCE(SUM(a."totalPayouts"), 0) as total_payout,
              0 as total_winners
            FROM "AccountStatement" a
            WHERE a.date BETWEEN ${prevFromDateStr}::date AND ${prevToDateStr}::date
              ${previousFilters.bancaId ? Prisma.sql`AND a."bancaId" = ${previousFilters.bancaId}::uuid` : Prisma.empty}
              ${previousFilters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${previousFilters.ventanaId}::uuid` : Prisma.empty}
              ${previousFilters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${previousFilters.vendedorId}::uuid` : Prisma.empty}
              ${(!previousFilters.ventanaId && !previousFilters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
            GROUP BY ${groupByClause}
            ORDER BY date_bucket ASC
          `
        );
      } else {
        const prevBaseFilters = buildTicketBaseFilters("t", previousFilters, prevFromDateStr, prevToDateStr, skipExclusion);
        let groupByClause = Prisma.sql`date_bucket`;
        let selectClause = interval === 'day' || interval === 'week' || interval === 'month'
          ? Prisma.sql`COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )`
          : Prisma.sql`DATE_TRUNC(
              'hour',
              (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
            )`;

        if (interval === 'week') {
          selectClause = Prisma.sql`
            DATE_TRUNC('week', 
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              )
            )
          `;
          groupByClause = selectClause;
        } else if (interval === 'month') {
          selectClause = Prisma.sql`
            DATE_TRUNC('month', 
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              )
            )
          `;
          groupByClause = selectClause;
        }

        prevResult = await prisma.$queryRaw<any[]>(
          Prisma.sql`
            SELECT
              ${selectClause} as date_bucket,
              COALESCE(SUM(t."totalAmount"), 0) as total_sales,
              COALESCE(SUM(t."totalCommission"), 0) as total_commissions,
              COUNT(DISTINCT t.id) as total_tickets,
              COALESCE(SUM(t."totalPayout"), 0) as total_payout,
              COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as total_winners
            FROM "Ticket" t
            WHERE ${prevBaseFilters}
            GROUP BY ${groupByClause}
            ORDER BY date_bucket ASC
          `
        );
      }

      comparisonData = prevResult.map(row => {
        const timestamp = formatCostaRicaISO(row.date_bucket);
        const date = formatCostaRicaDate(row.date_bucket);
        const label = formatTimeSeriesLabel(row.date_bucket, granularity);

        return {
          date,
          timestamp,
          label,
          sales: Number(row.total_sales) || 0,
          commissions: Number(row.total_commissions) || 0,
          tickets: Number(row.total_tickets) || 0,
          payout: Number(row.total_payout) || 0,
          winners: Number(row.total_winners) || 0,
        };
      });
    }

    return {
      timeSeries: result.map(row => {
        // Formatear timestamp con offset de Costa Rica (-06:00)
        const timestamp = formatCostaRicaISO(row.date_bucket);
        // Formatear date como YYYY-MM-DD en zona horaria de Costa Rica
        const date = formatCostaRicaDate(row.date_bucket);
        // Formatear label según granularity
        const label = formatTimeSeriesLabel(row.date_bucket, granularity);

        return {
          date, // YYYY-MM-DD (fecha en CR)
          timestamp, // YYYY-MM-DDTHH:mm:ss-06:00 (timestamp en CR)
          label, //  NUEVO: Etiqueta formateada según granularity
          sales: Number(row.total_sales) || 0,
          commissions: Number(row.total_commissions) || 0,
          tickets: Number(row.total_tickets) || 0,
          payout: Number(row.total_payout) || 0,
          winners: Number(row.total_winners) || 0,
        };
      }),
      comparison: filters.compare ? comparisonData : undefined, //  NUEVO: Datos del período anterior
      meta: {
        interval,
        granularity, //  NUEVO: Incluir granularity en meta
        timezone: 'America/Costa_Rica', //  Indicar zona horaria usada
        dataPoints: result.length,
        comparisonDataPoints: filters.compare ? comparisonData.length : 0,
      },
    };
  },

  /**
   * Exposición: análisis de riesgo por número y lotería
   */
  async calculateExposure(filters: DashboardFilters) {
    const topLimit = filters.top || 10;

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const skipExclusion = await isExclusionListEmpty();
    //  NUEVO: Incluir todos los sorteos (OPEN, EVALUATED, CLOSED)
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion, true);

    // 1. Top Numbers: Actual payout (si evaluado) + Potential risk (si abierto)
    const topNumbers = await prisma.$queryRaw<
      Array<{
        number: string;
        bet_type: string;
        total_sales: number;
        potential_payout: number;
        ticket_count: bigint;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT t.id, t."sorteoId"
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
          WHERE ${baseFilters} AND s.status = 'OPEN'
        ),
        jugadas_stats AS (
          SELECT
            j."ticketId",
            j.number,
            j.type,
            j.amount,
            j."finalMultiplierX",
            j.payout,
            tir."sorteoId"
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
            ${filters.betType ? Prisma.sql`AND j.type = ${filters.betType}` : Prisma.empty}
        )
        SELECT
          j.number,
          j.type as bet_type,
          COALESCE(SUM(j.amount), 0) as total_sales,
          COALESCE(SUM(j.amount * j."finalMultiplierX"), 0) as potential_payout,
          COUNT(DISTINCT j."ticketId") as ticket_count
        FROM jugadas_stats j
        JOIN "Sorteo" s ON s.id = j."sorteoId"
        -- SIEMPRE filtramos solo OPEN para el top de riesgo activo
        WHERE s.status = 'OPEN'
        GROUP BY j.number, j.type
        ORDER BY total_sales DESC
        LIMIT ${topLimit}
      `
    );

    // 2. Heatmap: Ventas acumuladas de sorteos OPEN
    const heatmap = await prisma.$queryRaw<
      Array<{
        number: string;
        total_sales: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT t.id, t."sorteoId"
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
          WHERE ${baseFilters} AND s.status = 'OPEN'
        ),
        jugadas_in_range AS (
          SELECT
            tir."sorteoId",
            j.number,
            j.amount
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
        )
        SELECT
          j.number,
          COALESCE(SUM(j.amount), 0) as total_sales
        FROM jugadas_in_range j
        JOIN "Sorteo" s ON s.id = j."sorteoId"
        -- SIEMPRE filtramos solo OPEN para el mapa de calor de riesgo
        WHERE s.status = 'OPEN'
        GROUP BY j.number
        ORDER BY j.number ASC
      `
    );

    // 3. By Loteria: Solo sorteos OPEN — riesgo activo pendiente de resolución
    const byLoteriaResult = await prisma.$queryRaw<
      Array<{
        loteria_id: string;
        loteria_name: string;
        total_sales: number;
        potential_payout: number;
        status: string;
        critical_number: string | null;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT t.id, t."loteriaId", t."sorteoId"
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
          WHERE ${baseFilters} AND s.status = 'OPEN'
        ),
        jugadas_stats AS (
          SELECT
            tir."loteriaId",
            tir."sorteoId",
            j.number,
            SUM(j.amount) as sales,
            SUM(j.amount * j."finalMultiplierX") as potential_payout,
            SUM(j.payout) as actual_payout
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
          GROUP BY tir."loteriaId", tir."sorteoId", j.number
        ),
        sorteo_summary AS (
          SELECT
            "loteriaId",
            "sorteoId",
            SUM(sales) as total_sales,
            SUM(actual_payout) as total_actual_payout,
            MAX(potential_payout) as max_potential_payout,
            (ARRAY_AGG(number ORDER BY potential_payout DESC) FILTER (WHERE number IS NOT NULL))[1] as critical_number
          FROM jugadas_stats
          GROUP BY "loteriaId", "sorteoId"
        ),
        sorteo_risk AS (
          SELECT
            ss.*,
            s.status,
            ss.max_potential_payout as risk_amount
          FROM sorteo_summary ss
          JOIN "Sorteo" s ON s.id = ss."sorteoId"
          -- SIEMPRE filtramos solo OPEN: exposición activa pendiente de resolución
          WHERE s.status = 'OPEN'
        )
        SELECT
          l.id as loteria_id,
          l.name as loteria_name,
          COALESCE(SUM(sr.total_sales), 0) as total_sales,
          COALESCE(SUM(sr.risk_amount), 0) as potential_payout,
          'ABIERTO' as status,
          (ARRAY_AGG(sr.critical_number ORDER BY sr.risk_amount DESC) FILTER (WHERE sr.critical_number IS NOT NULL))[1] as critical_number
        FROM "Loteria" l
        INNER JOIN sorteo_risk sr ON sr."loteriaId" = l.id
        WHERE l."isActive" = true
          AND sr.total_sales > 0
        GROUP BY l.id, l.name
        ORDER BY total_sales DESC
      `
    );

    // 4. By Sorteo: Detalle granular por sorteo
    const bySorteoResult = await prisma.$queryRaw<
      Array<{
        sorteo_id: string;
        sorteo_name: string;
        loteria_name: string;
        draw_time: Date;
        status: string;
        sales: number;
        potential_payout: number;
        critical_number: string | null;
        top_numbers_json: string;
      }>
    >(
      Prisma.sql`
        -- ⚡ bySorteoResult: solo sorteos OPEN para riesgo activo.
        -- El JOIN interno a Sorteo filtra OPEN antes del scan de Ticket/Jugada.
        WITH open_sorteos AS (
          SELECT s.id, s.name, s."scheduledAt", s.status, s."loteriaId"
          FROM "Sorteo" s
          WHERE s.status = 'OPEN'
        ),
        tickets_in_range AS (
          SELECT t.id, t."loteriaId", t."sorteoId"
          FROM "Ticket" t
          INNER JOIN open_sorteos os ON os.id = t."sorteoId"
          WHERE ${baseFilters}
        ),
        jugadas_stats AS (
          SELECT
            tir."sorteoId",
            j.number,
            SUM(j.amount) as sales,
            SUM(j.amount * j."finalMultiplierX") as potential_payout,
            SUM(j.payout) as actual_payout
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
          GROUP BY tir."sorteoId", j.number
        ),
        sorteo_summary AS (
          SELECT
            "sorteoId",
            SUM(sales) as total_sales,
            SUM(actual_payout) as total_actual_payout,
            MAX(potential_payout) as max_potential_payout,
            (ARRAY_AGG(number ORDER BY potential_payout DESC) FILTER (WHERE number IS NOT NULL))[1] as critical_number
          FROM jugadas_stats
          GROUP BY "sorteoId"
        ),
        ranked_numbers AS (
          SELECT
            "sorteoId",
            number,
            sales,
            potential_payout as payout,
            ROW_NUMBER() OVER(PARTITION BY "sorteoId" ORDER BY sales DESC) as rn
          FROM jugadas_stats
        ),
        top_numbers_per_sorteo AS (
          SELECT
            "sorteoId",
            json_agg(
              json_build_object('number', number, 'sales', sales, 'payout', payout)
              ORDER BY sales DESC
            ) as top_numbers_json
          FROM ranked_numbers
          WHERE rn <= 5
          GROUP BY "sorteoId"
        )
        SELECT
          os.id as sorteo_id,
          os.name as sorteo_name,
          l.name as loteria_name,
          os."scheduledAt" as draw_time,
          os.status,
          ss.total_sales as sales,
          ss.max_potential_payout as potential_payout,
          ss.critical_number,
          t.top_numbers_json::text
        FROM sorteo_summary ss
        JOIN top_numbers_per_sorteo t ON t."sorteoId" = ss."sorteoId"
        JOIN open_sorteos os ON os.id = ss."sorteoId"
        JOIN "Loteria" l ON l.id = os."loteriaId"
        WHERE ss.total_sales > 0
        ${filters.status ? Prisma.sql`AND os.status = ${filters.status}` : Prisma.empty}
        ORDER BY (CASE WHEN ss.total_sales > 0 THEN ss.max_potential_payout / ss.total_sales ELSE 0 END) DESC
      `
    );

    return {
      topNumbers: topNumbers.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        const ticketCount = Number(row.ticket_count) || 0;
        return {
          number: row.number,
          betType: row.bet_type,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? parseFloat((payout / sales).toFixed(2)) : 0,
          ticketCount,
        };
      }),
      heatmap: heatmap.map(row => ({
        number: row.number,
        sales: Number(row.total_sales) || 0,
      })),
      byLoteria: byLoteriaResult.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        return {
          loteriaId: row.loteria_id,
          loteriaName: row.loteria_name,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? parseFloat((payout / sales).toFixed(2)) : 0,
          status: row.status,
          criticalNumber: row.critical_number,
        };
      }),
      bySorteo: bySorteoResult.map(row => {
        const sales = Number(row.sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        return {
          sorteoId: row.sorteo_id,
          sorteoName: row.sorteo_name,
          loteriaName: row.loteria_name,
          drawTime: row.draw_time,
          status: row.status,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? parseFloat((payout / sales).toFixed(2)) : 0,
          criticalNumber: row.critical_number,
          topNumbers: row.top_numbers_json ? JSON.parse(row.top_numbers_json) : [],
        };
      }),
    };
  },

  /**
   * Ranking por vendedor: ventas, comisiones, tickets
   */
  async getVendedores(filters: DashboardFilters) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const offset = (page - 1) * pageSize;
    const orderBy = filters.orderBy || 'sales';
    const order = filters.order || 'desc';

    const orderClause = {
      sales: Prisma.sql`total_sales`,
      commissions: Prisma.sql`total_commissions`,
      tickets: Prisma.sql`total_tickets`,
      winners: Prisma.sql`winning_tickets`,
      avgTicket: Prisma.sql`avg_ticket`,
      payout: Prisma.sql`total_payout`,
      net: Prisma.sql`net`,
      margin: Prisma.sql`margin`,
    }[orderBy] || Prisma.sql`total_sales`;

    const orderDirection = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const skipExclusion = await isExclusionListEmpty();
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
    const jugadaExclusionFilter = skipExclusion ? Prisma.empty : Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle
          JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId"
          AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
          AND sle.multiplier_id = j."multiplierId"
        )`;

    const result = await prisma.$queryRaw<
      Array<{
        vendedor_id: string;
        vendedor_name: string;
        vendedor_code: string | null;
        ventana_id: string | null;
        ventana_name: string | null;
        is_active: boolean;
        total_sales: number;
        total_payout: number;
        commission_user: number;
        commission_ventana: number;
        total_tickets: number;
        winning_tickets: number;
        avg_ticket: number;
      }>
    >(
      Prisma.sql`
        WITH open_sales AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
            COALESCE(SUM(t."totalPayout"), 0) AS total_payout,
            COALESCE(SUM(t."totalCommission"), 0) AS commission_user,
            COALESCE(SUM(t."totalListeroCommission"), 0) AS commission_ventana,
            COUNT(t.id) AS total_tickets,
            COALESCE(SUM(CASE WHEN t."isWinner" = true THEN 1 ELSE 0 END), 0) AS winning_tickets
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND s.status = 'OPEN'
            ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY t."vendedorId"
        ),
        evaluated_sales AS (
          SELECT
            rcd."vendedorId" AS vendedor_id,
            COALESCE(SUM(rcd."totalVendida"), 0) AS total_sales,
            COALESCE(SUM(rcd."ganado"), 0) AS total_payout,
            COALESCE(SUM(rcd."comisionVendedor"), 0) AS commission_user,
            COALESCE(SUM(rcd."comisionTotal"), 0) AS commission_ventana,
            COALESCE(SUM(rcd."ticketsCount"), 0) AS total_tickets,
            0 AS winning_tickets
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY rcd."vendedorId"
        ),
        combined_sales AS (
          SELECT vendedor_id, total_sales, total_payout, commission_user, commission_ventana, total_tickets, winning_tickets FROM open_sales
          UNION ALL
          SELECT vendedor_id, total_sales, total_payout, commission_user, commission_ventana, total_tickets, winning_tickets FROM evaluated_sales
        ),
        vendedor_totals AS (
          SELECT
            vendedor_id,
            SUM(total_sales)::double precision AS total_sales,
            SUM(total_payout)::double precision AS total_payout,
            SUM(commission_user)::double precision AS commission_user,
            SUM(commission_ventana)::double precision AS commission_ventana,
            SUM(total_tickets)::bigint AS total_tickets,
            SUM(winning_tickets)::bigint AS winning_tickets
          FROM combined_sales
          WHERE vendedor_id IS NOT NULL
          GROUP BY vendedor_id
        )
        SELECT
          u.id as vendedor_id,
          u.name as vendedor_name,
          u.code as vendedor_code,
          u."ventanaId" as ventana_id,
          v.name as ventana_name,
          u."isActive" as is_active,
          COALESCE(vt.total_sales, 0) as total_sales,
          COALESCE(vt.total_payout, 0) as total_payout,
          COALESCE(vt.commission_user, 0) as commission_user,
          COALESCE(vt.commission_ventana, 0) as commission_ventana,
          COALESCE(vt.total_tickets, 0) as total_tickets,
          COALESCE(vt.winning_tickets, 0) as winning_tickets,
          CASE
            WHEN COALESCE(vt.total_tickets, 0) > 0 THEN COALESCE(vt.total_sales, 0) / COALESCE(vt.total_tickets, 0)
            ELSE 0
          END as avg_ticket
        FROM "User" u
        JOIN vendedor_totals vt ON vt.vendedor_id = u.id
        LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
        ORDER BY ${orderClause} ${orderDirection}
        LIMIT ${pageSize}
        OFFSET ${offset}
      `
    );

    // Count total para paginación
    const totalCount = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        WITH open_vendedores AS (
          SELECT DISTINCT t."vendedorId" AS vendedor_id
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND s.status = 'OPEN'
            ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        evaluated_vendedores AS (
          SELECT DISTINCT rcd."vendedorId" AS vendedor_id
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        all_active_vendedores AS (
          SELECT vendedor_id FROM open_vendedores
          UNION
          SELECT vendedor_id FROM evaluated_vendedores
        )
        SELECT COUNT(DISTINCT u.id) as count
        FROM all_active_vendedores av
        JOIN "User" u ON u.id = av.vendedor_id
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
      `
    );

    const total = Number(totalCount[0]?.count) || 0;

    return {
      byVendedor: result.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.total_payout) || 0;
        const commissionUser = Number(row.commission_user) || 0;
        const commissionVentana = Number(row.commission_ventana) || 0;
        // net = sales - payout - commissionUser (comisión del vendedor)
        const net = sales - payout - commissionUser;
        // margin = (net / sales) * 100 si sales > 0
        const margin = sales > 0 ? (net / sales) * 100 : 0;
        const tickets = Number(row.total_tickets) || 0;
        const winners = Number(row.winning_tickets) || 0;
        const winRate = tickets > 0 ? (winners / tickets) * 100 : 0;

        return {
          vendedorId: row.vendedor_id,
          vendedorName: row.vendedor_name,
          vendedorCode: row.vendedor_code || undefined,
          ventanaId: row.ventana_id || undefined,
          ventanaName: row.ventana_name || undefined,
          sales,
          payout,
          commissionUser,
          commissionVentana,
          net,
          margin: parseFloat(margin.toFixed(2)),
          tickets,
          winners,
          avgTicket: Number(row.avg_ticket) || 0,
          winRate: parseFloat(winRate.toFixed(2)),
          isActive: row.is_active,
        };
      }),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  /**
   * Período anterior: para comparación de crecimiento
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async calculatePreviousPeriod(filters: DashboardFilters, role?: Role) {
    const diffMs = filters.toDate.getTime() - filters.fromDate.getTime();
    const previousFromDate = new Date(filters.fromDate.getTime() - diffMs);
    const previousToDate = new Date(filters.fromDate.getTime() - 1);

    const previousFilters: DashboardFilters = {
      ...filters,
      fromDate: previousFromDate,
      toDate: previousToDate,
    };

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(previousFilters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isPrevHistorical = toDateStr < todayCRStr;

    let row = {
      total_sales: 0,
      total_payouts: 0,
      total_tickets: 0,
      winning_tickets: 0,
      commission_user: 0,
      commission_ventana: 0,
    };

    const stats = await prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          COALESCE(SUM(a."totalSales"), 0) as total_sales,
          COALESCE(SUM(a."totalPayouts"), 0) as total_payouts,
          COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
          COALESCE(SUM(a."vendedorCommission"), 0) as commission_user,
          COALESCE(SUM(a."listeroCommission"), 0) as commission_ventana
        FROM "AccountStatement" a
        WHERE a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${previousFilters.bancaId ? Prisma.sql`AND a."bancaId" = ${previousFilters.bancaId}::uuid` : Prisma.empty}
          ${previousFilters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${previousFilters.ventanaId}::uuid` : Prisma.empty}
          ${previousFilters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${previousFilters.vendedorId}::uuid` : Prisma.empty}
          ${(!previousFilters.ventanaId && !previousFilters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
      `
    );

    // ⚡ OPTIMIZACIÓN: Contar ganadores con SQL crudo para forzar uso del índice parcial idx_ticket_winner_status_date
    const winningTicketsCountRows = await prisma.$queryRaw<Array<{ count: number }>>(
      Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM "Ticket"
        WHERE "isWinner" = true
          AND "deletedAt" IS NULL
          AND "isActive" = true
          AND "businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${previousFilters.bancaId ? Prisma.sql`AND "bancaId" = CAST(${previousFilters.bancaId} AS uuid)` : Prisma.empty}
          ${previousFilters.ventanaId ? Prisma.sql`AND "ventanaId" = CAST(${previousFilters.ventanaId} AS uuid)` : Prisma.empty}
          ${previousFilters.vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${previousFilters.vendedorId} AS uuid)` : Prisma.empty}
      `
    );
    const winningTicketsCount = Number(winningTicketsCountRows[0]?.count) || 0;

    if (stats && stats[0]) {
      row = {
        total_sales: Number(stats[0].total_sales) || 0,
        total_payouts: Number(stats[0].total_payouts) || 0,
        total_tickets: Number(stats[0].total_tickets) || 0,
        winning_tickets: winningTicketsCount,
        commission_user: Number(stats[0].commission_user) || 0,
        commission_ventana: Number(stats[0].commission_ventana) || 0,
      };
    }

    const sales = Number(row.total_sales) || 0;
    const payouts = Number(row.total_payouts) || 0;
    const commissionUser = Number(row.commission_user) || 0;
    //  FIX: Use ONLY snapshot from database, NOT totalVentanaCommission
    // totalVentanaCommission is already included in row.commission_ventana
    const commissionVentana = Number(row.commission_ventana) || 0;
    const totalCommissions = commissionUser + commissionVentana;

    //  CORRECCIÓN: Calcular ganancia neta según rol
    // Para ADMIN: resta commissionVentana (comisión del listero)
    // Para VENTANA/VENDEDOR: resta commissionUser (comisión del vendedor)
    const net = role === Role.ADMIN
      ? sales - payouts - commissionVentana
      : sales - payouts - commissionUser;
    const margin = sales > 0 ? (net / sales) * 100 : 0;

    return {
      sales,
      payouts,
      net, //  NUEVO: Ganancia neta del período anterior
      margin: parseFloat(margin.toFixed(2)), //  NUEVO: Margen neto del período anterior
      tickets: Number(row.total_tickets) || 0,
      winners: Number(row.winning_tickets) || 0,
      commissions: totalCommissions,
      commissionUser,
      commissionVentana,
      commissionVentanaTotal: commissionVentana, // Alias para compatibilidad con frontend
      range: {
        fromAt: previousFromDate.toISOString(),
        toAt: previousToDate.toISOString(),
      },
    };
  },

  /**
   * Sistema de alertas: detecta problemas y oportunidades
   */
  generateAlerts(data: any) {
    const alerts: Array<{
      type: string;
      severity: 'info' | 'warn' | 'critical';
      message: string;
      action: string;
    }> = [];

    // Thresholds (deberían venir de env)
    const CXC_THRESHOLD_WARN = 50000;
    const CXC_THRESHOLD_CRITICAL = 100000;
    const LOW_SALES_THRESHOLD = 10000;
    const EXPOSURE_THRESHOLD_WARN = 60;
    const EXPOSURE_THRESHOLD_CRITICAL = 80;

    /* 
    // Nueva lógica: Alertar SOLO sobre riesgo en calle (Vendedores)
    // No alertar sobre saldos de listeros (Ventanas) ya que se consideran fondo de caja (Reserva)
    // DESACTIVADO: CxC y CxP comentados por performance
    const isVendedorDimension = (data.cxc?.byVendedor && data.cxc.byVendedor.length > 0) || 
                                (data.cxp?.byVendedor && data.cxp.byVendedor.length > 0);

    if (isVendedorDimension) {
      // Alerta: Vendedores con Deuda (CxC positivo)
      if (data.cxc.totalAmount > CXC_THRESHOLD_CRITICAL) {
        alerts.push({
          type: 'HIGH_CXC',
          severity: 'critical',
          message: `Riesgo en calle (Deuda Vendedores): ₡${data.cxc.totalAmount.toLocaleString()}`,
          action: 'Revisar vendedores con mayor deuda y gestionar cobro con listeros',
        });
      }

      // Alerta: Déficit de Cobertura (Vendedores con saldo negativo / CxP)
      // "si un vendedor en el saldo a hoy tiene saldo negativo es que no tiene para cubrir"
      if (data.cxp.totalAmount > 0) {
        alerts.push({
          type: 'LIQUIDITY_RISK',
          severity: 'critical',
          message: `Déficit de Cobertura: ₡${data.cxp.totalAmount.toLocaleString()} (Vendedores sin liquidez)`,
          action: 'Listeros deben proveer fondos inmediatos para cubrir pago de premios',
        });
      }
    }
    */

    // Alertas generales (siempre relevantes)
    // Alerta: Ventas bajas
    if (data.summary.totalSales < LOW_SALES_THRESHOLD) {
      alerts.push({
        type: 'LOW_SALES',
        severity: 'warn',
        message: `Ventas bajas: ₡${data.summary.totalSales.toLocaleString()}`,
        action: 'Revisar actividad de vendedores y promociones activas',
      });
    }

    // Alerta: Alta exposición en número específico
    if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_CRITICAL) {
      alerts.push({
        type: 'HIGH_EXPOSURE',
        severity: 'critical',
        message: `Exposición crítica en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x`,
        action: 'Considerar límites de apuesta para este número',
      });
    } else if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_WARN) {
      alerts.push({
        type: 'HIGH_EXPOSURE',
        severity: 'warn',
        message: `Exposición alta en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x`,
        action: 'Monitorear ventas en este número',
      });
    }

    return alerts;
  },

  /**
   * GET /admin/dashboard/summary
   * KPIs del período + monthToDate + byVentana con balances.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  async calculateDashboardSummary(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    const fromDateStr = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr   = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr  = crDateService.dateUTCToCRString(new Date());
    const isToday     = toDateStr >= todayCRStr;
    const ttl         = isToday ? 30 : 300;
    const cacheKey    = `dashboard:summary:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${fromDateStr}:${toDateStr}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        const nowCRStr    = crDateService.dateUTCToCRString(new Date());
        const currentMonth = nowCRStr.substring(0, 7); // YYYY-MM

        const bancaFilter   = filters.bancaId
          ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)`
          : Prisma.empty;
        const ventanaFilter = filters.ventanaId
          ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)`
          : Prisma.empty;

        type ByVentanaRow = {
          ventana_id: string;
          ventana_name: string;
          is_active: boolean;
          total_sales: string;
          total_payouts: string;
          listero_commission: string;
          vendedor_commission: string;
          ticket_count: string;
          remaining_balance: string;
          vendedores_remaining_balance: string;
        };

        type MtdRow = {
          total_sales: string;
          total_payouts: string;
          listero_commission: string;
          vendedor_commission: string;
        };

        // Query A — per-ventana period aggregates + saldo acumulado mes actual
        const [byVentanaRaw, mtdRaw] = await Promise.all([
          prisma.$queryRaw<ByVentanaRow[]>`
            SELECT
              v.id                                         AS ventana_id,
              v.name                                       AS ventana_name,
              v."isActive"                                 AS is_active,
              COALESCE(SUM(s."totalSales"), 0)             AS total_sales,
              COALESCE(SUM(s."totalPayouts"), 0)           AS total_payouts,
              COALESCE(SUM(s."listeroCommission"), 0)      AS listero_commission,
              COALESCE(SUM(s."vendedorCommission"), 0)     AS vendedor_commission,
              COALESCE(SUM(s."ticketCount"), 0)            AS ticket_count,
              COALESCE(MAX(lb.remaining_balance), 0)       AS remaining_balance,
              COALESCE(MAX(vlb.total_vendedores_balance), 0) AS vendedores_remaining_balance
            FROM "Ventana" v
            LEFT JOIN "AccountStatement" s
              ON  s."ventanaId" = v.id
              AND s."vendedorId" IS NULL
              AND s.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            LEFT JOIN LATERAL (
              SELECT "remainingBalance" AS remaining_balance
              FROM   "AccountStatement"
              WHERE  "ventanaId"   = v.id
                AND  "vendedorId"  IS NULL
                AND  month         = ${currentMonth}
              ORDER BY date DESC
              LIMIT 1
            ) lb ON true
            LEFT JOIN LATERAL (
              SELECT SUM(lb_vend.remaining_balance) AS total_vendedores_balance
              FROM "User" u
              JOIN LATERAL (
                SELECT "remainingBalance" AS remaining_balance
                FROM "AccountStatement" ast
                WHERE ast."vendedorId" = u.id
                  AND ast.month = ${currentMonth}
                ORDER BY date DESC
                LIMIT 1
              ) lb_vend ON true
              WHERE u."ventanaId" = v.id
                AND u.role = 'VENDEDOR'
                AND u."isActive" = true
                AND u."deletedAt" IS NULL
            ) vlb ON true
            WHERE v."deletedAt" IS NULL
              ${bancaFilter}
              ${ventanaFilter}
            GROUP BY v.id, v.name, v."isActive"
            ORDER BY total_sales DESC
          `,

          // Query B — month-to-date global (SUM simple)
          prisma.$queryRaw<MtdRow[]>`
            SELECT
              COALESCE(SUM(s."totalSales"), 0)         AS total_sales,
              COALESCE(SUM(s."totalPayouts"), 0)        AS total_payouts,
              COALESCE(SUM(s."listeroCommission"), 0)   AS listero_commission,
              COALESCE(SUM(s."vendedorCommission"), 0)  AS vendedor_commission
            FROM "AccountStatement" s
            JOIN "Ventana" v ON v.id = s."ventanaId"
            WHERE v."deletedAt"  IS NULL
              AND s."vendedorId" IS NULL
              AND s.month        = ${currentMonth}
              ${bancaFilter}
              ${ventanaFilter}
          `,
        ]);

        // Mapear byVentana y calcular derivados
        const byVentana = byVentanaRaw.map((r) => {
          const totalSales        = Number(r.total_sales);
          const totalPayouts      = Number(r.total_payouts);
          const listeroCommission = Number(r.listero_commission);
          const vendedorCommission= Number(r.vendedor_commission);
          const remainingBalance  = Number(r.remaining_balance);
          const vendedoresRemainingBalance = Number(r.vendedores_remaining_balance);
          const net    = totalSales - totalPayouts - listeroCommission;
          const margin = totalSales > 0 ? parseFloat(((net / totalSales) * 100).toFixed(2)) : 0;
          return {
            ventanaId:          r.ventana_id,
            ventanaName:        r.ventana_name,
            isActive:           r.is_active,
            totalSales:         parseFloat(totalSales.toFixed(2)),
            totalPayouts:       parseFloat(totalPayouts.toFixed(2)),
            listeroCommission:  parseFloat(listeroCommission.toFixed(2)),
            vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
            net:                parseFloat(net.toFixed(2)),
            margin,
            ticketCount:        Number(r.ticket_count),
            remainingBalance:   parseFloat(remainingBalance.toFixed(2)),
            vendedoresRemainingBalance: parseFloat(vendedoresRemainingBalance.toFixed(2)),
            cxcAmount:          parseFloat(Math.max(remainingBalance, 0).toFixed(2)),
            cxpAmount:          parseFloat(Math.max(-remainingBalance, 0).toFixed(2)),
          };
        });

        // KPIs globales — suma de byVentana (ya filtrado por RBAC)
        const totSales   = byVentana.reduce((s, v) => s + v.totalSales, 0);
        const totPayouts = byVentana.reduce((s, v) => s + v.totalPayouts, 0);
        const totListero = byVentana.reduce((s, v) => s + v.listeroCommission, 0);
        const totVend    = byVentana.reduce((s, v) => s + v.vendedorCommission, 0);
        const totTickets = byVentana.reduce((s, v) => s + v.ticketCount, 0);
        const totNet     = totSales - totPayouts - totListero;
        const totMargin  = totSales > 0 ? parseFloat(((totNet / totSales) * 100).toFixed(2)) : 0;

        const kpis = {
          totalSales:         parseFloat(totSales.toFixed(2)),
          totalPayouts:       parseFloat(totPayouts.toFixed(2)),
          listeroCommission:  parseFloat(totListero.toFixed(2)),
          vendedorCommission: parseFloat(totVend.toFixed(2)),
          totalNet:           parseFloat(totNet.toFixed(2)),
          margin:             totMargin,
          ticketCount:        totTickets,
        };

        // monthToDate
        const mtd = mtdRaw[0] ?? { total_sales: '0', total_payouts: '0', listero_commission: '0', vendedor_commission: '0' };
        const mtdSales   = Number(mtd.total_sales);
        const mtdPayouts = Number(mtd.total_payouts);
        const mtdListero = Number(mtd.listero_commission);
        const mtdVend    = Number(mtd.vendedor_commission);
        const mtdNet     = mtdSales - mtdPayouts - mtdListero;
        const monthToDate = {
          totalSales:         parseFloat(mtdSales.toFixed(2)),
          totalPayouts:       parseFloat(mtdPayouts.toFixed(2)),
          listeroCommission:  parseFloat(mtdListero.toFixed(2)),
          vendedorCommission: parseFloat(mtdVend.toFixed(2)),
          totalNet:           parseFloat(mtdNet.toFixed(2)),
          margin:             mtdSales > 0 ? parseFloat(((mtdNet / mtdSales) * 100).toFixed(2)) : 0,
        };

        return {
          kpis,
          monthToDate,
          byVentana,
          meta: {
            fromAt:       filters.fromDate.toISOString(),
            toAt:         filters.toDate.toISOString(),
            currentMonth,
            generatedAt:  new Date().toISOString(),
          },
        };
      },
      ttl,
      ['dashboard']
    );
  },

  /**
   * GET /admin/dashboard/entities
   * Desglose por vendedor con balances acumulados.
   * Reemplaza: cxc/cxp?dimension=vendedor, /vendedores, /accumulated-balances?dimension=vendedor.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  async calculateDashboardEntities(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    const fromDateStr  = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr    = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr   = crDateService.dateUTCToCRString(new Date());
    const isToday      = toDateStr >= todayCRStr;
    const ttl          = isToday ? 30 : 300;
    const cacheKey     = `dashboard:entities:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${fromDateStr}:${toDateStr}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        const nowCRStr     = crDateService.dateUTCToCRString(new Date());
        const currentMonth = nowCRStr.substring(0, 7);

        const bancaFilter   = filters.bancaId
          ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)`
          : Prisma.empty;
        const ventanaFilter = filters.ventanaId
          ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)`
          : Prisma.empty;

        type EntidadRow = {
          vendedor_id: string;
          vendedor_name: string;
          vendedor_code: string | null;
          is_active: boolean;
          ventana_id: string;
          ventana_name: string;
          total_sales: string;
          total_payouts: string;
          listero_commission: string;
          vendedor_commission: string;
          ticket_count: string;
          remaining_balance: string;
        };

        const rows = await prisma.$queryRaw<EntidadRow[]>`
          SELECT
            u.id                                          AS vendedor_id,
            u.name                                        AS vendedor_name,
            u.code                                        AS vendedor_code,
            u."isActive"                                  AS is_active,
            v.id                                          AS ventana_id,
            v.name                                        AS ventana_name,
            COALESCE(SUM(s."totalSales"), 0)              AS total_sales,
            COALESCE(SUM(s."totalPayouts"), 0)            AS total_payouts,
            COALESCE(SUM(s."listeroCommission"), 0)       AS listero_commission,
            COALESCE(SUM(s."vendedorCommission"), 0)      AS vendedor_commission,
            COALESCE(SUM(s."ticketCount"), 0)             AS ticket_count,
            COALESCE(MAX(lb.remaining_balance), 0)        AS remaining_balance
          FROM "User" u
          JOIN "Ventana" v ON v.id = u."ventanaId"
          LEFT JOIN "AccountStatement" s
            ON  s."vendedorId" = u.id
            AND s.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          LEFT JOIN LATERAL (
            SELECT "remainingBalance" AS remaining_balance
            FROM   "AccountStatement"
            WHERE  "vendedorId" = u.id
              AND  month        = ${currentMonth}
            ORDER BY date DESC
            LIMIT 1
          ) lb ON true
          WHERE u."deletedAt"  IS NULL
            AND u.role         = 'VENDEDOR'
            AND v."deletedAt"  IS NULL
            ${bancaFilter}
            ${ventanaFilter}
          GROUP BY u.id, u.name, u.code, u."isActive", v.id, v.name
          ORDER BY total_sales DESC
        `;

        const vendedores = rows.map((r) => {
          const totalSales         = Number(r.total_sales);
          const totalPayouts       = Number(r.total_payouts);
          const listeroCommission  = Number(r.listero_commission);
          const vendedorCommission = Number(r.vendedor_commission);
          const remainingBalance   = Number(r.remaining_balance);
          const net    = totalSales - totalPayouts - vendedorCommission;
          const margin = totalSales > 0 ? parseFloat(((net / totalSales) * 100).toFixed(2)) : 0;
          return {
            vendedorId:          r.vendedor_id,
            vendedorName:        r.vendedor_name,
            vendedorCode:        r.vendedor_code ?? null,
            isActive:            r.is_active,
            ventanaId:           r.ventana_id,
            ventanaName:         r.ventana_name,
            totalSales:          parseFloat(totalSales.toFixed(2)),
            totalPayouts:        parseFloat(totalPayouts.toFixed(2)),
            listeroCommission:   parseFloat(listeroCommission.toFixed(2)),
            vendedorCommission:  parseFloat(vendedorCommission.toFixed(2)),
            net:                 parseFloat(net.toFixed(2)),
            margin,
            ticketCount:         Number(r.ticket_count),
            remainingBalance:    parseFloat(remainingBalance.toFixed(2)),
            cxcAmount:           parseFloat(Math.max(remainingBalance, 0).toFixed(2)),
            cxpAmount:           parseFloat(Math.max(-remainingBalance, 0).toFixed(2)),
          };
        });

        return {
          vendedores,
          meta: {
            fromAt:       filters.fromDate.toISOString(),
            toAt:         filters.toDate.toISOString(),
            currentMonth,
            generatedAt:  new Date().toISOString(),
          },
        };
      },
      ttl,
      ['dashboard']
    );
  },
};

export default DashboardService;
