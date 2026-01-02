import { Prisma, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { resolveCommission } from "../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../services/commission/commission.resolver";
import { getPreviousMonthFinalBalance, getPreviousMonthFinalBalancesBatch } from "./accounts/accounts.calculations";
import { resolveDateRange } from "../../../utils/dateRange";
import { crDateService } from "../../../utils/crDateService";

/**
 * Dashboard Service
 * Calcula métricas financieras: Ganancia, CxC (Cuentas por Cobrar), CxP (Cuentas por Pagar)
 */

interface DashboardFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string; // Para RBAC
  bancaId?: string; // Para filtrar por banca activa (ADMIN multibanca)
  loteriaId?: string; // Filtro por lotería
  betType?: 'NUMERO' | 'REVENTADO'; // Filtro por tipo de apuesta
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
  cxcDimension?: 'ventana' | 'vendedor'; // ✅ NUEVO: Dimensión para CxC/CxP (default: 'ventana')
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
    periodBalance: number; // ✅ NUEVO: Saldo del periodo filtrado
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
      remainingBalance: number; // ✅ NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
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
      remainingBalance: number; // ✅ NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
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
      remainingBalance: number; // ✅ NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
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
      remainingBalance: number; // ✅ NUEVO: Saldo a Hoy (acumulado del mes completo, inmutable respecto período)
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
  gananciaListeros?: number; // ✅ NUEVO: Ganancia neta de listeros (commissionVentana - commissionUser)
  gananciaBanca?: number; // ✅ NUEVO: Alias conceptual para net
  totalTickets: number;
  winningTickets: number;
  net: number;
  margin: number; // ✅ PORCENTAJE: Margen neto con máximo 2 decimales (toFixed(2))
  winRate: number; // ✅ PORCENTAJE: Tasa de ganancia con máximo 2 decimales (toFixed(2))
}

const COSTA_RICA_OFFSET_HOURS = -6;

function toCostaRicaDateString(date: Date): string {
  const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  return local.toISOString().split("T")[0];
}

/**
 * Formatea un Date a ISO 8601 con offset de Costa Rica (-06:00)
 * El Date viene de PostgreSQL que ya aplicó AT TIME ZONE 'America/Costa_Rica'.
 * PostgreSQL devuelve un timestamp sin timezone que representa CR time,
 * pero Prisma lo interpreta como UTC. Necesitamos ajustarlo para formatearlo correctamente.
 * 
 * Ejemplo: "2025-01-14T00:00:00-06:00"
 */
function formatCostaRicaISO(date: Date): string {
  // Cuando PostgreSQL devuelve un timestamp con AT TIME ZONE 'America/Costa_Rica',
  // devuelve un timestamp sin timezone que representa CR time.
  // Prisma lo interpreta como UTC, así que necesitamos ajustarlo.
  // Si PostgreSQL devolvió "2025-01-14 00:00:00" (CR), Prisma lo convierte a
  // un Date que representa "2025-01-14 00:00:00 UTC" (incorrecto, debería ser 06:00 UTC).
  // Para corregirlo, restamos el offset para obtener la hora local de CR.
  const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
  const crDate = new Date(date.getTime() - offsetMs);

  const year = crDate.getUTCFullYear();
  const month = String(crDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(crDate.getUTCDate()).padStart(2, '0');
  const hours = String(crDate.getUTCHours()).padStart(2, '0');
  const minutes = String(crDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(crDate.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}-06:00`;
}

/**
 * Formatea un Date a YYYY-MM-DD en zona horaria de Costa Rica
 */
function formatCostaRicaDate(date: Date): string {
  // Similar a formatCostaRicaISO, pero solo la fecha
  const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
  const crDate = new Date(date.getTime() - offsetMs);
  const year = crDate.getUTCFullYear();
  const month = String(crDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(crDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formatea label según granularity
 * hour → "14:00", "15:00", etc.
 * day → "15 ene", "16 ene", etc.
 * week → "Sem 1", "Sem 2", etc.
 * month → "ene", "feb", etc.
 */
function formatTimeSeriesLabel(date: Date, granularity: 'hour' | 'day' | 'week' | 'month'): string {
  const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
  const crDate = new Date(date.getTime() - offsetMs);

  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  switch (granularity) {
    case 'hour': {
      const hours = crDate.getUTCHours();
      const minutes = crDate.getUTCMinutes();
      const displayHours = hours % 12 || 12;
      const ampm = hours >= 12 ? 'PM' : 'AM';
      return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    }
    case 'day': {
      const day = crDate.getUTCDate();
      const month = months[crDate.getUTCMonth()];
      return `${day} ${month}`;
    }
    case 'week': {
      // Calcular semana del año
      const startOfYear = new Date(Date.UTC(crDate.getUTCFullYear(), 0, 1));
      const daysSinceStart = Math.floor((crDate.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
      const weekNumber = Math.ceil((daysSinceStart + startOfYear.getUTCDay() + 1) / 7);
      return `Sem ${weekNumber}`;
    }
    case 'month': {
      return months[crDate.getUTCMonth()];
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
  return Prisma.sql`
    COALESCE(
      ${Prisma.raw(`${alias}."businessDate"`)},
      DATE((${Prisma.raw(`${alias}."createdAt"`)} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
    ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
  `;
}

function buildTicketBaseFilters(
  alias: string,
  filters: DashboardFilters,
  fromDateStr: string,
  toDateStr: string
) {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`${Prisma.raw(`${alias}."deletedAt"`)} IS NULL`,
    Prisma.sql`${Prisma.raw(`${alias}."isActive"`)} = true`,
    Prisma.sql`${Prisma.raw(`${alias}."status"`)} IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
    ticketBusinessDateCondition(alias, fromDateStr, toDateStr),
    // ✅ CAMBIO STRICT: Solo incluir sorteos EVALUATED (Global Filter)
    Prisma.sql`EXISTS (
      SELECT 1 FROM "Sorteo" s
      WHERE s.id = ${Prisma.raw(`${alias}."sorteoId"`)}
      AND s.status = 'EVALUATED'
    )`,
    // ✅ NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
    // NOTA: Debido al workaround del esquema, sle.ventana_id contiene el ID del USUARIO listero.
    // Debemos hacer JOIN con User para obtener el ID real de la ventana y compararlo con el ticket.
    // ✅ FIX: Solo excluir el ticket completo si la exclusión es TOTAL (multiplier_id IS NULL).
    // Las exclusiones parciales (por multiplicador) se manejan en las consultas de agregación (Jugada).
    Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "sorteo_lista_exclusion" sle
      JOIN "User" u ON u.id = sle.ventana_id
      WHERE sle.sorteo_id = ${Prisma.raw(`${alias}."sorteoId"`)}
      AND u."ventanaId" = ${Prisma.raw(`${alias}."ventanaId"`)}
      AND (sle.vendedor_id IS NULL OR sle.vendedor_id = ${Prisma.raw(`${alias}."vendedorId"`)})
      AND sle.multiplier_id IS NULL
    )`,
  ];

  if (filters.ventanaId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."ventanaId"`)} = ${filters.ventanaId}`);
  }

  // Filtrar por banca activa (para ADMIN multibanca)
  if (filters.bancaId) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v
      WHERE v.id = ${Prisma.raw(`${alias}."ventanaId"`)}
      AND v."bancaId" = ${filters.bancaId}::uuid
    )`);
  }

  if (filters.loteriaId) {
    conditions.push(Prisma.sql`${Prisma.raw(`${alias}."loteriaId"`)} = ${filters.loteriaId}`);
  }

  let combined = conditions[0];
  for (let i = 1; i < conditions.length; i++) {
    combined = Prisma.sql`${combined} AND ${conditions[i]}`;
  }

  return combined;
}

function parseDateStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function parseDateEnd(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function buildTicketWhereInput(
  filters: DashboardFilters,
  fromDateStr: string,
  toDateStr: string
): Prisma.TicketWhereInput {
  const rangeStart = parseDateStart(fromDateStr);
  const rangeEnd = parseDateEnd(toDateStr);

  const baseWhere: Prisma.TicketWhereInput = {
    deletedAt: null,
    isActive: true,
    status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
    // ✅ CAMBIO STRICT: Solo incluir tickets de sorteos EVALUATED
    sorteo: {
      status: "EVALUATED",
    },
    AND: [
      {
        OR: [
          {
            businessDate: {
              gte: rangeStart,
              lte: rangeEnd,
            },
          },
          {
            businessDate: null,
            createdAt: {
              gte: rangeStart,
              lte: rangeEnd,
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
        const resolution = resolveCommissionFromPolicy(userPolicyJson, {
          userId: ventanaUserId,
          loteriaId: ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX ?? null,
        });
        ventanaAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
      } catch (err) {
        const fallback = resolveCommission(
          {
            loteriaId: ticket.loteriaId,
            betType: jugada.type as "NUMERO" | "REVENTADO",
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
      const fallback = resolveCommission(
        {
          loteriaId: ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
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
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);
    // ✅ CAMBIO: NO llamamos a computeVentanaCommissionFromPolicies()
    // Las comisiones ya vienen del SQL snapshot (SUM(listeroCommissionAmount))

    const byVentanaResult = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        total_tickets: number;
        winning_tickets: number;
        commission_user: number;
        commission_ventana: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."ventanaId",
            t."loteriaId",
            t."sorteoId",
            t."vendedorId",
            t."totalAmount",
            t."totalPayout",
            t."isWinner"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        ventanas_filtradas AS (
          SELECT v.id, v.name, v."isActive"
          FROM "Ventana" v
          WHERE v."isActive" = true
            ${filters.ventanaId ? Prisma.sql`AND v.id = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        ),
        sales_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts,
            COUNT(DISTINCT t.id) AS total_tickets,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) AS winning_tickets
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        ),
        commissions_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS commission_ventana
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        )
        SELECT
          v.id AS ventana_id,
          v.name AS ventana_name,
          v."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(sp.total_tickets, 0) AS total_tickets,
          COALESCE(sp.winning_tickets, 0) AS winning_tickets,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana, 0) AS commission_ventana
        FROM ventanas_filtradas v
        LEFT JOIN sales_per_ventana sp ON sp.ventana_id = v.id
        LEFT JOIN commissions_per_ventana cp ON cp.ventana_id = v.id
        ORDER BY total_sales DESC
      `
    );

    const byLoteriaResult = await prisma.$queryRaw<
      Array<{
        loteria_id: string;
        loteria_name: string;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        total_tickets: number;
        winning_tickets: number;
        commission_user: number;
        commission_ventana: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."ventanaId",
            t."loteriaId",
            t."sorteoId",
            t."vendedorId",
            t."totalAmount",
            t."totalPayout",
            t."isWinner"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        sales_per_loteria AS (
          SELECT
            t."loteriaId" AS loteria_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts,
            COUNT(DISTINCT t.id) AS total_tickets,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) AS winning_tickets
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."loteriaId"
        ),
        commissions_per_loteria AS (
          SELECT
            t."loteriaId" AS loteria_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS commission_ventana
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."loteriaId"
        )
        SELECT
          l.id AS loteria_id,
          l.name AS loteria_name,
          l."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(sp.total_tickets, 0) AS total_tickets,
          COALESCE(sp.winning_tickets, 0) AS winning_tickets,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana, 0) AS commission_ventana
        FROM "Loteria" l
        LEFT JOIN sales_per_loteria sp ON sp.loteria_id = l.id
        LEFT JOIN commissions_per_loteria cp ON cp.loteria_id = l.id
        WHERE l."isActive" = true
        ORDER BY total_sales DESC
      `
    );

    // ✅ NUEVO: Obtener pagos y cobros del periodo para calcular periodBalance
    const rangeStart = parseDateStart(fromDateStr);
    const rangeEnd = parseDateEnd(toDateStr);

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
    // ✅ CAMBIO: Usar SOLO snapshot del SQL (listeroCommissionAmount), NO recalculado desde políticas
    const commissionVentanaTotal = byVentanaResult.reduce((sum, v) => sum + Number(v.commission_ventana || 0), 0);
    const totalAmount = commissionUserTotal + commissionVentanaTotal;

    // ✅ CRÍTICO: Ganancia Global SIEMPRE usa commissionVentanaTotal (comisión del listero)
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
        // ✅ CAMBIO: Usar SOLO snapshot del SQL (row.commission_ventana = SUM(listeroCommissionAmount))
        const commissionVentana = Number(row.commission_ventana) || 0;
        const commissions = commissionUser + commissionVentana;
        // ✅ CRÍTICO: byVentana[].net SIEMPRE usa commissionVentana (comisión del listero)
        // Según especificaciones del cliente: el desglose por ventanas debe usar
        // las comisiones de los listeros, NO las comisiones de usuarios
        const net = sales - payout - commissionVentana;
        const ventanaMargin = sales > 0 ? (net / sales) * 100 : 0;
        const winRate = tickets > 0 ? (winners / tickets) * 100 : 0;

        // ✅ NUEVO: Calcular periodBalance (saldo del periodo filtrado)
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
          periodBalance: parseFloat(periodBalance.toFixed(2)), // ✅ NUEVO: Saldo del periodo
        };
      }),
      byLoteria: byLoteriaResult.map((row) => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.total_payouts) || 0;
        const tickets = Number(row.total_tickets) || 0;
        const winners = Number(row.winning_tickets) || 0;
        const commissionUser = Number(row.commission_user) || 0;
        // ✅ CAMBIO: Usar SOLO snapshot del SQL (row.commission_ventana = SUM(listeroCommissionAmount))
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

    // ✅ NUEVO: Si dimension='vendedor', ejecutar lógica específica para vendedores
    if (dimension === 'vendedor') {
      return this.calculateCxCByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStart(fromDateStr);
    const rangeEnd = parseDateEnd(toDateStr);
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

    // ✅ NOTE: Commission already included in SQL snapshot (listero_commission_snapshot)
    // No need to call computeVentanaCommissionFromPolicies here

    // ✅ CRÍTICO: Obtener datos directamente desde tickets/jugadas (igual que calculateGanancia)
    const ventanaData = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        commission_user: number;
        commission_ventana_raw: number;
        listero_commission_snapshot: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."ventanaId",
            t."sorteoId",
            t."vendedorId",
            t."totalAmount",
            t."totalPayout"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        sales_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        ),
        commissions_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        )
        SELECT
          v.id AS ventana_id,
          v.name AS ventana_name,
          v."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw,
          COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot
        FROM "Ventana" v
        LEFT JOIN sales_per_ventana sp ON sp.ventana_id = v.id
        LEFT JOIN commissions_per_ventana cp ON cp.ventana_id = v.id
        WHERE v."isActive" = true
          ${filters.ventanaId ? Prisma.sql`AND v.id = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        ORDER BY total_sales DESC
      `
    );

    const where: Prisma.AccountStatementWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: null,
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    } else {
      where.ventanaId = { not: null };
    }

    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      where.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const statements = await prisma.accountStatement.findMany({
      where,
      include: {
        ventana: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    // Asegurar que todas las ventanas activas aparezcan aunque no tengan statement
    // Filtrar por banca si está disponible
    const ventanaWhere: any = { isActive: true };
    if (filters.bancaId) {
      ventanaWhere.bancaId = filters.bancaId;
    }
    const ventanas = await prisma.ventana.findMany({
      where: ventanaWhere,
      select: { id: true, name: true, isActive: true },
    });
    const ventanaInfoMap = new Map(
      ventanas.map((v) => [v.id, { name: v.name, isActive: v.isActive }])
    );

    const aggregated = new Map<
      string,
      {
        ventanaId: string;
        ventanaName: string;
        isActive: boolean;
        totalSales: number;
        totalPayouts: number;
        totalListeroCommission: number;
        totalVendedorCommission: number;
        totalPaid: number;
        totalCollected: number;
        totalPaidToCustomer: number;
        remainingBalance: number;
      }
    >();

    const ensureEntry = (
      ventanaId: string,
      fallbackName?: string,
      fallbackIsActive?: boolean
    ) => {
      let entry = aggregated.get(ventanaId);
      if (!entry) {
        const info = ventanaInfoMap.get(ventanaId);
        entry = {
          ventanaId,
          ventanaName: fallbackName ?? info?.name ?? "Sin nombre",
          isActive: fallbackIsActive ?? info?.isActive ?? true,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          remainingBalance: 0,
        };
        aggregated.set(ventanaId, entry);
      } else {
        // Actualizar nombre/estado si recibimos datos más recientes
        if (fallbackName && entry.ventanaName !== fallbackName) {
          entry.ventanaName = fallbackName;
        }
        if (typeof fallbackIsActive === "boolean") {
          entry.isActive = fallbackIsActive;
        }
      }
      return entry;
    };

    // ✅ CRÍTICO: Usar datos calculados directamente desde tickets/jugadas
    for (const ventanaRow of ventanaData) {
      const ventanaId = ventanaRow.ventana_id;
      const entry = ensureEntry(ventanaId);

      entry.totalSales = Number(ventanaRow.total_sales) || 0;
      entry.totalPayouts = Number(ventanaRow.total_payouts) || 0;

      // ✅ CORREGIDO: Usar SIEMPRE el snapshot de comisión del listero
      // Esto asegura consistencia entre período filtrado y mes completo
      // No recalcular desde políticas (causa discrepancias de 44 colones)
      entry.totalListeroCommission = Number(ventanaRow.listero_commission_snapshot) || Number(ventanaRow.commission_ventana_raw) || 0;
      entry.totalVendedorCommission = Number(ventanaRow.commission_user) || 0;
    }

    // Obtener totalPaid desde AccountStatement (ya está calculado correctamente)
    for (const statement of statements) {
      if (!statement.ventanaId) continue;
      const key = statement.ventanaId;
      const existing = ensureEntry(
        key,
        statement.ventana?.name,
        statement.ventana?.isActive ?? undefined
      );

      existing.totalPaid += statement.totalPaid ?? 0;
    }

    const accountPaymentWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: null,
      isReversed: false,
      type: "collection",
    };
    if (filters.ventanaId) {
      accountPaymentWhere.ventanaId = filters.ventanaId;
    } else {
      accountPaymentWhere.ventanaId = { not: null };
    }
    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      // ✅ CRÍTICO: AccountPayment tiene bancaId directamente, no usar relación ventana
      accountPaymentWhere.bancaId = filters.bancaId;
    }

    const collections = await prisma.accountPayment.findMany({
      where: accountPaymentWhere,
      select: {
        ventanaId: true,
        amount: true,
      },
    });

    for (const collection of collections) {
      if (!collection.ventanaId) continue;
      const entry = ensureEntry(collection.ventanaId);
      entry.totalCollected += collection.amount ?? 0;
    }

    const ticketRelationFilter: Prisma.TicketWhereInput = {
      deletedAt: null,
    };
    if (filters.ventanaId) {
      ticketRelationFilter.ventanaId = filters.ventanaId;
    }
    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      ticketRelationFilter.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const ticketPayments = await prisma.ticketPayment.findMany({
      where: {
        isReversed: false,
        paymentDate: {
          gte: rangeStart,
          lte: rangeEnd,
        },
        ticket: {
          is: ticketRelationFilter,
        },
      },
      select: {
        amountPaid: true,
        ticket: {
          select: {
            ventanaId: true,
          },
        },
      },
    });

    for (const payment of ticketPayments) {
      const ventanaId = payment.ticket?.ventanaId;
      if (!ventanaId) continue;
      const entry = ensureEntry(ventanaId);
      entry.totalPaidToCustomer += payment.amountPaid ?? 0;
    }

    for (const ventana of ventanas) {
      ensureEntry(ventana.id, ventana.name, ventana.isActive);
    }

    // ✅ NUEVO: Verificar si el período filtrado es el mes completo
    // Si es así, el remainingBalance del período debe ser igual al monthlyAccumulated.remainingBalance
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const isMonthComplete = 
      filters.fromDate.getTime() === monthRangeCheck.fromAt.getTime() &&
      filters.toDate.getTime() === todayRangeCheck.toAt.getTime();

    // ✅ NUEVO: Calcular saldoAHoy (acumulado desde inicio del mes hasta hoy) para cada ventana
    const monthSaldoByVentana = new Map<string, number>();
    {
      // ✅ CORREGIDO: Usar resolveDateRange para calcular correctamente las fechas en CR timezone
      // Esto asegura consistencia entre local y producción (Render)
      const monthRange = resolveDateRange('month'); // Primer día del mes en CR
      const todayRange = resolveDateRange('today'); // Fin del día de hoy en CR
      
      const monthStart = monthRange.fromAt; // Primer día del mes en CR (06:00:00 UTC)
      const monthEnd = todayRange.toAt; // Fin del día de hoy en CR (23:59:59.999 CR = 05:59:59.999 UTC del día siguiente)

      // Convertir a strings de fecha para filtros usando crDateService
      // ✅ CRÍTICO: Usar dateRangeUTCToCRStrings para obtener correctamente el día de fin
      // porque toAt puede ser del día siguiente en UTC pero representa el fin del día anterior en CR
      const { startDateCRStr: monthStartStr, endDateCRStr: monthEndStr } = crDateService.dateRangeUTCToCRStrings(monthStart, monthEnd);

      // ✅ CRÍTICO: Para consultas de Prisma con campos @db.Date, necesitamos crear Dates que representen
      // el día completo como DATE (sin hora). monthEndStr ya es el día de hoy en formato YYYY-MM-DD
      const monthStartDate = new Date(`${monthStartStr}T00:00:00.000Z`);
      const monthEndDate = new Date(`${monthEndStr}T00:00:00.000Z`);

      // Construir filtros WHERE desde inicio del mes hasta hoy (Saldo a Hoy)
      const monthBaseFilters = buildTicketBaseFilters(
        "t",
        { ...filters, fromDate: monthStart, toDate: monthEnd },
        monthStartStr,
        monthEndStr
      );

      // Obtener datos de ventanas para el mes completo
      const monthVentanaData = await prisma.$queryRaw<
        Array<{
          ventana_id: string;
          ventana_name: string;
          is_active: boolean;
          total_sales: number;
          total_payouts: number;
          commission_user: number;
          commission_ventana_raw: number;
          listero_commission_snapshot: number;
        }>
      >(
        Prisma.sql`
          WITH tickets_in_range AS (
            SELECT
              t.id,
              t."ventanaId",
              t."sorteoId",
              t."vendedorId",
              t."totalAmount",
              t."totalPayout"
            FROM "Ticket" t
            WHERE ${monthBaseFilters}
          ),
          sales_per_ventana AS (
            SELECT
              t."ventanaId" AS ventana_id,
              COALESCE(SUM(j.amount), 0) AS total_sales,
              COALESCE(SUM(j.payout), 0) AS total_payouts
            FROM tickets_in_range t
            JOIN "Jugada" j ON j."ticketId" = t.id
            WHERE j."deletedAt" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              JOIN "User" u ON u.id = sle.ventana_id
              WHERE sle.sorteo_id = t."sorteoId"
              AND u."ventanaId" = t."ventanaId"
              AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
              AND sle.multiplier_id = j."multiplierId"
            )
            GROUP BY t."ventanaId"
          ),
          commissions_per_ventana AS (
            SELECT
              t."ventanaId" AS ventana_id,
              COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
              COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw,
              COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot
            FROM tickets_in_range t
            JOIN "Jugada" j ON j."ticketId" = t.id
            WHERE j."deletedAt" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              JOIN "User" u ON u.id = sle.ventana_id
              WHERE sle.sorteo_id = t."sorteoId"
              AND u."ventanaId" = t."ventanaId"
              AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
              AND sle.multiplier_id = j."multiplierId"
            )
            GROUP BY t."ventanaId"
          )
          SELECT
            v.id AS ventana_id,
            v.name AS ventana_name,
            v."isActive" AS is_active,
            COALESCE(sp.total_sales, 0) AS total_sales,
            COALESCE(sp.total_payouts, 0) AS total_payouts,
            COALESCE(cp.commission_user, 0) AS commission_user,
            COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw,
            COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot
          FROM "Ventana" v
          LEFT JOIN sales_per_ventana sp ON sp.ventana_id = v.id
          LEFT JOIN commissions_per_ventana cp ON cp.ventana_id = v.id
          WHERE v."isActive" = true
            ${filters.ventanaId ? Prisma.sql`AND v.id = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        `
      );

      // Obtener statements del mes completo
      // ✅ SOLUCIÓN DEFINITIVA: Usar SQL raw con strings YYYY-MM-DD para garantizar consistencia total
      // PostgreSQL interpreta los strings directamente como DATE sin conversión de timezone
      const monthStatements = await prisma.$queryRaw<Array<{
        id: string;
        date: Date;
        ventanaId: string | null;
        bancaId: string | null;
        totalPaid: number;
        totalCollected: number;
        remainingBalance: number;
      }>>`
        SELECT 
          id,
          date,
          "ventanaId",
          "bancaId",
          "totalPaid",
          "totalCollected",
          "remainingBalance"
        FROM "AccountStatement"
        WHERE date >= ${monthStartStr}::date
          AND date <= ${monthEndStr}::date
          AND "vendedorId" IS NULL
          ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = ${filters.ventanaId}::uuid` : Prisma.sql`AND "ventanaId" IS NOT NULL`}
          ${filters.bancaId ? Prisma.sql`AND "bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
      `;

      // Obtener collections del mes
      // ✅ SOLUCIÓN DEFINITIVA: Usar SQL raw con strings YYYY-MM-DD para garantizar consistencia total
      // PostgreSQL interpreta los strings directamente como DATE sin conversión de timezone
      const monthCollections = await prisma.$queryRaw<Array<{
        ventanaId: string | null;
        amount: number;
      }>>`
        SELECT 
          "ventanaId",
          amount
        FROM "AccountPayment"
        WHERE date >= ${monthStartStr}::date
          AND date <= ${monthEndStr}::date
          AND "vendedorId" IS NULL
          AND "isReversed" = false
          AND type = 'collection'
          ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = ${filters.ventanaId}::uuid` : Prisma.sql`AND "ventanaId" IS NOT NULL`}
          ${filters.bancaId ? Prisma.sql`AND "bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
      `;

      // Mapear datos del mes por ventana
      const monthAggregated = new Map<string, { totalSales: number; totalPayouts: number; totalListeroCommission: number; totalVendedorCommission: number; totalPaid: number; totalCollected: number }>();

      // ✅ DEBUG: Log para verificar qué datos estamos obteniendo
      logger.info({
        layer: 'service',
        action: 'MONTHLY_ACCUMULATED_DEBUG',
        payload: {
          monthStartStr,
          monthEndStr,
          monthVentanaDataCount: monthVentanaData.length,
          monthStatementsCount: monthStatements.length,
          monthCollectionsCount: monthCollections.length,
          monthVentanaDataSample: monthVentanaData.slice(0, 3).map(v => ({
            ventanaId: v.ventana_id?.substring(0, 8),
            totalSales: v.total_sales,
            totalPayouts: v.total_payouts,
          })),
        },
      });

      // Procesar datos de ventanas del mes
      for (const ventanaRow of monthVentanaData) {
        const ventanaId = ventanaRow.ventana_id;
        monthAggregated.set(ventanaId, {
          totalSales: Number(ventanaRow.total_sales) || 0,
          totalPayouts: Number(ventanaRow.total_payouts) || 0,
          totalListeroCommission: Number(ventanaRow.listero_commission_snapshot) || Number(ventanaRow.commission_ventana_raw) || 0,
          totalVendedorCommission: Number(ventanaRow.commission_user) || 0,
          totalPaid: 0,
          totalCollected: 0,
        });
      }

      // Agregar pagos del mes
      for (const statement of monthStatements) {
        if (!statement.ventanaId) continue;
        const entry = monthAggregated.get(statement.ventanaId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalPaid += statement.totalPaid ?? 0;
        monthAggregated.set(statement.ventanaId, entry);
      }

      // Agregar cobros del mes
      for (const collection of monthCollections) {
        if (!collection.ventanaId) continue;
        const entry = monthAggregated.get(collection.ventanaId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalCollected += collection.amount ?? 0;
        monthAggregated.set(collection.ventanaId, entry);
      }

      // Calcular saldoAHoy para cada ventana
      // Balance: Ventas - Premios - Comisión Listero
      // Comisión Vendedor es SOLO informativa, no se resta del balance
      // ✅ NUEVO: Incluir saldo final del mes anterior (batch - una sola consulta)
      // ✅ CORREGIDO: Usar crDateService para obtener el mes efectivo en formato YYYY-MM
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      
      // ✅ CRÍTICO: Obtener TODAS las ventanas que están en aggregated (período filtrado)
      // no solo las que tienen datos en el mes actual, para incluir saldo del mes anterior
      const allVentanaIds = new Set([
        ...Array.from(aggregated.keys()),
        ...Array.from(monthAggregated.keys()),
      ]);
      
      const previousMonthBalances = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "ventana",
        Array.from(allVentanaIds),
        filters.bancaId
      );
      
      // ✅ CRÍTICO: Calcular saldoAHoy para TODAS las ventanas
      // Primero procesar ventanas con datos del mes actual
      for (const [ventanaId, monthEntry] of monthAggregated.entries()) {
        // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
        const previousMonthBalance = Number(previousMonthBalances.get(ventanaId) || 0);
        const baseBalance = monthEntry.totalSales - monthEntry.totalPayouts - monthEntry.totalListeroCommission;
        // Sumar saldo del mes anterior al acumulado del mes actual
        const saldoAHoy = previousMonthBalance + baseBalance - monthEntry.totalCollected + monthEntry.totalPaid;
        
        // ✅ DEBUG: Log para verificar el cálculo
        logger.info({
          layer: 'service',
          action: 'MONTHLY_ACCUMULATED_CALCULATION_DEBUG',
          payload: {
            ventanaId: ventanaId.substring(0, 8),
            previousMonthBalance,
            monthEntry: {
              totalSales: monthEntry.totalSales,
              totalPayouts: monthEntry.totalPayouts,
              totalListeroCommission: monthEntry.totalListeroCommission,
              totalPaid: monthEntry.totalPaid,
              totalCollected: monthEntry.totalCollected,
            },
            baseBalance,
            saldoAHoy,
          },
        });
        
        monthSaldoByVentana.set(ventanaId, saldoAHoy);
      }
      
      // ✅ CRÍTICO: Incluir también ventanas que solo tienen saldo del mes anterior
      // pero no tienen datos en el mes actual (para que aparezcan en monthlyAccumulated)
      // IMPORTANTE: Esto asegura que ventanas con saldo anterior pero sin actividad del mes actual
      // también tengan su saldo a hoy calculado
      for (const ventanaId of allVentanaIds) {
        if (!monthSaldoByVentana.has(ventanaId)) {
          // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
          const previousMonthBalance = Number(previousMonthBalances.get(ventanaId) || 0);
          // Si solo tiene saldo del mes anterior, ese es su saldo a hoy
          monthSaldoByVentana.set(ventanaId, previousMonthBalance);
        }
      }
      
    }

    // ✅ NUEVO: Verificar si el período filtrado es el mes completo
    // Si es así, el remainingBalance del período debe ser igual al monthlyAccumulated.remainingBalance
    const monthRangeCheck2 = resolveDateRange('month');
    const todayRangeCheck2 = resolveDateRange('today');
    const isMonthComplete2 = 
      filters.fromDate.getTime() === monthRangeCheck2.fromAt.getTime() &&
      filters.toDate.getTime() === todayRangeCheck2.toAt.getTime();

    // ✅ NUEVO: Obtener saldo del mes anterior para el período filtrado (si incluye el día 1)
    // El saldo del mes anterior es un movimiento más, como un pago, que debe incluirse en el balance del período
    const periodPreviousMonthBalances = new Map<string, number>();
    const firstDayOfMonth = new Date(filters.fromDate.getFullYear(), filters.fromDate.getMonth(), 1);
    const periodIncludesFirstDay = filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime();
    
    if (periodIncludesFirstDay) {
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      const allVentanaIdsForPeriod = Array.from(aggregated.keys());
      const previousMonthBalancesForPeriod = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIdsForPeriod,
        filters.bancaId
      );
      for (const [ventanaId, balance] of previousMonthBalancesForPeriod.entries()) {
        periodPreviousMonthBalances.set(ventanaId, Number(balance || 0));
      }
    }

    const byVentana = Array.from(aggregated.values())
      .map((entry) => {
        const totalPaid = entry.totalPaid;
        const totalCollected = entry.totalCollected;
        const totalPaidToCustomer = entry.totalPaidToCustomer;
        // Balance: Ventas - Premios - Comisión Listero
        // Comisión Vendedor es SOLO informativa, no se resta del balance
        const baseBalance = entry.totalSales - entry.totalPayouts - entry.totalListeroCommission;
        // ✅ CRÍTICO: El saldo del mes anterior es un movimiento más (como un pago) que debe incluirse en el balance del período
        // Solo si el período incluye el día 1 del mes
        const previousMonthBalance = periodPreviousMonthBalances.get(entry.ventanaId) || 0;
        const periodRemainingBalance = previousMonthBalance + baseBalance - entry.totalCollected + entry.totalPaid;
        
        // ✅ CRÍTICO: Si el período es el mes completo, usar el saldo acumulado mensual (que incluye saldo del mes anterior)
        // Si el período es un día específico, usar solo el balance del período (que ya incluye el saldo del mes anterior si es el día 1)
        const monthlyAccumulatedBalance = monthSaldoByVentana.get(entry.ventanaId) ?? 0;
        const recalculatedRemainingBalance = isMonthComplete2
          ? monthlyAccumulatedBalance 
          : periodRemainingBalance;
        
        // ✅ CRÍTICO: amount debe usar el remainingBalance recalculado
        const amount = recalculatedRemainingBalance > 0 ? recalculatedRemainingBalance : 0;

        return {
          ventanaId: entry.ventanaId,
          ventanaName: entry.ventanaName,
          totalSales: entry.totalSales,
          totalPayouts: entry.totalPayouts,
          listeroCommission: entry.totalListeroCommission, // ✅ REQUERIDO: Campo individual
          vendedorCommission: entry.totalVendedorCommission, // ✅ REQUERIDO: Campo individual
          totalListeroCommission: entry.totalListeroCommission, // ✅ Mantener para compatibilidad
          totalVendedorCommission: entry.totalVendedorCommission, // ✅ Mantener para compatibilidad
          totalPaid,
          totalPaidOut: totalPaid,
          totalCollected,
          totalPaidToCustomer,
          amount, // ✅ Usa remainingBalance recalculado
          remainingBalance: recalculatedRemainingBalance, // ✅ Recalculado según rol (período filtrado)
          monthlyAccumulated: {
            remainingBalance: monthSaldoByVentana.get(entry.ventanaId) ?? 0, // ✅ NUEVO: Saldo a Hoy (mes completo, inmutable)
          },
          isActive: entry.isActive,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const totalAmount = byVentana.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVentana,
    };
  },

  /**
   * Calcula CxC agrupado por vendedor
   * Similar a calculateCxC pero agrupa por vendedorId en lugar de ventanaId
   */
  async calculateCxCByVendedor(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStart(fromDateStr);
    const rangeEnd = parseDateEnd(toDateStr);
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

    // ✅ CRÍTICO: Obtener datos directamente desde tickets/jugadas agrupados por vendedor
    const vendedorData = await prisma.$queryRaw<
      Array<{
        vendedor_id: string;
        vendedor_name: string;
        vendedor_code: string | null;
        ventana_id: string | null;
        ventana_name: string | null;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        commission_user: number;
        commission_ventana_raw: number;
        listero_commission_snapshot: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."vendedorId",
            t."ventanaId",
            t."sorteoId",
            t."totalAmount",
            t."totalPayout"
          FROM "Ticket" t
          WHERE ${baseFilters}
            AND t."vendedorId" IS NOT NULL
        ),
        sales_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        ),
        commissions_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        )
        SELECT
          u.id AS vendedor_id,
          u.name AS vendedor_name,
          u.code AS vendedor_code,
          u."ventanaId" AS ventana_id,
          v.name AS ventana_name,
          u."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw,
          COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot
        FROM "User" u
        LEFT JOIN sales_per_vendedor sp ON sp.vendedor_id = u.id
        LEFT JOIN commissions_per_vendedor cp ON cp.vendedor_id = u.id
        LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
          ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        ORDER BY total_sales DESC
      `
    );

    const where: Prisma.AccountStatementWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: { not: null },
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }

    if (filters.bancaId) {
      where.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const statements = await prisma.accountStatement.findMany({
      where,
      include: {
        vendedor: {
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
            ventanaId: true,
          },
        },
        ventana: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    const vendedorInfoMap = new Map(
      vendedorData.map((v) => [v.vendedor_id, { name: v.vendedor_name, code: v.vendedor_code, ventanaId: v.ventana_id, ventanaName: v.ventana_name, isActive: v.is_active }])
    );

    const aggregated = new Map<
      string,
      {
        vendedorId: string;
        vendedorName: string;
        vendedorCode?: string;
        ventanaId?: string;
        ventanaName?: string;
        isActive: boolean;
        totalSales: number;
        totalPayouts: number;
        totalListeroCommission: number;
        totalVendedorCommission: number;
        totalPaid: number;
        totalCollected: number;
        totalPaidToCustomer: number;
        remainingBalance: number;
      }
    >();

    const ensureEntry = (
      vendedorId: string,
      fallbackName?: string,
      fallbackCode?: string | null,
      fallbackVentanaId?: string | null,
      fallbackVentanaName?: string | null,
      fallbackIsActive?: boolean
    ) => {
      let entry = aggregated.get(vendedorId);
      if (!entry) {
        const info = vendedorInfoMap.get(vendedorId);
        entry = {
          vendedorId,
          vendedorName: fallbackName ?? info?.name ?? "Sin nombre",
          vendedorCode: fallbackCode ?? info?.code ?? undefined,
          ventanaId: fallbackVentanaId ?? info?.ventanaId ?? undefined,
          ventanaName: fallbackVentanaName ?? info?.ventanaName ?? undefined,
          isActive: fallbackIsActive ?? info?.isActive ?? true,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          remainingBalance: 0,
        };
        aggregated.set(vendedorId, entry);
      } else {
        if (fallbackName && entry.vendedorName !== fallbackName) {
          entry.vendedorName = fallbackName;
        }
        if (typeof fallbackIsActive === "boolean") {
          entry.isActive = fallbackIsActive;
        }
      }
      return entry;
    };

    // ✅ CRÍTICO: Usar datos calculados directamente desde tickets/jugadas
    for (const vendedorRow of vendedorData) {
      const vendedorId = vendedorRow.vendedor_id;
      const entry = ensureEntry(
        vendedorId,
        vendedorRow.vendedor_name,
        vendedorRow.vendedor_code,
        vendedorRow.ventana_id,
        vendedorRow.ventana_name,
        vendedorRow.is_active
      );

      entry.totalSales = Number(vendedorRow.total_sales) || 0;
      entry.totalPayouts = Number(vendedorRow.total_payouts) || 0;
      entry.totalListeroCommission = Number(vendedorRow.listero_commission_snapshot) || Number(vendedorRow.commission_ventana_raw) || 0;
      entry.totalVendedorCommission = Number(vendedorRow.commission_user) || 0;
    }

    // Obtener totalPaid desde AccountStatement
    for (const statement of statements) {
      if (!statement.vendedorId) continue;
      const key = statement.vendedorId;
      const existing = ensureEntry(
        key,
        statement.vendedor?.name,
        statement.vendedor?.code ?? null,
        statement.vendedor?.ventanaId ?? null,
        statement.ventana?.name ?? null,
        statement.vendedor?.isActive ?? undefined
      );

      existing.totalPaid += statement.totalPaid ?? 0;
    }

    const accountPaymentWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: { not: null },
      isReversed: false,
      type: "collection",
    };
    if (filters.ventanaId) {
      accountPaymentWhere.ventanaId = filters.ventanaId;
    }
    if (filters.bancaId) {
      // ✅ CRÍTICO: AccountPayment tiene bancaId directamente, no usar relación ventana
      accountPaymentWhere.bancaId = filters.bancaId;
    }

    const collections = await prisma.accountPayment.findMany({
      where: accountPaymentWhere,
      select: {
        vendedorId: true,
        amount: true,
      },
    });

    for (const collection of collections) {
      if (!collection.vendedorId) continue;
      const entry = ensureEntry(collection.vendedorId);
      entry.totalCollected += collection.amount ?? 0;
    }

    const ticketRelationFilter: Prisma.TicketWhereInput = {
      deletedAt: null,
      // ✅ FIX: vendedorId es requerido en schema, no necesitamos filtrar por "not null"
    };
    if (filters.ventanaId) {
      ticketRelationFilter.ventanaId = filters.ventanaId;
    }
    if (filters.bancaId) {
      ticketRelationFilter.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const ticketPayments = await prisma.ticketPayment.findMany({
      where: {
        isReversed: false,
        paymentDate: {
          gte: rangeStart,
          lte: rangeEnd,
        },
        ticket: {
          is: ticketRelationFilter,
        },
      },
      select: {
        amountPaid: true,
        ticket: {
          select: {
            vendedorId: true,
          },
        },
      },
    });

    for (const payment of ticketPayments) {
      const vendedorId = payment.ticket?.vendedorId;
      if (!vendedorId) continue;
      const entry = ensureEntry(vendedorId);
      entry.totalPaidToCustomer += payment.amountPaid ?? 0;
    }

    // ✅ NUEVO: Verificar si el período filtrado es el mes completo
    // Si es así, el remainingBalance del período debe ser igual al monthlyAccumulated.remainingBalance
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const isMonthComplete = 
      filters.fromDate.getTime() === monthRangeCheck.fromAt.getTime() &&
      filters.toDate.getTime() === todayRangeCheck.toAt.getTime();

    // ✅ NUEVO: Calcular saldoAHoy (acumulado desde inicio del mes hasta hoy) para cada vendedor
    const monthSaldoByVendedor = new Map<string, number>();
    {
      // ✅ CORREGIDO: Usar resolveDateRange para calcular correctamente las fechas en CR timezone
      // Esto asegura consistencia entre local y producción (Render)
      const monthRange = resolveDateRange('month'); // Primer día del mes en CR
      const todayRange = resolveDateRange('today'); // Fin del día de hoy en CR
      
      const monthStart = monthRange.fromAt; // Primer día del mes en CR (06:00:00 UTC)
      const monthEnd = todayRange.toAt; // Fin del día de hoy en CR (23:59:59.999 CR = 05:59:59.999 UTC del día siguiente)

      // Convertir a strings de fecha para filtros usando crDateService
      // ✅ CRÍTICO: Usar dateRangeUTCToCRStrings para obtener correctamente el día de fin
      // porque toAt puede ser del día siguiente en UTC pero representa el fin del día anterior en CR
      const { startDateCRStr: monthStartStr, endDateCRStr: monthEndStr } = crDateService.dateRangeUTCToCRStrings(monthStart, monthEnd);

      const monthBaseFilters = buildTicketBaseFilters(
        "t",
        { ...filters, fromDate: monthStart, toDate: monthEnd },
        monthStartStr,
        monthEndStr
      );

      const monthVendedorData = await prisma.$queryRaw<Array<{ vendedor_id: string; total_sales: number; total_payouts: number; commission_user: number; commission_ventana_raw: number; listero_commission_snapshot: number }>>(
        Prisma.sql`SELECT u.id AS vendedor_id, COALESCE(sp.total_sales, 0) AS total_sales, COALESCE(sp.total_payouts, 0) AS total_payouts, COALESCE(cp.commission_user, 0) AS commission_user, COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw, COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot FROM "User" u LEFT JOIN (SELECT t."vendedorId" AS vendedor_id, COALESCE(SUM(j.amount), 0) AS total_sales, COALESCE(SUM(DISTINCT t."totalPayout"), 0) AS total_payouts FROM "Ticket" t JOIN "Jugada" j ON j."ticketId" = t.id WHERE ${monthBaseFilters} AND t."vendedorId" IS NOT NULL AND j."deletedAt" IS NULL AND j."isExcluded" = false GROUP BY t."vendedorId") sp ON sp.vendedor_id = u.id LEFT JOIN (SELECT t."vendedorId" AS vendedor_id, COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user, COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw, COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot FROM "Ticket" t JOIN "Jugada" j ON j."ticketId" = t.id WHERE ${monthBaseFilters} AND t."vendedorId" IS NOT NULL AND j."deletedAt" IS NULL AND j."isExcluded" = false GROUP BY t."vendedorId") cp ON cp.vendedor_id = u.id WHERE u."isActive" = true AND u.role = 'VENDEDOR' ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}`
      );

      // ✅ Vendedores funcionan correctamente, mantener consulta original
      const monthStatements = await prisma.accountStatement.findMany({
        where: {
          date: { gte: monthStart, lte: monthEnd },
          vendedorId: { not: null },
          ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
          ...(filters.bancaId ? { bancaId: filters.bancaId } : {}),
        },
      });

      // ✅ Vendedores funcionan correctamente, mantener consulta original
      const monthCollections = await prisma.accountPayment.findMany({
        where: {
          date: { gte: monthStart, lte: monthEnd },
          vendedorId: { not: null },
          isReversed: false,
          type: "collection",
          ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
          ...(filters.bancaId ? { bancaId: filters.bancaId } : {}),
        },
        select: {
          vendedorId: true,
          amount: true,
        },
      });

      const monthAggregated = new Map<string, { totalSales: number; totalPayouts: number; totalListeroCommission: number; totalVendedorCommission: number; totalPaid: number; totalCollected: number }>();

      for (const vendedorRow of monthVendedorData) {
        const vendedorId = vendedorRow.vendedor_id;
        monthAggregated.set(vendedorId, {
          totalSales: Number(vendedorRow.total_sales) || 0,
          totalPayouts: Number(vendedorRow.total_payouts) || 0,
          totalListeroCommission: Number(vendedorRow.listero_commission_snapshot) || Number(vendedorRow.commission_ventana_raw) || 0,
          totalVendedorCommission: Number(vendedorRow.commission_user) || 0,
          totalPaid: 0,
          totalCollected: 0,
        });
      }

      for (const statement of monthStatements) {
        if (!statement.vendedorId) continue;
        const entry = monthAggregated.get(statement.vendedorId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalPaid += statement.totalPaid ?? 0;
        monthAggregated.set(statement.vendedorId, entry);
      }

      for (const collection of monthCollections) {
        if (!collection.vendedorId) continue;
        const entry = monthAggregated.get(collection.vendedorId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalCollected += collection.amount ?? 0;
        monthAggregated.set(collection.vendedorId, entry);
      }

      // ✅ NUEVO: Incluir saldo final del mes anterior (batch - una sola consulta)
      // ✅ CORREGIDO: Usar crDateService para obtener el mes efectivo en formato YYYY-MM
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      
      // ✅ CRÍTICO: Obtener TODOS los vendedores que están en aggregated (período filtrado)
      // no solo los que tienen datos en el mes actual, para incluir saldo del mes anterior
      const allVendedorIds = new Set([
        ...Array.from(aggregated.keys()),
        ...Array.from(monthAggregated.keys()),
      ]);
      
      const previousMonthBalances = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "vendedor",
        Array.from(allVendedorIds),
        filters.bancaId
      );
      
      // ✅ CRÍTICO: Calcular saldoAHoy para TODOS los vendedores
      // Primero procesar vendedores con datos del mes actual
      for (const [vendedorId, monthEntry] of monthAggregated.entries()) {
        // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
        const previousMonthBalance = Number(previousMonthBalances.get(vendedorId) || 0);
        const baseBalance = monthEntry.totalSales - monthEntry.totalPayouts - monthEntry.totalVendedorCommission;
        // Sumar saldo del mes anterior al acumulado del mes actual
        const saldoAHoy = previousMonthBalance + baseBalance - monthEntry.totalCollected + monthEntry.totalPaid;
        monthSaldoByVendedor.set(vendedorId, saldoAHoy);
      }
      
      // ✅ CRÍTICO: Incluir también vendedores que solo tienen saldo del mes anterior
      // pero no tienen datos en el mes actual (para que aparezcan en monthlyAccumulated)
      // IMPORTANTE: Esto asegura que vendedores con saldo anterior pero sin actividad del mes actual
      // también tengan su saldo a hoy calculado
      for (const vendedorId of allVendedorIds) {
        if (!monthSaldoByVendedor.has(vendedorId)) {
          // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
          const previousMonthBalance = Number(previousMonthBalances.get(vendedorId) || 0);
          // Si solo tiene saldo del mes anterior, ese es su saldo a hoy
          monthSaldoByVendedor.set(vendedorId, previousMonthBalance);
        }
      }
    }

    // ✅ NUEVO: Obtener saldo del mes anterior para el período filtrado (si incluye el día 1)
    // El saldo del mes anterior es un movimiento más, como un pago, que debe incluirse en el balance del período
    const periodPreviousMonthBalances = new Map<string, number>();
    const firstDayOfMonth = new Date(filters.fromDate.getFullYear(), filters.fromDate.getMonth(), 1);
    const periodIncludesFirstDay = filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime();
    
    if (periodIncludesFirstDay) {
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      const allVendedorIdsForPeriod = Array.from(aggregated.keys());
      const previousMonthBalancesForPeriod = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIdsForPeriod,
        filters.bancaId
      );
      for (const [vendedorId, balance] of previousMonthBalancesForPeriod.entries()) {
        periodPreviousMonthBalances.set(vendedorId, Number(balance || 0));
      }
    }

    const byVendedor = Array.from(aggregated.values())
      .map((entry) => {
        const totalPaid = entry.totalPaid;
        const totalCollected = entry.totalCollected;
        const totalPaidToCustomer = entry.totalPaidToCustomer;
        // Balance: Ventas - Premios - Comisión Vendedor
        const baseBalance = entry.totalSales - entry.totalPayouts - entry.totalVendedorCommission;
        // ✅ CRÍTICO: El saldo del mes anterior es un movimiento más (como un pago) que debe incluirse en el balance del período
        // Solo si el período incluye el día 1 del mes
        const previousMonthBalance = periodPreviousMonthBalances.get(entry.vendedorId) || 0;
        const periodRemainingBalance = previousMonthBalance + baseBalance - entry.totalCollected + entry.totalPaid;
        
        // ✅ CRÍTICO: Si el período es el mes completo, usar el saldo acumulado mensual (que incluye saldo del mes anterior)
        // Si el período es un día específico, usar solo el balance del período (que ya incluye el saldo del mes anterior si es el día 1)
        const monthlyAccumulatedBalance = monthSaldoByVendedor.get(entry.vendedorId) ?? 0;
        const recalculatedRemainingBalance = isMonthComplete 
          ? monthlyAccumulatedBalance 
          : periodRemainingBalance;
        
        const amount = recalculatedRemainingBalance > 0 ? recalculatedRemainingBalance : 0;

        return {
          vendedorId: entry.vendedorId,
          vendedorName: entry.vendedorName,
          vendedorCode: entry.vendedorCode,
          ventanaId: entry.ventanaId,
          ventanaName: entry.ventanaName,
          totalSales: entry.totalSales,
          totalPayouts: entry.totalPayouts,
          listeroCommission: entry.totalListeroCommission,
          vendedorCommission: entry.totalVendedorCommission,
          totalListeroCommission: entry.totalListeroCommission,
          totalVendedorCommission: entry.totalVendedorCommission,
          totalPaid,
          totalPaidOut: totalPaid,
          totalCollected,
          totalPaidToCustomer,
          amount,
          remainingBalance: recalculatedRemainingBalance,
          monthlyAccumulated: {
            remainingBalance: monthSaldoByVendedor.get(entry.vendedorId) ?? 0,
          },
          isActive: entry.isActive,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const totalAmount = byVendedor.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVendedor,
    };
  },

  /**
   * Calcula CxP: Monto que banco debe a ventana por overpayment
   * CxP ocurre cuando ventana paga más de lo que vendió
   */
  async calculateCxP(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const dimension = filters.cxcDimension || 'ventana';

    // ✅ NUEVO: Si dimension='vendedor', ejecutar lógica específica para vendedores
    if (dimension === 'vendedor') {
      return this.calculateCxPByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStart(fromDateStr);
    const rangeEnd = parseDateEnd(toDateStr);
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

    // ✅ CRÍTICO: Calcular comisiones desde políticas (igual que calculateGanancia)
    const {
      totalVentanaCommission,
      extrasByVentana,
    } = await computeVentanaCommissionFromPolicies(filters);

    // ✅ CRÍTICO: Obtener datos directamente desde tickets/jugadas (igual que calculateGanancia)
    const ventanaData = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        commission_user: number;
        commission_ventana_raw: number;
        listero_commission_snapshot: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."ventanaId",
            t."sorteoId",
            t."vendedorId",
            t."totalAmount",
            t."totalPayout"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        sales_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        ),
        commissions_per_ventana AS (
          SELECT
            t."ventanaId" AS ventana_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."ventanaId"
        )
        SELECT
          v.id AS ventana_id,
          v.name AS ventana_name,
          v."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw,
          COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot
        FROM "Ventana" v
        LEFT JOIN sales_per_ventana sp ON sp.ventana_id = v.id
        LEFT JOIN commissions_per_ventana cp ON cp.ventana_id = v.id
        WHERE v."isActive" = true
          ${filters.ventanaId ? Prisma.sql`AND v.id = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        ORDER BY total_sales DESC
      `
    );

    const where: Prisma.AccountStatementWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: null,
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    } else {
      where.ventanaId = { not: null };
    }

    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      where.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const statements = await prisma.accountStatement.findMany({
      where,
      include: {
        ventana: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    // Filtrar por banca si está disponible
    const ventanaWhere: any = { isActive: true };
    if (filters.bancaId) {
      ventanaWhere.bancaId = filters.bancaId;
    }
    const ventanas = await prisma.ventana.findMany({
      where: ventanaWhere,
      select: { id: true, name: true, isActive: true },
    });
    const ventanaInfoMap = new Map(
      ventanas.map((v) => [v.id, { name: v.name, isActive: v.isActive }])
    );

    const aggregated = new Map<
      string,
      {
        ventanaId: string;
        ventanaName: string;
        isActive: boolean;
        totalSales: number;
        totalPayouts: number;
        totalListeroCommission: number;
        totalVendedorCommission: number;
        totalPaid: number;
        totalCollected: number;
        totalPaidToCustomer: number;
        totalPaidToVentana: number;
        remainingBalance: number;
      }
    >();

    const ensureEntry = (
      ventanaId: string,
      fallbackName?: string,
      fallbackIsActive?: boolean
    ) => {
      let entry = aggregated.get(ventanaId);
      if (!entry) {
        const info = ventanaInfoMap.get(ventanaId);
        entry = {
          ventanaId,
          ventanaName: fallbackName ?? info?.name ?? "Sin nombre",
          isActive: fallbackIsActive ?? info?.isActive ?? true,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          totalPaidToVentana: 0,
          remainingBalance: 0,
        };
        aggregated.set(ventanaId, entry);
      } else {
        if (fallbackName && entry.ventanaName !== fallbackName) {
          entry.ventanaName = fallbackName;
        }
        if (typeof fallbackIsActive === "boolean") {
          entry.isActive = fallbackIsActive;
        }
      }
      return entry;
    };

    // ✅ CRÍTICO: Usar datos calculados directamente desde tickets/jugadas
    for (const ventanaRow of ventanaData) {
      const ventanaId = ventanaRow.ventana_id;
      const entry = ensureEntry(ventanaId);

      entry.totalSales = Number(ventanaRow.total_sales) || 0;
      entry.totalPayouts = Number(ventanaRow.total_payouts) || 0;

      // ✅ CORREGIDO: Usar SIEMPRE el snapshot de comisión del listero
      // Esto asegura consistencia entre período filtrado y mes completo
      // No recalcular desde políticas (causa discrepancias de 44 colones)
      entry.totalListeroCommission = Number(ventanaRow.listero_commission_snapshot) || Number(ventanaRow.commission_ventana_raw) || 0;
      entry.totalVendedorCommission = Number(ventanaRow.commission_user) || 0;
    }

    // Obtener totalPaid desde AccountStatement (ya está calculado correctamente)
    for (const statement of statements) {
      if (!statement.ventanaId) continue;
      const key = statement.ventanaId;
      const existing = ensureEntry(
        key,
        statement.ventana?.name,
        statement.ventana?.isActive ?? undefined
      );

      existing.totalPaid += statement.totalPaid ?? 0;
    }

    const accountPaymentWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: null,
      isReversed: false,
      type: "collection",
    };
    if (filters.ventanaId) {
      accountPaymentWhere.ventanaId = filters.ventanaId;
    } else {
      accountPaymentWhere.ventanaId = { not: null };
    }
    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      // ✅ CRÍTICO: AccountPayment tiene bancaId directamente, no usar relación ventana
      accountPaymentWhere.bancaId = filters.bancaId;
    }

    const collections = await prisma.accountPayment.findMany({
      where: accountPaymentWhere,
      select: {
        ventanaId: true,
        amount: true,
      },
    });

    for (const collection of collections) {
      if (!collection.ventanaId) continue;
      const entry = ensureEntry(collection.ventanaId);
      entry.totalCollected += collection.amount ?? 0;
    }

    const ticketRelationFilter: Prisma.TicketWhereInput = {
      deletedAt: null,
    };
    if (filters.ventanaId) {
      ticketRelationFilter.ventanaId = filters.ventanaId;
    }
    // Filtrar por banca activa si está disponible
    if (filters.bancaId) {
      ticketRelationFilter.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const ticketPayments = await prisma.ticketPayment.findMany({
      where: {
        isReversed: false,
        paymentDate: {
          gte: rangeStart,
          lte: rangeEnd,
        },
        ticket: {
          is: ticketRelationFilter,
        },
      },
      select: {
        amountPaid: true,
        ticket: {
          select: {
            ventanaId: true,
          },
        },
      },
    });

    for (const payment of ticketPayments) {
      const ventanaId = payment.ticket?.ventanaId;
      if (!ventanaId) continue;
      const entry = ensureEntry(ventanaId);
      entry.totalPaidToCustomer += payment.amountPaid ?? 0;
    }

    for (const ventana of ventanas) {
      ensureEntry(ventana.id, ventana.name, ventana.isActive);
    }

    // ✅ NUEVO: Verificar si el período filtrado es el mes completo
    // Si es así, el remainingBalance del período debe ser igual al monthlyAccumulated.remainingBalance
    const monthRangeCheck3 = resolveDateRange('month');
    const todayRangeCheck3 = resolveDateRange('today');
    const isMonthComplete3 = 
      filters.fromDate.getTime() === monthRangeCheck3.fromAt.getTime() &&
      filters.toDate.getTime() === todayRangeCheck3.toAt.getTime();

    // ✅ NUEVO: Calcular saldoAHoy (acumulado del mes completo) para cada ventana en CxP
    const monthSaldoByVentana = new Map<string, number>();
    {
      // ✅ CORREGIDO: Usar resolveDateRange para calcular correctamente las fechas en CR timezone
      // Esto asegura consistencia entre local y producción (Render)
      const monthRange = resolveDateRange('month'); // Primer día del mes en CR
      const todayRange = resolveDateRange('today'); // Fin del día de hoy en CR
      
      const monthStart = monthRange.fromAt; // Primer día del mes en CR (06:00:00 UTC)
      const monthEnd = todayRange.toAt; // Fin del día de hoy en CR (23:59:59.999 CR = 05:59:59.999 UTC del día siguiente)

      // Convertir a strings de fecha para filtros usando crDateService
      // ✅ CRÍTICO: Usar dateRangeUTCToCRStrings para obtener correctamente el día de fin
      // porque toAt puede ser del día siguiente en UTC pero representa el fin del día anterior en CR
      const { startDateCRStr: monthStartStr, endDateCRStr: monthEndStr } = crDateService.dateRangeUTCToCRStrings(monthStart, monthEnd);

      const monthBaseFilters = buildTicketBaseFilters(
        "t",
        { ...filters, fromDate: monthStart, toDate: monthEnd },
        monthStartStr,
        monthEndStr
      );

      const monthVentanaData = await prisma.$queryRaw<Array<{ ventana_id: string; ventana_name: string; is_active: boolean; total_sales: number; total_payouts: number; commission_user: number; commission_ventana_raw: number; listero_commission_snapshot: number }>>(
        Prisma.sql`SELECT v.id AS ventana_id, v.name AS ventana_name, v."isActive" AS is_active, COALESCE(sp.total_sales, 0) AS total_sales, COALESCE(sp.total_payouts, 0) AS total_payouts, COALESCE(cp.commission_user, 0) AS commission_user, COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw, COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot FROM "Ventana" v LEFT JOIN (SELECT t."ventanaId" AS ventana_id, COALESCE(SUM(t."totalAmount"), 0) AS total_sales, COALESCE(SUM(t."totalPayout"), 0) AS total_payouts FROM "Ticket" t WHERE ${monthBaseFilters} GROUP BY t."ventanaId") sp ON sp.ventana_id = v.id LEFT JOIN (SELECT t."ventanaId" AS ventana_id, COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user, COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw, COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot FROM "Ticket" t JOIN "Jugada" j ON j."ticketId" = t.id WHERE ${monthBaseFilters} AND j."deletedAt" IS NULL GROUP BY t."ventanaId") cp ON cp.ventana_id = v.id WHERE v."isActive" = true ${filters.ventanaId ? Prisma.sql`AND v.id = ${filters.ventanaId}::uuid` : Prisma.empty} ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}`
      );

      // ✅ SOLUCIÓN DEFINITIVA: Usar SQL raw con strings YYYY-MM-DD para garantizar consistencia total
      const monthStatements = await prisma.$queryRaw<Array<{
        id: string;
        date: Date;
        ventanaId: string | null;
        bancaId: string | null;
        totalPaid: number;
        totalCollected: number;
        remainingBalance: number;
      }>>`
        SELECT 
          id,
          date,
          "ventanaId",
          "bancaId",
          "totalPaid",
          "totalCollected",
          "remainingBalance"
        FROM "AccountStatement"
        WHERE date >= ${monthStartStr}::date
          AND date <= ${monthEndStr}::date
          AND "vendedorId" IS NULL
          ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = ${filters.ventanaId}::uuid` : Prisma.sql`AND "ventanaId" IS NOT NULL`}
          ${filters.bancaId ? Prisma.sql`AND "bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
      `;

      // ✅ SOLUCIÓN DEFINITIVA: Usar SQL raw con strings YYYY-MM-DD para garantizar consistencia total
      const monthCollections = await prisma.$queryRaw<Array<{
        ventanaId: string | null;
        amount: number;
      }>>`
        SELECT 
          "ventanaId",
          amount
        FROM "AccountPayment"
        WHERE date >= ${monthStartStr}::date
          AND date <= ${monthEndStr}::date
          AND "vendedorId" IS NULL
          AND "isReversed" = false
          AND type = 'collection'
          ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = ${filters.ventanaId}::uuid` : Prisma.sql`AND "ventanaId" IS NOT NULL`}
          ${filters.bancaId ? Prisma.sql`AND "bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
      `;

      const monthAggregated = new Map<string, { totalSales: number; totalPayouts: number; totalListeroCommission: number; totalVendedorCommission: number; totalPaid: number; totalCollected: number }>();

      for (const ventanaRow of monthVentanaData) {
        const ventanaId = ventanaRow.ventana_id;
        monthAggregated.set(ventanaId, { totalSales: Number(ventanaRow.total_sales) || 0, totalPayouts: Number(ventanaRow.total_payouts) || 0, totalListeroCommission: Number(ventanaRow.listero_commission_snapshot) || Number(ventanaRow.commission_ventana_raw) || 0, totalVendedorCommission: Number(ventanaRow.commission_user) || 0, totalPaid: 0, totalCollected: 0 });
      }

      for (const statement of monthStatements) {
        if (!statement.ventanaId) continue;
        const entry = monthAggregated.get(statement.ventanaId) || { totalSales: 0, totalPayouts: 0, totalListeroCommission: 0, totalVendedorCommission: 0, totalPaid: 0, totalCollected: 0 };
        entry.totalPaid += statement.totalPaid ?? 0;
        monthAggregated.set(statement.ventanaId, entry);
      }

      for (const collection of monthCollections) {
        if (!collection.ventanaId) continue;
        const entry = monthAggregated.get(collection.ventanaId) || { totalSales: 0, totalPayouts: 0, totalListeroCommission: 0, totalVendedorCommission: 0, totalPaid: 0, totalCollected: 0 };
        entry.totalCollected += collection.amount ?? 0;
        monthAggregated.set(collection.ventanaId, entry);
      }

      // Balance: Ventas - Premios - Comisión Listero
      // Comisión Vendedor es SOLO informativa, no se resta del balance
      // ✅ NUEVO: Incluir saldo final del mes anterior (batch - una sola consulta)
      // ✅ CORREGIDO: Usar crDateService para obtener el mes efectivo en formato YYYY-MM
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      
      // ✅ CRÍTICO: Obtener TODAS las ventanas que están en aggregated (período filtrado)
      // no solo las que tienen datos en el mes actual, para incluir saldo del mes anterior
      const allVentanaIds = new Set([
        ...Array.from(aggregated.keys()),
        ...Array.from(monthAggregated.keys()),
      ]);
      
      const previousMonthBalances = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "ventana",
        Array.from(allVentanaIds),
        filters.bancaId
      );
      
      // ✅ CRÍTICO: Calcular saldoAHoy para TODAS las ventanas
      // Primero procesar ventanas con datos del mes actual
      for (const [ventanaId, monthEntry] of monthAggregated.entries()) {
        // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
        const previousMonthBalance = Number(previousMonthBalances.get(ventanaId) || 0);
        const baseBalance = monthEntry.totalSales - monthEntry.totalPayouts - monthEntry.totalListeroCommission;
        // Sumar saldo del mes anterior al acumulado del mes actual
        const saldoAHoy = previousMonthBalance + baseBalance - monthEntry.totalCollected + monthEntry.totalPaid;
        monthSaldoByVentana.set(ventanaId, saldoAHoy);
      }
      
      // ✅ CRÍTICO: Incluir también ventanas que solo tienen saldo del mes anterior
      // pero no tienen datos en el mes actual (para que aparezcan en monthlyAccumulated)
      // IMPORTANTE: Esto asegura que ventanas con saldo anterior pero sin actividad del mes actual
      // también tengan su saldo a hoy calculado
      for (const ventanaId of allVentanaIds) {
        if (!monthSaldoByVentana.has(ventanaId)) {
          // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
          const previousMonthBalance = Number(previousMonthBalances.get(ventanaId) || 0);
          // Si solo tiene saldo del mes anterior, ese es su saldo a hoy
          monthSaldoByVentana.set(ventanaId, previousMonthBalance);
        }
      }
    }

    // ✅ NUEVO: Obtener saldo del mes anterior para el período filtrado (si incluye el día 1)
    // El saldo del mes anterior es un movimiento más, como un pago, que debe incluirse en el balance del período
    const periodPreviousMonthBalances = new Map<string, number>();
    const firstDayOfMonth = new Date(filters.fromDate.getFullYear(), filters.fromDate.getMonth(), 1);
    const periodIncludesFirstDay = filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime();
    
    if (periodIncludesFirstDay) {
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      const allVentanaIdsForPeriod = Array.from(aggregated.keys());
      const previousMonthBalancesForPeriod = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIdsForPeriod,
        filters.bancaId
      );
      for (const [ventanaId, balance] of previousMonthBalancesForPeriod.entries()) {
        periodPreviousMonthBalances.set(ventanaId, Number(balance || 0));
      }
    }

    const byVentana = Array.from(aggregated.values())
      .map((entry) => {
        const totalPaid = entry.totalPaid;
        const totalCollected = entry.totalCollected;
        const totalPaidToCustomer = entry.totalPaidToCustomer;
        const totalPaidToVentana = entry.totalPaidToVentana || 0; // Para CxP según documento
        // Balance: Ventas - Premios - Comisión Listero
        // Comisión Vendedor es SOLO informativa, no se resta del balance
        const baseBalance = entry.totalSales - entry.totalPayouts - entry.totalListeroCommission;
        // ✅ CRÍTICO: El saldo del mes anterior es un movimiento más (como un pago) que debe incluirse en el balance del período
        // Solo si el período incluye el día 1 del mes
        const previousMonthBalance = periodPreviousMonthBalances.get(entry.ventanaId) || 0;
        const periodRemainingBalance = previousMonthBalance + baseBalance - entry.totalCollected + entry.totalPaid;
        
        // ✅ CRÍTICO: Si el período es el mes completo, usar el saldo acumulado mensual (que incluye saldo del mes anterior)
        // Si el período es un día específico, usar solo el balance del período (que ya incluye el saldo del mes anterior si es el día 1)
        const monthlyAccumulatedBalance = monthSaldoByVentana.get(entry.ventanaId) ?? 0;
        const recalculatedRemainingBalance = isMonthComplete3 
          ? monthlyAccumulatedBalance 
          : periodRemainingBalance;
        
        // ✅ CRÍTICO: amount debe usar el remainingBalance recalculado (valor absoluto si es negativo)
        const amount = recalculatedRemainingBalance < 0 ? Math.abs(recalculatedRemainingBalance) : 0;

        return {
          ventanaId: entry.ventanaId,
          ventanaName: entry.ventanaName,
          totalSales: entry.totalSales,
          totalPayouts: entry.totalPayouts,
          listeroCommission: entry.totalListeroCommission, // ✅ REQUERIDO: Campo individual
          vendedorCommission: entry.totalVendedorCommission, // ✅ REQUERIDO: Campo individual
          totalListeroCommission: entry.totalListeroCommission, // ✅ Mantener para compatibilidad
          totalVendedorCommission: entry.totalVendedorCommission, // ✅ Mantener para compatibilidad
          totalPaid,
          totalPaidOut: totalPaid,
          totalCollected,
          totalPaidToCustomer,
          totalPaidToVentana,
          amount, // ✅ Usa remainingBalance recalculado
          remainingBalance: recalculatedRemainingBalance, // ✅ Recalculado según rol (período filtrado)
          monthlyAccumulated: {
            remainingBalance: monthSaldoByVentana.get(entry.ventanaId) ?? 0, // ✅ NUEVO: Saldo a Hoy (mes completo, inmutable)
          },
          isActive: entry.isActive,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    const totalAmount = byVentana.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVentana,
    };
  },

  /**
   * Calcula CxP agrupado por vendedor
   * Similar a calculateCxP pero agrupa por vendedorId en lugar de ventanaId
   */
  async calculateCxPByVendedor(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStart(fromDateStr);
    const rangeEnd = parseDateEnd(toDateStr);
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

    // ✅ CRÍTICO: Obtener datos directamente desde tickets/jugadas agrupados por vendedor
    const vendedorData = await prisma.$queryRaw<
      Array<{
        vendedor_id: string;
        vendedor_name: string;
        vendedor_code: string | null;
        ventana_id: string | null;
        ventana_name: string | null;
        is_active: boolean;
        total_sales: number;
        total_payouts: number;
        commission_user: number;
        commission_ventana_raw: number;
        listero_commission_snapshot: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."vendedorId",
            t."ventanaId",
            t."sorteoId",
            t."totalAmount",
            t."totalPayout"
          FROM "Ticket" t
          WHERE ${baseFilters}
            AND t."vendedorId" IS NOT NULL
        ),
        sales_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payouts
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        ),
        commissions_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        )
        SELECT
          u.id AS vendedor_id,
          u.name AS vendedor_name,
          u.code AS vendedor_code,
          u."ventanaId" AS ventana_id,
          v.name AS ventana_name,
          u."isActive" AS is_active,
          COALESCE(sp.total_sales, 0) AS total_sales,
          COALESCE(sp.total_payouts, 0) AS total_payouts,
          COALESCE(cp.commission_user, 0) AS commission_user,
          COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw,
          COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot
        FROM "User" u
        LEFT JOIN sales_per_vendedor sp ON sp.vendedor_id = u.id
        LEFT JOIN commissions_per_vendedor cp ON cp.vendedor_id = u.id
        LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
          ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.bancaId ? Prisma.sql`AND v."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
        ORDER BY total_sales DESC
      `
    );

    const where: Prisma.AccountStatementWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: { not: null },
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }

    if (filters.bancaId) {
      where.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const statements = await prisma.accountStatement.findMany({
      where,
      include: {
        vendedor: {
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
            ventanaId: true,
          },
        },
        ventana: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
    });

    const vendedorInfoMap = new Map(
      vendedorData.map((v) => [v.vendedor_id, { name: v.vendedor_name, code: v.vendedor_code, ventanaId: v.ventana_id, ventanaName: v.ventana_name, isActive: v.is_active }])
    );

    const aggregated = new Map<
      string,
      {
        vendedorId: string;
        vendedorName: string;
        vendedorCode?: string;
        ventanaId?: string;
        ventanaName?: string;
        isActive: boolean;
        totalSales: number;
        totalPayouts: number;
        totalListeroCommission: number;
        totalVendedorCommission: number;
        totalPaid: number;
        totalCollected: number;
        totalPaidToCustomer: number;
        totalPaidToVentana: number;
        remainingBalance: number;
      }
    >();

    const ensureEntry = (
      vendedorId: string,
      fallbackName?: string,
      fallbackCode?: string | null,
      fallbackVentanaId?: string | null,
      fallbackVentanaName?: string | null,
      fallbackIsActive?: boolean
    ) => {
      let entry = aggregated.get(vendedorId);
      if (!entry) {
        const info = vendedorInfoMap.get(vendedorId);
        entry = {
          vendedorId,
          vendedorName: fallbackName ?? info?.name ?? "Sin nombre",
          vendedorCode: fallbackCode ?? info?.code ?? undefined,
          ventanaId: fallbackVentanaId ?? info?.ventanaId ?? undefined,
          ventanaName: fallbackVentanaName ?? info?.ventanaName ?? undefined,
          isActive: fallbackIsActive ?? info?.isActive ?? true,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          totalPaidToVentana: 0,
          remainingBalance: 0,
        };
        aggregated.set(vendedorId, entry);
      } else {
        if (fallbackName && entry.vendedorName !== fallbackName) {
          entry.vendedorName = fallbackName;
        }
        if (typeof fallbackIsActive === "boolean") {
          entry.isActive = fallbackIsActive;
        }
      }
      return entry;
    };

    // ✅ CRÍTICO: Usar datos calculados directamente desde tickets/jugadas
    for (const vendedorRow of vendedorData) {
      const vendedorId = vendedorRow.vendedor_id;
      const entry = ensureEntry(
        vendedorId,
        vendedorRow.vendedor_name,
        vendedorRow.vendedor_code,
        vendedorRow.ventana_id,
        vendedorRow.ventana_name,
        vendedorRow.is_active
      );

      entry.totalSales = Number(vendedorRow.total_sales) || 0;
      entry.totalPayouts = Number(vendedorRow.total_payouts) || 0;
      entry.totalListeroCommission = Number(vendedorRow.listero_commission_snapshot) || Number(vendedorRow.commission_ventana_raw) || 0;
      entry.totalVendedorCommission = Number(vendedorRow.commission_user) || 0;
    }

    // Obtener totalPaid desde AccountStatement
    for (const statement of statements) {
      if (!statement.vendedorId) continue;
      const key = statement.vendedorId;
      const existing = ensureEntry(
        key,
        statement.vendedor?.name,
        statement.vendedor?.code ?? null,
        statement.vendedor?.ventanaId ?? null,
        statement.ventana?.name ?? null,
        statement.vendedor?.isActive ?? undefined
      );

      existing.totalPaid += statement.totalPaid ?? 0;
    }

    const accountPaymentWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      vendedorId: { not: null },
      isReversed: false,
      type: "collection",
    };
    if (filters.ventanaId) {
      accountPaymentWhere.ventanaId = filters.ventanaId;
    }
    if (filters.bancaId) {
      // ✅ CRÍTICO: AccountPayment tiene bancaId directamente, no usar relación ventana
      accountPaymentWhere.bancaId = filters.bancaId;
    }

    const collections = await prisma.accountPayment.findMany({
      where: accountPaymentWhere,
      select: {
        vendedorId: true,
        amount: true,
      },
    });

    for (const collection of collections) {
      if (!collection.vendedorId) continue;
      const entry = ensureEntry(collection.vendedorId);
      entry.totalCollected += collection.amount ?? 0;
    }

    const ticketRelationFilter: Prisma.TicketWhereInput = {
      deletedAt: null,
      // ✅ FIX: vendedorId es requerido en schema, no necesitamos filtrar por "not null"
    };
    if (filters.ventanaId) {
      ticketRelationFilter.ventanaId = filters.ventanaId;
    }
    if (filters.bancaId) {
      ticketRelationFilter.ventana = {
        bancaId: filters.bancaId,
      };
    }

    const ticketPayments = await prisma.ticketPayment.findMany({
      where: {
        isReversed: false,
        paymentDate: {
          gte: rangeStart,
          lte: rangeEnd,
        },
        ticket: {
          is: ticketRelationFilter,
        },
      },
      select: {
        amountPaid: true,
        ticket: {
          select: {
            vendedorId: true,
          },
        },
      },
    });

    for (const payment of ticketPayments) {
      const vendedorId = payment.ticket?.vendedorId;
      if (!vendedorId) continue;
      const entry = ensureEntry(vendedorId);
      entry.totalPaidToCustomer += payment.amountPaid ?? 0;
    }

    // ✅ NUEVO: Verificar si el período filtrado es el mes completo
    // Si es así, el remainingBalance del período debe ser igual al monthlyAccumulated.remainingBalance
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const isMonthComplete = 
      filters.fromDate.getTime() === monthRangeCheck.fromAt.getTime() &&
      filters.toDate.getTime() === todayRangeCheck.toAt.getTime();

    // ✅ NUEVO: Calcular saldoAHoy (acumulado desde inicio del mes hasta hoy) para cada vendedor
    const monthSaldoByVendedor = new Map<string, number>();
    {
      // ✅ CORREGIDO: Usar resolveDateRange para calcular correctamente las fechas en CR timezone
      // Esto asegura consistencia entre local y producción (Render)
      const monthRange = resolveDateRange('month'); // Primer día del mes en CR
      const todayRange = resolveDateRange('today'); // Fin del día de hoy en CR
      
      const monthStart = monthRange.fromAt; // Primer día del mes en CR (06:00:00 UTC)
      const monthEnd = todayRange.toAt; // Fin del día de hoy en CR (23:59:59.999 CR = 05:59:59.999 UTC del día siguiente)

      // Convertir a strings de fecha para filtros usando crDateService
      // ✅ CRÍTICO: Usar dateRangeUTCToCRStrings para obtener correctamente el día de fin
      // porque toAt puede ser del día siguiente en UTC pero representa el fin del día anterior en CR
      const { startDateCRStr: monthStartStr, endDateCRStr: monthEndStr } = crDateService.dateRangeUTCToCRStrings(monthStart, monthEnd);

      const monthBaseFilters = buildTicketBaseFilters(
        "t",
        { ...filters, fromDate: monthStart, toDate: monthEnd },
        monthStartStr,
        monthEndStr
      );

      const monthVendedorData = await prisma.$queryRaw<Array<{ vendedor_id: string; total_sales: number; total_payouts: number; commission_user: number; commission_ventana_raw: number; listero_commission_snapshot: number }>>(
        Prisma.sql`SELECT u.id AS vendedor_id, COALESCE(sp.total_sales, 0) AS total_sales, COALESCE(sp.total_payouts, 0) AS total_payouts, COALESCE(cp.commission_user, 0) AS commission_user, COALESCE(cp.commission_ventana_raw, 0) AS commission_ventana_raw, COALESCE(cp.listero_commission_snapshot, 0) AS listero_commission_snapshot FROM "User" u LEFT JOIN (SELECT t."vendedorId" AS vendedor_id, COALESCE(SUM(j.amount), 0) AS total_sales, COALESCE(SUM(DISTINCT t."totalPayout"), 0) AS total_payouts FROM "Ticket" t JOIN "Jugada" j ON j."ticketId" = t.id WHERE ${monthBaseFilters} AND t."vendedorId" IS NOT NULL AND j."deletedAt" IS NULL AND j."isExcluded" = false GROUP BY t."vendedorId") sp ON sp.vendedor_id = u.id LEFT JOIN (SELECT t."vendedorId" AS vendedor_id, COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user, COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana_raw, COALESCE(SUM(j."listeroCommissionAmount"), 0) AS listero_commission_snapshot FROM "Ticket" t JOIN "Jugada" j ON j."ticketId" = t.id WHERE ${monthBaseFilters} AND t."vendedorId" IS NOT NULL AND j."deletedAt" IS NULL AND j."isExcluded" = false GROUP BY t."vendedorId") cp ON cp.vendedor_id = u.id WHERE u."isActive" = true AND u.role = 'VENDEDOR' ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}`
      );

      // ✅ Vendedores funcionan correctamente, mantener consulta original
      const monthStatements = await prisma.accountStatement.findMany({
        where: {
          date: { gte: monthStart, lte: monthEnd },
          vendedorId: { not: null },
          ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
          ...(filters.bancaId ? { bancaId: filters.bancaId } : {}),
        },
      });

      // ✅ Vendedores funcionan correctamente, mantener consulta original
      const monthCollections = await prisma.accountPayment.findMany({
        where: {
          date: { gte: monthStart, lte: monthEnd },
          vendedorId: { not: null },
          isReversed: false,
          type: "collection",
          ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
          ...(filters.bancaId ? { bancaId: filters.bancaId } : {}),
        },
        select: {
          vendedorId: true,
          amount: true,
        },
      });

      const monthAggregated = new Map<string, { totalSales: number; totalPayouts: number; totalListeroCommission: number; totalVendedorCommission: number; totalPaid: number; totalCollected: number }>();

      for (const vendedorRow of monthVendedorData) {
        const vendedorId = vendedorRow.vendedor_id;
        monthAggregated.set(vendedorId, {
          totalSales: Number(vendedorRow.total_sales) || 0,
          totalPayouts: Number(vendedorRow.total_payouts) || 0,
          totalListeroCommission: Number(vendedorRow.listero_commission_snapshot) || Number(vendedorRow.commission_ventana_raw) || 0,
          totalVendedorCommission: Number(vendedorRow.commission_user) || 0,
          totalPaid: 0,
          totalCollected: 0,
        });
      }

      for (const statement of monthStatements) {
        if (!statement.vendedorId) continue;
        const entry = monthAggregated.get(statement.vendedorId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalPaid += statement.totalPaid ?? 0;
        monthAggregated.set(statement.vendedorId, entry);
      }

      for (const collection of monthCollections) {
        if (!collection.vendedorId) continue;
        const entry = monthAggregated.get(collection.vendedorId) || {
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
        };
        entry.totalCollected += collection.amount ?? 0;
        monthAggregated.set(collection.vendedorId, entry);
      }

      // Balance: Ventas - Premios - Comisión Vendedor
      // ✅ NUEVO: Incluir saldo final del mes anterior (batch - una sola consulta)
      // ✅ CORREGIDO: Usar crDateService para obtener el mes efectivo en formato YYYY-MM
      const nowCRStr = crDateService.dateUTCToCRString(new Date());
      const effectiveMonth = nowCRStr.substring(0, 7); // YYYY-MM
      
      // ✅ CRÍTICO: Obtener TODOS los vendedores activos, no solo los que tienen datos en el mes actual
      // Esto asegura que vendedores con saldo del mes anterior pero sin datos en el mes actual también aparezcan
      const allVendedorIds = await prisma.user.findMany({
        where: {
          role: "VENDEDOR",
          isActive: true,
          deletedAt: null,
          ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
          ...(filters.bancaId ? { bancaId: filters.bancaId } : {}),
        },
        select: { id: true },
      }).then(users => users.map(u => u.id));
      
      const previousMonthBalances = await getPreviousMonthFinalBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIds,
        filters.bancaId
      );
      
      // ✅ CRÍTICO: Asegurar que todos los vendedores con saldo del mes anterior estén en monthAggregated
      // Esto garantiza que el cálculo del saldo sea consistente
      for (const vendedorId of allVendedorIds) {
        if (!monthAggregated.has(vendedorId)) {
          monthAggregated.set(vendedorId, {
            totalSales: 0,
            totalPayouts: 0,
            totalListeroCommission: 0,
            totalVendedorCommission: 0,
            totalPaid: 0,
            totalCollected: 0,
          });
        }
      }
      
      // Calcular saldo para todos los vendedores (con o sin datos en el mes actual)
      for (const [vendedorId, monthEntry] of monthAggregated.entries()) {
        // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
        const previousMonthBalance = Number(previousMonthBalances.get(vendedorId) || 0);
        const baseBalance = monthEntry.totalSales - monthEntry.totalPayouts - monthEntry.totalVendedorCommission;
        // Sumar saldo del mes anterior al acumulado del mes actual
        const saldoAHoy = previousMonthBalance + baseBalance - monthEntry.totalCollected + monthEntry.totalPaid;
        monthSaldoByVendedor.set(vendedorId, saldoAHoy);
      }
    }

    // ✅ CRÍTICO: Incluir TODOS los vendedores con saldo, no solo los que tienen datos en el período filtrado
    // Esto asegura que vendedores con saldo del mes anterior pero sin datos en el período aparezcan
    const allVendedorIdsWithSaldo = new Set([
      ...Array.from(aggregated.keys()),
      ...Array.from(monthSaldoByVendedor.keys()),
    ]);

    // Obtener información de vendedores que no están en aggregated
    const missingVendedorIds = Array.from(allVendedorIdsWithSaldo).filter(id => !aggregated.has(id));
    if (missingVendedorIds.length > 0) {
      const missingVendedors = await prisma.user.findMany({
        where: {
          id: { in: missingVendedorIds },
          role: "VENDEDOR",
          isActive: true,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          code: true,
          ventanaId: true,
          ventana: { select: { name: true } },
          isActive: true,
        },
      });

      for (const vendedor of missingVendedors) {
        // Agregar al aggregated con valores en 0
        aggregated.set(vendedor.id, {
          vendedorId: vendedor.id,
          vendedorName: vendedor.name,
          vendedorCode: vendedor.code ?? undefined,
          ventanaId: vendedor.ventanaId ?? undefined,
          ventanaName: vendedor.ventana?.name ?? undefined,
          isActive: vendedor.isActive,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          totalPaidToVentana: 0,
          remainingBalance: 0,
        });
      }
    }

    const byVendedor = Array.from(allVendedorIdsWithSaldo)
      .map((vendedorId) => {
        const entry = aggregated.get(vendedorId) || {
          vendedorId,
          vendedorName: "Desconocido",
          vendedorCode: undefined,
          ventanaId: undefined,
          ventanaName: undefined,
          isActive: true,
          totalSales: 0,
          totalPayouts: 0,
          totalListeroCommission: 0,
          totalVendedorCommission: 0,
          totalPaid: 0,
          totalCollected: 0,
          totalPaidToCustomer: 0,
          totalPaidToVentana: 0,
          remainingBalance: 0,
        };

        const totalPaid = entry.totalPaid;
        const totalCollected = entry.totalCollected;
        const totalPaidToCustomer = entry.totalPaidToCustomer;
        const totalPaidToVentana = entry.totalPaidToVentana || 0;
        // Balance: Ventas - Premios - Comisión Vendedor
        const baseBalance = entry.totalSales - entry.totalPayouts - entry.totalVendedorCommission;
        const periodRemainingBalance = baseBalance - entry.totalCollected + entry.totalPaid;
        
        // ✅ CRÍTICO: Si el período es el mes completo, usar el saldo acumulado mensual (que incluye saldo del mes anterior)
        // Si el período es un día específico, usar solo el balance del período
        const monthlyAccumulatedBalance = monthSaldoByVendedor.get(entry.vendedorId) ?? 0;
        const recalculatedRemainingBalance = isMonthComplete 
          ? monthlyAccumulatedBalance 
          : periodRemainingBalance;
        
        // ✅ CRÍTICO: amount debe usar el remainingBalance recalculado (valor absoluto si es negativo)
        const amount = recalculatedRemainingBalance < 0 ? Math.abs(recalculatedRemainingBalance) : 0;

        return {
          vendedorId: entry.vendedorId,
          vendedorName: entry.vendedorName,
          vendedorCode: entry.vendedorCode,
          ventanaId: entry.ventanaId,
          ventanaName: entry.ventanaName,
          totalSales: entry.totalSales,
          totalPayouts: entry.totalPayouts,
          listeroCommission: entry.totalListeroCommission,
          vendedorCommission: entry.totalVendedorCommission,
          totalListeroCommission: entry.totalListeroCommission,
          totalVendedorCommission: entry.totalVendedorCommission,
          totalPaid,
          totalPaidOut: totalPaid,
          totalCollected,
          totalPaidToCustomer,
          totalPaidToVentana,
          amount,
          remainingBalance: recalculatedRemainingBalance,
          monthlyAccumulated: {
            remainingBalance: monthSaldoByVendedor.get(vendedorId) ?? 0,
          },
          isActive: entry.isActive,
        };
      })
      .filter(v => {
        // Incluir vendedores con:
        // 1. Saldo del mes anterior (monthlyAccumulated)
        // 2. Saldo en el período filtrado
        // 3. Ventas en el período filtrado
        return v.monthlyAccumulated.remainingBalance !== 0 || v.remainingBalance !== 0 || v.totalSales > 0;
      })
      .sort((a, b) => b.amount - a.amount);

    const totalAmount = byVendedor.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVendedor,
    };
  },

  /**
   * Resumen general: totales de ventas, pagos, comisiones
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async getSummary(filters: DashboardFilters, role?: Role): Promise<DashboardSummary> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);
    // ✅ NOTE: Commission already included in SQL snapshot
    // No need to call computeVentanaCommissionFromPolicies

    const summaryRows = await prisma.$queryRaw<
      Array<{
        total_sales: number;
        total_payouts: number;
        total_tickets: number;
        winning_tickets: number;
        commission_user: number;
        commission_ventana: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."totalAmount",
            t."totalPayout",
            t."isWinner"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        ticket_summary AS (
          SELECT
            COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
            COALESCE(SUM(t."totalPayout"), 0) AS total_payouts,
            COUNT(DISTINCT t.id) AS total_tickets,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) AS winning_tickets
          FROM tickets_in_range t
        ),
        commission_summary AS (
          SELECT
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(
              CASE
                WHEN j."listeroCommissionAmount" > 0 THEN j."listeroCommissionAmount"
                WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount"
                ELSE 0
              END
            ), 0) AS commission_ventana
          FROM "Jugada" j
          JOIN tickets_in_range t ON t.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
        )
        SELECT
          ts.total_sales,
          ts.total_payouts,
          ts.total_tickets,
          ts.winning_tickets,
          COALESCE(cs.commission_user, 0) AS commission_user,
          COALESCE(cs.commission_ventana, 0) AS commission_ventana
        FROM ticket_summary ts
        LEFT JOIN commission_summary cs ON TRUE
      `
    );

    const summary = summaryRows[0] || {
      total_sales: 0,
      total_payouts: 0,
      total_tickets: 0,
      winning_tickets: 0,
      commission_user: 0,
      commission_ventana: 0,
    };

    const totalSales = Number(summary.total_sales) || 0;
    const totalPayouts = Number(summary.total_payouts) || 0;
    const totalTickets = Number(summary.total_tickets) || 0;
    const winningTickets = Number(summary.winning_tickets) || 0;
    const commissionUser = Number(summary.commission_user) || 0;
    // ✅ FIX: Use ONLY snapshot from database, NOT totalVentanaCommission
    // totalVentanaCommission is already included in summary.commission_ventana
    const commissionVentana = Number(summary.commission_ventana) || 0;
    const totalCommissions = commissionUser + commissionVentana;
    // ✅ CORRECCIÓN: Calcular ganancia neta según rol
    // Para ADMIN: resta commissionVentana (comisión del listero)
    // Para VENTANA/VENDEDOR: resta commissionUser (comisión del vendedor)
    const net = role === Role.ADMIN
      ? totalSales - totalPayouts - commissionVentana
      : totalSales - totalPayouts - commissionUser;
    const margin = totalSales > 0 ? (net / totalSales) * 100 : 0;
    const winRate = totalTickets > 0 ? (winningTickets / totalTickets) * 100 : 0;

    // ✅ NUEVO: Ganancia neta de listeros = comisión ventana - comisión usuario
    const gananciaListeros = commissionVentana - commissionUser;
    // ✅ NUEVO: Alias conceptual para claridad
    const gananciaBanca = net;

    return {
      totalSales,
      totalPayouts,
      totalCommissions,
      commissionUser,
      commissionVentana,
      commissionVentanaTotal: commissionVentana, // Alias para compatibilidad con frontend
      gananciaListeros, // ✅ NUEVO
      gananciaBanca, // ✅ NUEVO
      totalTickets,
      winningTickets,
      net,
      margin: parseFloat(margin.toFixed(2)), // ✅ NUEVO: Margen neto
      winRate: parseFloat(winRate.toFixed(2)),
    };
  },

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   * @param filters Filtros de dashboard
   * @param role Rol del usuario autenticado (para determinar qué comisión restar)
   */
  async getFullDashboard(filters: DashboardFilters, role?: Role) {
    const startTime = Date.now();
    let queryCount = 0;

    const [ganancia, cxc, cxp, summary, timeSeries, exposure, previousPeriod] = await Promise.all([
      this.calculateGanancia(filters, role).then((r) => {
        queryCount += 2;
        return r;
      }),
      this.calculateCxC(filters).then((r) => {
        queryCount += 1;
        return r;
      }),
      this.calculateCxP(filters).then((r) => {
        queryCount += 1;
        return r;
      }),
      this.getSummary(filters, role).then((r) => {
        queryCount += 1;
        return r;
      }),
      this.getTimeSeries({ ...filters, interval: filters.interval || 'day' }).then((r) => {
        queryCount += 1;
        return r;
      }),
      this.calculateExposure(filters).then((r) => {
        queryCount += 3;
        return r;
      }),
      this.calculatePreviousPeriod(filters, role).then((r) => {
        queryCount += 1;
        return r;
      }),
    ]);

    const alerts = this.generateAlerts({ ganancia, cxc, cxp, summary, exposure });

    return {
      ganancia,
      cxc,
      cxp,
      summary,
      timeSeries: timeSeries.timeSeries,
      exposure,
      previousPeriod,
      alerts,
      meta: {
        range: {
          fromAt: filters.fromDate.toISOString(),
          toAt: filters.toDate.toISOString(),
          tz: 'America/Costa_Rica',
        },
        scope: filters.scope || 'all',
        generatedAt: new Date().toISOString(),
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
      },
    };
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
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

    // Determinar formato de fecha según interval
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

    // Si es week o month, necesitamos agrupar diferente
    let groupByClause = Prisma.sql`date_bucket`;
    let selectClause = dateFormat;
    if (interval === 'week') {
      // Agrupar por semana del año
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
      // Agrupar por mes
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

    const result = await prisma.$queryRaw<
      Array<{
        date_bucket: Date;
        total_sales: number;
        total_commissions: number;
        total_tickets: number;
      }>
    >(
      Prisma.sql`
        SELECT
          ${selectClause} as date_bucket,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(t."totalCommission"), 0) as total_commissions,
          COUNT(DISTINCT t.id) as total_tickets
        FROM "Ticket" t
        WHERE ${baseFilters}
        GROUP BY ${groupByClause}
        ORDER BY date_bucket ASC
      `
    );

    // Calcular período anterior si compare=true
    let comparisonData: Array<{
      date: string;
      timestamp: string;
      label: string;
      sales: number;
      commissions: number;
      tickets: number;
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
      const prevBaseFilters = buildTicketBaseFilters("t", previousFilters, prevFromDateStr, prevToDateStr);

      const prevResult = await prisma.$queryRaw<
        Array<{
          date_bucket: Date;
          total_sales: number;
          total_commissions: number;
          total_tickets: number;
        }>
      >(
        Prisma.sql`
          SELECT
            ${selectClause} as date_bucket,
            COALESCE(SUM(t."totalAmount"), 0) as total_sales,
            COALESCE(SUM(t."totalCommission"), 0) as total_commissions,
            COUNT(DISTINCT t.id) as total_tickets
          FROM "Ticket" t
          WHERE ${prevBaseFilters}
          GROUP BY ${groupByClause}
          ORDER BY date_bucket ASC
        `
      );

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
          label, // ✅ NUEVO: Etiqueta formateada según granularity
          sales: Number(row.total_sales) || 0,
          commissions: Number(row.total_commissions) || 0,
          tickets: Number(row.total_tickets) || 0,
        };
      }),
      comparison: filters.compare ? comparisonData : undefined, // ✅ NUEVO: Datos del período anterior
      meta: {
        interval,
        granularity, // ✅ NUEVO: Incluir granularity en meta
        timezone: 'America/Costa_Rica', // ✅ Indicar zona horaria usada
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
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

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
          SELECT t.id
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        jugadas_in_range AS (
          SELECT
            j."ticketId",
            j.number,
            j.type,
            j.amount,
            j."finalMultiplierX"
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
        )
        SELECT
          j.number,
          j.type as bet_type,
          COALESCE(SUM(j.amount), 0) as total_sales,
          COALESCE(SUM(j.amount * j."finalMultiplierX"), 0) as potential_payout,
          COUNT(DISTINCT j."ticketId") as ticket_count
        FROM jugadas_in_range j
        ${filters.betType ? Prisma.sql`WHERE j.type = ${filters.betType}` : Prisma.empty}
        GROUP BY j.number, j.type
        ORDER BY total_sales DESC
        LIMIT ${topLimit}
      `
    );

    const heatmap = await prisma.$queryRaw<
      Array<{
        number: string;
        total_sales: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT t.id
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        jugadas_in_range AS (
          SELECT
            j."ticketId",
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
        GROUP BY j.number
        ORDER BY j.number ASC
      `
    );

    const byLoteria = await prisma.$queryRaw<
      Array<{
        loteria_id: string;
        loteria_name: string;
        total_sales: number;
        potential_payout: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."loteriaId"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        jugadas_in_range AS (
          SELECT
            j."ticketId",
            j.amount,
            j."finalMultiplierX"
          FROM "Jugada" j
          JOIN tickets_in_range tir ON tir.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
        )
        SELECT
          l.id as loteria_id,
          l.name as loteria_name,
          COALESCE(SUM(j.amount), 0) as total_sales,
          COALESCE(SUM(j.amount * j."finalMultiplierX"), 0) as potential_payout
        FROM jugadas_in_range j
        JOIN tickets_in_range tir ON tir.id = j."ticketId"
        JOIN "Loteria" l ON tir."loteriaId" = l.id
        GROUP BY l.id, l.name
        ORDER BY total_sales DESC
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
      byLoteria: byLoteria.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        return {
          loteriaId: row.loteria_id,
          loteriaName: row.loteria_name,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? parseFloat((payout / sales).toFixed(2)) : 0,
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
    const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr);

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
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."vendedorId",
            t."ventanaId",
            t."totalAmount",
            t."isWinner",
            t."sorteoId"
          FROM "Ticket" t
          WHERE ${baseFilters}
            AND t."vendedorId" IS NOT NULL
        ),
        sales_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(j.amount), 0) AS total_sales,
            COALESCE(SUM(j.payout), 0) AS total_payout
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        ),
        commissions_per_vendedor AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) AS commission_ventana
          FROM tickets_in_range t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL
          AND j."isExcluded" = false
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u ON u.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
          GROUP BY t."vendedorId"
        ),
        vendedor_summary AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COUNT(DISTINCT t.id) AS total_tickets,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) AS winning_tickets
          FROM tickets_in_range t
          GROUP BY t."vendedorId"
        )
        SELECT
          u.id as vendedor_id,
          u.name as vendedor_name,
          u.code as vendedor_code,
          u."ventanaId" as ventana_id,
          v.name as ventana_name,
          u."isActive" as is_active,
          COALESCE(sp.total_sales, 0) as total_sales,
          COALESCE(sp.total_payout, 0) as total_payout,
          COALESCE(cp.commission_user, 0) as commission_user,
          COALESCE(cp.commission_ventana, 0) as commission_ventana,
          COALESCE(vs.total_tickets, 0) as total_tickets,
          COALESCE(vs.winning_tickets, 0) as winning_tickets,
          CASE
            WHEN COALESCE(vs.total_tickets, 0) > 0 THEN COALESCE(sp.total_sales, 0) / COALESCE(vs.total_tickets, 0)
            ELSE 0
          END as avg_ticket
        FROM "User" u
        JOIN vendedor_summary vs ON vs.vendedor_id = u.id
        LEFT JOIN sales_per_vendedor sp ON sp.vendedor_id = u.id
        LEFT JOIN commissions_per_vendedor cp ON cp.vendedor_id = u.id
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
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."vendedorId"
          FROM "Ticket" t
          WHERE ${baseFilters}
            AND t."vendedorId" IS NOT NULL
        )
        SELECT COUNT(*) as count
        FROM (
          SELECT DISTINCT u.id
          FROM tickets_in_range t
          JOIN "User" u ON u.id = t."vendedorId"
          WHERE u."isActive" = true
            AND u.role = 'VENDEDOR'
        ) active_vendedores
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
    const baseFilters = buildTicketBaseFilters("t", previousFilters, fromDateStr, toDateStr);

    // ✅ NOTE: Commission already included in SQL snapshot for previous period
    // No need to call computeVentanaCommissionFromPolicies

    const previousRows = await prisma.$queryRaw<
      Array<{
        total_sales: number;
        total_payouts: number;
        total_tickets: number;
        winning_tickets: number;
        commission_user: number;
        commission_ventana: number;
      }>
    >(
      Prisma.sql`
        WITH tickets_in_range AS (
          SELECT
            t.id,
            t."totalAmount",
            t."totalPayout",
            t."isWinner"
          FROM "Ticket" t
          WHERE ${baseFilters}
        ),
        ticket_summary AS (
          SELECT
            COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
            COALESCE(SUM(t."totalPayout"), 0) AS total_payouts,
            COUNT(DISTINCT t.id) AS total_tickets,
            COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) AS winning_tickets
          FROM tickets_in_range t
        ),
        commission_summary AS (
          SELECT
            COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) AS commission_user,
            COALESCE(SUM(CASE WHEN j."commissionOrigin" IN ('VENTANA', 'BANCA') THEN j."commissionAmount" ELSE 0 END), 0) AS commission_ventana
          FROM "Jugada" j
          JOIN tickets_in_range t ON t.id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
        )
        SELECT
          ts.total_sales,
          ts.total_payouts,
          ts.total_tickets,
          ts.winning_tickets,
          COALESCE(cs.commission_user, 0) AS commission_user,
          COALESCE(cs.commission_ventana, 0) AS commission_ventana
        FROM ticket_summary ts
        LEFT JOIN commission_summary cs ON TRUE
      `
    );

    const row = previousRows[0] || {
      total_sales: 0,
      total_payouts: 0,
      total_tickets: 0,
      winning_tickets: 0,
      commission_user: 0,
      commission_ventana: 0,
    };

    const sales = Number(row.total_sales) || 0;
    const payouts = Number(row.total_payouts) || 0;
    const commissionUser = Number(row.commission_user) || 0;
    // ✅ FIX: Use ONLY snapshot from database, NOT totalVentanaCommission
    // totalVentanaCommission is already included in row.commission_ventana
    const commissionVentana = Number(row.commission_ventana) || 0;
    const totalCommissions = commissionUser + commissionVentana;

    // ✅ CORRECCIÓN: Calcular ganancia neta según rol
    // Para ADMIN: resta commissionVentana (comisión del listero)
    // Para VENTANA/VENDEDOR: resta commissionUser (comisión del vendedor)
    const net = role === Role.ADMIN
      ? sales - payouts - commissionVentana
      : sales - payouts - commissionUser;
    const margin = sales > 0 ? (net / sales) * 100 : 0;

    return {
      sales,
      payouts,
      net, // ✅ NUEVO: Ganancia neta del período anterior
      margin: parseFloat(margin.toFixed(2)), // ✅ NUEVO: Margen neto del período anterior
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

    // Alerta: CxC alto
    if (data.cxc.totalAmount > CXC_THRESHOLD_CRITICAL) {
      alerts.push({
        type: 'HIGH_CXC',
        severity: 'critical',
        message: `CxC total: ₡${data.cxc.totalAmount.toLocaleString()} excede umbral crítico`,
        action: 'Revisar ventanas con mayor deuda y gestionar cobro inmediato',
      });
    } else if (data.cxc.totalAmount > CXC_THRESHOLD_WARN) {
      alerts.push({
        type: 'HIGH_CXC',
        severity: 'warn',
        message: `CxC total: ₡${data.cxc.totalAmount.toLocaleString()} excede umbral de advertencia`,
        action: 'Monitorear cuentas por cobrar y planificar gestión de cobro',
      });
    }

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

    // Alerta: Overpayment (CxP > 0)
    if (data.cxp.totalAmount > 0) {
      alerts.push({
        type: 'OVERPAYMENT',
        severity: 'info',
        message: `CxP detectado: ₡${data.cxp.totalAmount.toLocaleString()}`,
        action: 'Banco debe liquidar con ventanas',
      });
    }

    return alerts;
  },
};

export default DashboardService;
