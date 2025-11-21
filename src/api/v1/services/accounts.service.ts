// src/api/v1/services/accounts.service.ts
import { Prisma, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { AccountStatementRepository } from "../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { resolveCommission } from "../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../services/commission/commission.resolver";
import { resolveDateRange } from "../../../utils/dateRange";

/**
 * Filtros para queries de accounts
 */
interface AccountsFilters {
  month?: string; // YYYY-MM (opcional si se usa date)
  // ✅ NUEVO: Filtros de período
  date?: "today" | "yesterday" | "week" | "month" | "year" | "range";
  fromDate?: string; // YYYY-MM-DD (requerido si date='range')
  toDate?: string; // YYYY-MM-DD (requerido si date='range')
  scope: "mine" | "ventana" | "all";
  dimension: "ventana" | "vendedor";
  ventanaId?: string;
  vendedorId?: string;
  bancaId?: string; // Para ADMIN multibanca
  sort?: "asc" | "desc";
}

const COSTA_RICA_UTC_OFFSET_HOURS = 6; // Costa Rica está en UTC-6, así que 00:00 local = 06:00 UTC

function toCostaRicaISODate(date: Date): string {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      COSTA_RICA_UTC_OFFSET_HOURS,
      0,
      0,
      0
    )
  ).toISOString();
}

/**
 * Obtiene el rango de fechas del mes
 * FIX: Si el mes consultado es el mes actual, limita endDate a hoy para excluir días futuros
 */
function getMonthDateRange(month: string): { startDate: Date; endDate: Date; daysInMonth: number } {
  const [year, monthNum] = month.split("-").map(Number);
  const startDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));
  
  // Obtener fecha actual en UTC
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  
  // Calcular último día del mes consultado
  const monthEndDate = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
  
  // Si el mes consultado es el mes actual, limitar a hoy
  // Si es un mes pasado, usar el último día de ese mes
  // Si es un mes futuro, usar el último día del mes consultado (aunque no debería pasar)
  const isCurrentMonth = year === now.getUTCFullYear() && monthNum === now.getUTCMonth() + 1;
  const endDate = isCurrentMonth ? (today < startDate ? startDate : today) : monthEndDate;
  
  const daysInMonth = monthEndDate.getDate();
  return { startDate, endDate, daysInMonth };
}

/**
 * Obtiene la fecha de un día específico del mes
 */
function getDateForDay(month: string, day: number): Date {
  const [year, monthNum] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNum - 1, day, 0, 0, 0, 0));
}

/**
 * Helper: Calcula si un estado de cuenta está saldado
 * CRÍTICO: Solo está saldado si hay tickets Y el saldo es cero Y hay pagos/cobros registrados
 */
function calculateIsSettled(
  ticketCount: number,
  remainingBalance: number,
  totalPaid: number,
  totalCollected: number
): boolean {
  const hasPayments = totalPaid > 0 || totalCollected > 0;
  return ticketCount > 0 
    && Math.abs(remainingBalance) < 0.01 
    && hasPayments;
}

async function computeListeroCommissionsForWhere(
  ticketWhere: Prisma.TicketWhereInput
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  const jugadas = await prisma.jugada.findMany({
    where: {
      ticket: ticketWhere,
      deletedAt: null,
    },
    select: {
      amount: true,
      type: true,
      finalMultiplierX: true,
      ticket: {
        select: {
          loteriaId: true,
          ventanaId: true,
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
    return result;
  }

  const ventanaIds = Array.from(
    new Set(
      jugadas
        .map((j) => j.ticket.ventanaId)
        .filter((id): id is string => typeof id === "string")
    )
  );

  const ventanasWithBancas = ventanaIds.length
    ? await prisma.ventana.findMany({
        where: { id: { in: ventanaIds } },
        select: {
          id: true,
          commissionPolicyJson: true,
          banca: {
            select: { commissionPolicyJson: true },
          },
        },
      })
    : [];

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

  const policiesMap = new Map<
    string,
    {
      userPolicy: any;
      ventanaPolicy: any;
      bancaPolicy: any;
      ventanaUserId: string | null;
    }
  >();

  ventanasWithBancas.forEach((ventana) => {
    policiesMap.set(ventana.id, {
      userPolicy: null,
      ventanaPolicy: ventana.commissionPolicyJson as any,
      bancaPolicy: ventana.banca?.commissionPolicyJson as any,
      ventanaUserId: null,
    });
  });

  ventanaUsers.forEach((user) => {
    if (!user.ventanaId) return;
    const existing =
      policiesMap.get(user.ventanaId) || {
        userPolicy: null,
        ventanaPolicy: null,
        bancaPolicy: null,
        ventanaUserId: null,
      };
    if (!existing.userPolicy) {
      existing.userPolicy = user.commissionPolicyJson as any;
      existing.ventanaUserId = user.id;
    }
    policiesMap.set(user.ventanaId, existing);
  });

  for (const jugada of jugadas) {
    const ventanaId = jugada.ticket.ventanaId;
    if (!ventanaId) continue;

    const policies = policiesMap.get(ventanaId) || {
      userPolicy: null,
      ventanaPolicy: null,
      bancaPolicy: null,
      ventanaUserId: null,
    };

    const ventanaPolicy =
      (jugada.ticket.ventana?.commissionPolicyJson as any) ?? policies.ventanaPolicy;
    const bancaPolicy =
      (jugada.ticket.ventana?.banca?.commissionPolicyJson as any) ?? policies.bancaPolicy;
    const userPolicy = policies.userPolicy;
    const ventanaUserId = policies.ventanaUserId ?? ventanaId;

    // Actualizar cache en caso de que obtengamos políticas desde el ticket
    policiesMap.set(ventanaId, {
      userPolicy,
      ventanaPolicy,
      bancaPolicy,
      ventanaUserId,
    });

    let commissionAmount = 0;

    if (userPolicy) {
      try {
        const resolution = resolveCommissionFromPolicy(userPolicy as any, {
          userId: ventanaUserId ?? ventanaId,
          loteriaId: jugada.ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX ?? null,
        });
        commissionAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
      } catch {
        const fallback = resolveCommission(
          {
            loteriaId: jugada.ticket.loteriaId,
            betType: jugada.type as "NUMERO" | "REVENTADO",
            finalMultiplierX: jugada.finalMultiplierX || 0,
            amount: jugada.amount,
          },
          null,
          ventanaPolicy,
          bancaPolicy
        );
        commissionAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
      }
    } else {
      const fallback = resolveCommission(
        {
          loteriaId: jugada.ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX || 0,
          amount: jugada.amount,
        },
        null,
        ventanaPolicy,
        bancaPolicy
      );
      commissionAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
    }

    if (commissionAmount <= 0) continue;

    result.set(ventanaId, (result.get(ventanaId) || 0) + commissionAmount);
  }

  return result;
}

/**
 * Helper: Construye filtro de tickets por fecha usando businessDate (prioridad) o createdAt (fallback)
 * FIX: Usa businessDate si existe, fallback a createdAt para tickets antiguos sin businessDate
 */
/**
 * Construye filtro de fecha para tickets
 * @param date - Date que representa un día en CR (ej: Date.UTC(2025, 0, 19) = 19 de enero 2025 en CR)
 * @returns Filtro Prisma que busca tickets por businessDate o createdAt (convertido a CR)
 * 
 * CRÍTICO: date debe representar un día calendario en CR, no en UTC
 * Para createdAt: 00:00 CR = 06:00 UTC, entonces filtramos desde 06:00 UTC hasta 05:59:59.999 UTC del día siguiente
 */
function buildTicketDateFilter(date: Date): any {
  // date representa un día calendario en CR (ej: Date.UTC(2025, 0, 19) = 19 enero 2025 en CR)
  // Extraer año, mes, día en UTC (que representan el día en CR)
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  
  // businessDate se guarda como fecha sin hora (00:00:00 UTC del día)
  const businessDateStart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  
  // createdAt está en UTC, pero representa horas en CR
  // 00:00 CR = 06:00 UTC del mismo día calendario
  // 23:59:59.999 CR = 05:59:59.999 UTC del día siguiente
  const createdAtStart = new Date(Date.UTC(year, month, day, 6, 0, 0, 0)); // 00:00 CR
  const createdAtEnd = new Date(Date.UTC(year, month, day + 1, 5, 59, 59, 999)); // 23:59:59.999 CR

  return {
    OR: [
      // Prioridad: businessDate (fecha de negocio correcta)
      { businessDate: businessDateStart },
      // Fallback: createdAt para tickets antiguos sin businessDate
      // Convertir rango de CR a UTC: 00:00-23:59:59.999 CR = 06:00 UTC - 05:59:59.999 UTC del día siguiente
      {
        businessDate: null,
        createdAt: {
          gte: createdAtStart,
          lte: createdAtEnd,
        },
      },
    ],
  };
}

/**
 * Calcula comisiones para un ticket
 * Nota: Las comisiones ya están guardadas en Jugada (commissionAmount, commissionOrigin)
 * Para el estado de cuenta, separamos comisiones de listero y vendedor
 * 
 * Lógica:
 * - Si dimension='ventana': La comisión guardada en Jugada es del listero (ventana)
 * - Si dimension='vendedor': La comisión guardada en Jugada es del vendedor
 *   - Para calcular la comisión del listero, necesitamos obtener la política de la ventana
 *   - La comisión del listero = comisión de la ventana - comisión del vendedor
 */
async function calculateCommissionsForTicket(
  ticket: any,
  dimension: "ventana" | "vendedor"
): Promise<{ listeroCommission: number; vendedorCommission: number }> {
  const jugadas = ticket.jugadas || [];
  let listeroCommission = 0;
  let vendedorCommission = 0;

  if (dimension === "ventana") {
    // Si es ventana, toda la comisión guardada es del listero
    for (const jugada of jugadas) {
      const commissionAmount = jugada.commissionAmount || 0;
      listeroCommission += commissionAmount;
    }
    vendedorCommission = 0; // No hay comisión de vendedor en este caso
  } else {
    // Si es vendedor, obtener la ventana UNA VEZ por ticket (no por jugada)
    let ventanaPolicy: any = null;
    let bancaPolicy: any = null;

    if (ticket.ventanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: ticket.ventanaId },
        select: { 
          commissionPolicyJson: true,
          banca: {
            select: {
              commissionPolicyJson: true,
            },
          },
        },
      });
      ventanaPolicy = ventana?.commissionPolicyJson as any;
      bancaPolicy = ventana?.banca?.commissionPolicyJson as any;
    }

    // Calcular comisiones para todas las jugadas del ticket
    for (const jugada of jugadas) {
      // La comisión guardada es del vendedor
      const commissionAmount = jugada.commissionAmount || 0;
      vendedorCommission += commissionAmount;

      // Calcular comisión de la ventana usando la jerarquía VENTANA → BANCA
      // Nota: Pasamos null para userPolicy para que use solo VENTANA → BANCA
      const res = resolveCommission(
        {
          loteriaId: ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX || 0,
          amount: jugada.amount,
        },
        null, // No usar política del vendedor para calcular comisión del listero
        ventanaPolicy, // Usar política de la ventana (obtenida una vez por ticket)
        bancaPolicy // Usar política de la banca como fallback (obtenida una vez por ticket)
      );
      
      const ventanaCommissionAmount = res.commissionAmount;

      // La comisión del listero es la diferencia entre la de la ventana y la del vendedor
      // Si la comisión del vendedor es mayor o igual a la de la ventana, el listero no recibe comisión
      listeroCommission += Math.max(0, ventanaCommissionAmount - commissionAmount);
    }
  }

  return { listeroCommission, vendedorCommission };
}

type DayStatement = Awaited<ReturnType<typeof calculateDayStatement>>;

/**
 * ✅ OPTIMIZACIÓN: Lee resúmenes diarios de la vista materializada
 * Retorna un Map<dateKey, { ventanaId, vendedorId, ticket_count, total_sales, ... }>
 */
async function getDailySummariesFromMaterializedView(
  startDate: Date,
  endDate: Date,
  dimension: "ventana" | "vendedor",
  ventanaId: string | undefined,
  vendedorId: string | undefined,
  sort: "asc" | "desc" = "desc"
): Promise<Map<string, {
  date: Date;
  ventanaId: string | null;
  vendedorId: string | null;
  ticket_count: number;
  total_sales: number;
  total_payouts: number;
  vendedor_commission: number;
  listero_commission: number;
  balance: number;
}>> {
  try {
    // Construir condiciones WHERE dinámicamente
    const conditions: string[] = [
      `date >= '${startDate.toISOString().split('T')[0]}'::date`,
      `date <= '${endDate.toISOString().split('T')[0]}'::date`,
    ];

    if (dimension === "ventana" && ventanaId) {
      conditions.push(`"ventanaId" = '${ventanaId}'::uuid`);
      conditions.push(`"vendedorId" IS NULL`);
    } else if (dimension === "vendedor" && vendedorId) {
      conditions.push(`"vendedorId" = '${vendedorId}'::uuid`);
      conditions.push(`"ventanaId" IS NULL`);
    } else if (dimension === "ventana") {
      conditions.push(`"ventanaId" IS NOT NULL`);
      conditions.push(`"vendedorId" IS NULL`);
    } else if (dimension === "vendedor") {
      conditions.push(`"vendedorId" IS NOT NULL`);
      conditions.push(`"ventanaId" IS NULL`);
    }

    const whereClause = conditions.join(' AND ');
    const orderClause = sort === "desc" ? "DESC" : "ASC";

    // Query la vista materializada
    const summaries = await prisma.$queryRawUnsafe<Array<{
      date: Date;
      ventanaId: string | null;
      vendedorId: string | null;
      ticket_count: bigint;
      total_sales: number;
      total_payouts: number;
      vendedor_commission: number;
      listero_commission: number;
      balance: number;
    }>>(`
      SELECT 
        date,
        "ventanaId",
        "vendedorId",
        ticket_count,
        total_sales,
        total_payouts,
        vendedor_commission,
        listero_commission,
        balance
      FROM mv_daily_account_summary
      WHERE ${whereClause}
      ORDER BY date ${orderClause}
    `);

    // Convertir a Map por dateKey
    const resultMap = new Map<string, {
      date: Date;
      ventanaId: string | null;
      vendedorId: string | null;
      ticket_count: number;
      total_sales: number;
      total_payouts: number;
      vendedor_commission: number;
      listero_commission: number;
      balance: number;
    }>();

    for (const summary of summaries) {
      const dateKey = summary.date.toISOString().split("T")[0];
      resultMap.set(dateKey, {
        date: summary.date,
        ventanaId: summary.ventanaId,
        vendedorId: summary.vendedorId,
        ticket_count: Number(summary.ticket_count),
        total_sales: summary.total_sales,
        total_payouts: summary.total_payouts,
        vendedor_commission: summary.vendedor_commission,
        listero_commission: summary.listero_commission,
        balance: summary.balance,
      });
    }

    return resultMap;
  } catch (error: any) {
    // Si la vista materializada no existe o hay error, retornar Map vacío
    // El código fallback usará calculateDayStatement
    logger.warn({
      layer: "service",
      action: "MATERIALIZED_VIEW_QUERY_FAILED",
      payload: { error: error.message },
    });
    return new Map();
  }
}

/**
 * ✅ OPTIMIZACIÓN: Obtiene el desglose por sorteo para múltiples días en batch
 * Retorna un Map<dateKey, Array<{...}>>
 */
async function getSorteoBreakdownBatch(
  dates: Date[],
  dimension: "ventana" | "vendedor",
  ventanaId?: string,
  vendedorId?: string,
  bancaId?: string
): Promise<Map<string, Array<{
  sorteoId: string;
  sorteoName: string;
  loteriaId: string;
  loteriaName: string;
  scheduledAt: string;
  sales: number;
  payouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  balance: number;
  ticketCount: number;
}>>> {
  if (dates.length === 0) {
    return new Map();
  }

  // Construir filtro de fechas combinado
  const dateFilters = dates.map(date => buildTicketDateFilter(date));
  const where: any = {
    OR: dateFilters,
    deletedAt: null,
    status: { not: "CANCELLED" },
  };

  // Filtrar por banca activa (para ADMIN multibanca)
  if (bancaId) {
    where.ventana = {
      bancaId: bancaId,
    };
  }

  if (dimension === "ventana" && ventanaId) {
    where.ventanaId = ventanaId;
  } else if (dimension === "vendedor" && vendedorId) {
    where.vendedorId = vendedorId;
  }

  // ✅ OPTIMIZACIÓN: Una sola query para todos los días
  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true,
      totalAmount: true,
      sorteoId: true,
      businessDate: true,
      createdAt: true,
      ventanaId: true,
      vendedorId: true,
      sorteo: {
        select: {
          id: true,
          name: true,
          scheduledAt: true,
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      jugadas: {
        where: { deletedAt: null },
        select: {
          payout: true,
          isWinner: true,
          commissionAmount: true,
          commissionOrigin: true,
        },
      },
    },
  });

  // Crear Map por fecha
  const resultMap = new Map<string, Map<string, {
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: Date;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    ticketCount: number;
  }>>();

  // Inicializar mapas por fecha
  for (const date of dates) {
    const dateKey = date.toISOString().split("T")[0];
    resultMap.set(dateKey, new Map());
  }

  // Agrupar tickets por fecha y sorteo
  for (const ticket of tickets) {
    if (!ticket.sorteoId || !ticket.sorteo) continue;

    // Determinar la fecha del ticket
    const ticketDate = ticket.businessDate 
      ? new Date(ticket.businessDate)
      : new Date(ticket.createdAt);
    ticketDate.setUTCHours(0, 0, 0, 0);
    const dateKey = ticketDate.toISOString().split("T")[0];
    
    const sorteoMap = resultMap.get(dateKey);
    if (!sorteoMap) continue; // Skip si la fecha no está en el rango

    const sorteoId = ticket.sorteo.id;
    let entry = sorteoMap.get(sorteoId);

    if (!entry) {
      entry = {
        sorteoId,
        sorteoName: ticket.sorteo.name,
        loteriaId: ticket.sorteo.loteria.id,
        loteriaName: ticket.sorteo.loteria.name,
        scheduledAt: ticket.sorteo.scheduledAt,
        sales: 0,
        payouts: 0,
        listeroCommission: 0,
        vendedorCommission: 0,
        ticketCount: 0,
      };
      sorteoMap.set(sorteoId, entry);
    }

    entry.sales += ticket.totalAmount || 0;
    entry.ticketCount += 1;

    // Calcular payouts y comisiones desde jugadas
    for (const jugada of ticket.jugadas) {
      if (jugada.isWinner) {
        entry.payouts += jugada.payout || 0;
      }

      // Comisiones según origen
      if (jugada.commissionOrigin === "USER") {
        entry.vendedorCommission += jugada.commissionAmount || 0;
      } else if (jugada.commissionOrigin === "VENTANA" || jugada.commissionOrigin === "BANCA") {
        entry.listeroCommission += jugada.commissionAmount || 0;
      }
    }
  }

  // Convertir a formato de respuesta
  const finalMap = new Map<string, Array<{
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
  }>>();

  for (const [dateKey, sorteoMap] of resultMap.entries()) {
    const result = Array.from(sorteoMap.values())
      .map((entry) => ({
        sorteoId: entry.sorteoId,
        sorteoName: entry.sorteoName,
        loteriaId: entry.loteriaId,
        loteriaName: entry.loteriaName,
        scheduledAt: entry.scheduledAt.toISOString(),
        sales: entry.sales,
        payouts: entry.payouts,
        listeroCommission: entry.listeroCommission,
        vendedorCommission: entry.vendedorCommission,
        // Para VENTANA: solo resta comisión vendedor (listero es informativo)
        balance: entry.sales - entry.payouts - entry.vendedorCommission,
        ticketCount: entry.ticketCount,
      }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    
    finalMap.set(dateKey, result);
  }

  return finalMap;
}

/**
 * Obtiene el desglose por sorteo para un día específico (mantener para compatibilidad)
 */
async function getSorteoBreakdown(
  date: Date,
  dimension: "ventana" | "vendedor",
  ventanaId?: string,
  vendedorId?: string,
  bancaId?: string
): Promise<Array<{
  sorteoId: string;
  sorteoName: string;
  loteriaId: string;
  loteriaName: string;
  scheduledAt: string;
  sales: number;
  payouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  balance: number;
  ticketCount: number;
}>> {
  const dateFilter = buildTicketDateFilter(date);
  const where: any = {
    ...dateFilter,
    deletedAt: null,
    status: { not: "CANCELLED" },
  };

  // Filtrar por banca activa (para ADMIN multibanca)
  if (bancaId) {
    where.ventana = {
      bancaId: bancaId,
    };
  }

  if (dimension === "ventana" && ventanaId) {
    where.ventanaId = ventanaId;
  } else if (dimension === "vendedor" && vendedorId) {
    where.vendedorId = vendedorId;
  }

  // Obtener tickets con sus sorteos y loterías
  const tickets = await prisma.ticket.findMany({
    where,
    select: {
      id: true,
      totalAmount: true,
      sorteoId: true,
      sorteo: {
        select: {
          id: true,
          name: true,
          scheduledAt: true,
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      jugadas: {
        where: { deletedAt: null },
        select: {
          payout: true,
          isWinner: true,
          commissionAmount: true,
          commissionOrigin: true,
        },
      },
    },
  });

  // Agrupar por sorteo
  const sorteoMap = new Map<string, {
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: Date;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    ticketCount: number;
  }>();

  for (const ticket of tickets) {
    if (!ticket.sorteoId || !ticket.sorteo) continue;

    const sorteoId = ticket.sorteo.id;
    let entry = sorteoMap.get(sorteoId);

    if (!entry) {
      entry = {
        sorteoId,
        sorteoName: ticket.sorteo.name,
        loteriaId: ticket.sorteo.loteria.id,
        loteriaName: ticket.sorteo.loteria.name,
        scheduledAt: ticket.sorteo.scheduledAt,
        sales: 0,
        payouts: 0,
        listeroCommission: 0,
        vendedorCommission: 0,
        ticketCount: 0,
      };
      sorteoMap.set(sorteoId, entry);
    }

    entry.sales += ticket.totalAmount || 0;
    entry.ticketCount += 1;

    // Calcular payouts y comisiones desde jugadas
    for (const jugada of ticket.jugadas) {
      if (jugada.isWinner) {
        entry.payouts += jugada.payout || 0;
      }

      // Comisiones según origen
      if (jugada.commissionOrigin === "USER") {
        entry.vendedorCommission += jugada.commissionAmount || 0;
      } else if (jugada.commissionOrigin === "VENTANA" || jugada.commissionOrigin === "BANCA") {
        entry.listeroCommission += jugada.commissionAmount || 0;
      }
    }
  }

  // Calcular balance para cada sorteo y convertir a formato de respuesta
  const result = Array.from(sorteoMap.values())
    .map((entry) => ({
      sorteoId: entry.sorteoId,
      sorteoName: entry.sorteoName,
      loteriaId: entry.loteriaId,
      loteriaName: entry.loteriaName,
      scheduledAt: entry.scheduledAt.toISOString(),
      sales: entry.sales,
      payouts: entry.payouts,
      listeroCommission: entry.listeroCommission,
      vendedorCommission: entry.vendedorCommission,
      balance: entry.sales - entry.payouts - entry.listeroCommission - entry.vendedorCommission,
      ticketCount: entry.ticketCount,
    }))
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()); // Ordenar por scheduledAt ascendente

  return result;
}

/**
 * Obtiene los movimientos (pagos/cobros) de un statement para un día específico
 * Los movimientos se ordenan por createdAt (ascendente) para reflejar el orden cronológico
 * según lo especificado en BE_CUENTAS_REGISTRO_PAGO_COBRO.md
 */
async function getMovementsForDay(
  statementId: string
): Promise<Array<{
  id: string;
  accountStatementId: string;
  date: string;
  amount: number;
  type: "payment" | "collection";
  method: "cash" | "transfer" | "check" | "other";
  notes: string | null;
  isFinal: boolean;
  isReversed: boolean;
  reversedAt: Date | null;
  reversedBy: string | null;
  paidById: string;
  paidByName: string;
  createdAt: string;
  updatedAt: string;
}>> {
  const payments = await AccountPaymentRepository.findByStatementId(statementId);

  return payments
    .filter((p) => !p.isReversed) // Solo movimientos activos
    .map((p) => ({
      id: p.id,
      accountStatementId: p.accountStatementId,
      date: p.date.toISOString().split("T")[0],
      amount: p.amount,
      type: p.type as "payment" | "collection",
      method: p.method as "cash" | "transfer" | "check" | "other",
      notes: p.notes,
      isFinal: p.isFinal,
      isReversed: p.isReversed,
      reversedAt: p.reversedAt,
      reversedBy: p.reversedBy,
      paidById: p.paidById,
      paidByName: p.paidByName,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // Ordenar por createdAt ascendente
}

/**
 * Calcula y actualiza el estado de cuenta para un día específico
 */
export async function calculateDayStatement(
  date: Date,
  month: string,
  dimension: "ventana" | "vendedor",
  ventanaId?: string,
  vendedorId?: string,
  bancaId?: string
) {
  // Construir WHERE clause
  // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
  const dateFilter = buildTicketDateFilter(date);
  const where: any = {
    ...dateFilter,
    deletedAt: null,
    status: { not: "CANCELLED" },
  };

  // Filtrar por banca activa (para ADMIN multibanca)
  if (bancaId) {
    where.ventana = {
      bancaId: bancaId,
    };
  }

  // FIX: Validación defensiva - asegurar que ventanaId coincide en dimensión "ventana"
  if (dimension === "ventana" && ventanaId) {
    where.ventanaId = ventanaId;
  } else if (dimension === "vendedor" && vendedorId) {
    where.vendedorId = vendedorId;
  }

  // Usar agregaciones de Prisma para calcular totales directamente en la base de datos
  // Esto es mucho más eficiente que traer todos los tickets y jugadas a memoria
  const [ticketAgg, jugadaAggVendor, jugadaAggWinners] = await Promise.all([
    // Agregaciones de tickets
    prisma.ticket.aggregate({
      where,
      _sum: {
        totalAmount: true,
      },
      _count: {
        id: true,
      },
    }),
    // Agregaciones de jugadas - TODAS las jugadas para comisiones
    // IMPORTANTE: Para comisiones, incluir TODAS las jugadas (no solo ganadoras)
    // Las comisiones se aplican a todas las jugadas, no solo a las ganadoras
    prisma.jugada.aggregate({
      where: {
        ticket: where,
        deletedAt: null,
        commissionOrigin: "USER",
      },
      _sum: {
        commissionAmount: true,
      },
    }),
    // Agregaciones de jugadas - Solo jugadas ganadoras para payouts
    prisma.jugada.aggregate({
      where: {
        ticket: where,
        deletedAt: null,
        isWinner: true, // Solo jugadas ganadoras para payouts
      },
      _sum: {
        payout: true, // Total de premios (payout de jugadas ganadoras)
      },
    }),
  ]);

  // Calcular totales básicos desde agregaciones
  const totalSales = ticketAgg._sum.totalAmount || 0;
  // CRÍTICO: totalPayouts debe ser la suma de payout de jugadas ganadoras, no totalPaid de tickets
  // totalPaid de tickets es lo que se ha pagado, pero totalPayouts debe ser el total de premios ganados
  const totalPayouts = jugadaAggWinners._sum.payout || 0;
  const ticketCount = ticketAgg._count.id || 0;
  // FIX: Solo sumar comisiones del vendedor (commissionOrigin === "USER")
  const totalVendedorCommission = jugadaAggVendor._sum.commissionAmount || 0;

  // Calcular comisiones según dimensión
  let totalListeroCommission = 0;

  const listeroMap = await computeListeroCommissionsForWhere(
    where as Prisma.TicketWhereInput
  );

  if (dimension === "ventana") {
    totalListeroCommission = listeroMap.get(ventanaId || "") ?? 0;
  } else {
    totalListeroCommission = Array.from(listeroMap.values()).reduce(
      (sum, value) => sum + value,
      0
    );
  }

  // Calcular saldo según dimensión
  // Para VENTANA (dimension=ventana): solo resta comisión vendedor (listero es informativo)
  // Para VENDEDOR (dimension=vendedor): resta su propia comisión
  const balance = dimension === "ventana"
    ? totalSales - totalPayouts - totalVendedorCommission  // ✅ Solo resta comisión vendedor
    : totalSales - totalPayouts - totalVendedorCommission; // Para vendedor también solo resta su comisión

  // Si no hay tickets, retornar valores por defecto sin crear statement
  // FIX: No crear fechas nuevas cada vez para mantener consistencia
  if (ticketCount === 0) {
    // Intentar obtener statement existente si existe
    const existingStatement = await AccountStatementRepository.findByDate(date, {
      ventanaId,
      vendedorId,
    });

    if (existingStatement) {
      // ✅ FIX: Recalcular totalPaid y totalCollected desde movimientos activos
      // Esto asegura que los valores reflejen los movimientos actuales
      const recalculatedTotalPaid = await AccountPaymentRepository.getTotalPaid(existingStatement.id);
      const recalculatedTotalCollected = await AccountPaymentRepository.getTotalCollected(existingStatement.id);
      // ✅ NUEVO: Recalcular totalPaymentsCollections
      const recalculatedTotalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(existingStatement.id);
      // remainingBalance = balance - totalCollected + totalPaid
      // Como balance = 0 (no hay tickets), remainingBalance = 0 - totalCollected + totalPaid
      const recalculatedRemainingBalance = 0 - recalculatedTotalCollected + recalculatedTotalPaid;
      
      // ✅ FIX: Actualizar el statement con los valores recalculados
      await AccountStatementRepository.update(existingStatement.id, {
        totalPaid: recalculatedTotalPaid,
        totalCollected: recalculatedTotalCollected,
        remainingBalance: recalculatedRemainingBalance,
      });
      
      // Si existe, retornar el existente con valores recalculados
      return {
        ...existingStatement,
        totalSales: 0,
        totalPayouts: 0,
        listeroCommission: 0,
        vendedorCommission: 0,
        balance: 0,
        totalPaid: recalculatedTotalPaid,
        totalCollected: recalculatedTotalCollected,
        totalPaymentsCollections: recalculatedTotalPaymentsCollections, // ✅ NUEVO
        remainingBalance: recalculatedRemainingBalance,
        isSettled: false,
        canEdit: true,
        ticketCount: 0,
      };
    }

    // Si no existe, crear statement para tener un id
    // ✅ Calcular month desde la fecha si no está disponible
    const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const newStatement = await AccountStatementRepository.findOrCreate({
      date,
      month: monthForStatement,
      ventanaId,
      vendedorId,
    });
    
    return {
      ...newStatement,
      totalSales: 0,
      totalPayouts: 0,
      listeroCommission: 0,
      vendedorCommission: 0,
      balance: 0,
      totalPaid: 0,
      totalCollected: 0,
      totalPaymentsCollections: 0, // ✅ NUEVO
      remainingBalance: 0,
      isSettled: false, // No está saldado si no hay tickets
      canEdit: true,
      ticketCount: 0,
    };
  }

  // CRITICAL: Determinar el tipo de statement que necesitamos antes de buscar/crear
  // El constraint requiere que solo uno de ventanaId o vendedorId sea no-null
  // Además, hay constraints únicos: (date, ventanaId) y (date, vendedorId)
  // Convertir null a undefined para compatibilidad con TypeScript
  const targetVentanaId = vendedorId ? undefined : (ventanaId ?? undefined);
  const targetVendedorId = vendedorId ?? undefined;

  // Crear o actualizar estado de cuenta primero con los valores correctos
  // findOrCreate ya maneja correctamente la búsqueda según ventanaId o vendedorId
  // ✅ Calcular month desde la fecha si no está disponible
  const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const statement = await AccountStatementRepository.findOrCreate({
    date,
    month: monthForStatement,
    ventanaId: targetVentanaId,
    vendedorId: targetVendedorId,
  });

  // CRITICAL: Verificar que el statement encontrado tiene el tipo correcto
  // No podemos cambiar el tipo de un statement existente porque violaría los constraints únicos
  const statementIsVentana = statement.ventanaId !== null && statement.vendedorId === null;
  const statementIsVendedor = statement.vendedorId !== null && statement.ventanaId === null;
  const needsVentana = targetVentanaId !== undefined;
  const needsVendedor = targetVendedorId !== undefined;

  // Si el tipo no coincide (caso edge: statement corrupto), buscar el correcto
  let finalStatement = statement;
  if ((needsVentana && !statementIsVentana) || (needsVendedor && !statementIsVendedor)) {
    // Buscar específicamente el statement correcto usando findByDate
    const correctStatement = await AccountStatementRepository.findByDate(date, {
      ventanaId: targetVentanaId,
      vendedorId: targetVendedorId,
    });
    
    if (correctStatement) {
      finalStatement = correctStatement;
    } else {
      // Si no existe, crear uno nuevo (findOrCreate debería haberlo hecho, pero por seguridad)
      // ✅ Calcular month desde la fecha si no está disponible
      const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      finalStatement = await AccountStatementRepository.findOrCreate({
        date,
        month: monthForStatement,
        ventanaId: targetVentanaId,
        vendedorId: targetVendedorId,
      });
    }
  }

  // Obtener total pagado y cobrado después de crear el statement
  const totalPaid = await AccountPaymentRepository.getTotalPaid(finalStatement.id);
  const totalCollected = await AccountPaymentRepository.getTotalCollected(finalStatement.id);
  // ✅ NUEVO: Obtener total de pagos y cobros combinados (no revertidos)
  const totalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(finalStatement.id);

  // Calcular saldo restante: remainingBalance = balance - totalCollected + totalPaid
  // Lógica:
  // - Collection (cobro): reduce remainingBalance cuando es positivo (resta totalCollected)
  // - Payment (pago): reduce remainingBalance cuando es negativo (suma totalPaid)
  // Fórmula: remainingBalance = balance - totalCollected + totalPaid
  const remainingBalance = balance - totalCollected + totalPaid;

  // FIX: Usar helper para cálculo consistente de isSettled
  const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);
  const canEdit = !isSettled;

  // ✅ FIX: Guardar también totalCollected en el statement
  await AccountStatementRepository.update(finalStatement.id, {
    totalSales,
    totalPayouts,
    listeroCommission: totalListeroCommission,
    vendedorCommission: totalVendedorCommission,
    balance,
    totalPaid,
    totalCollected, // ✅ NUEVO: Guardar totalCollected
    remainingBalance,
    isSettled,
    canEdit,
    ticketCount,
    // No cambiar ventanaId/vendedorId aquí - ya están correctos en finalStatement
  });

  return {
    ...finalStatement,
    totalSales,
    totalPayouts,
    listeroCommission: totalListeroCommission,
    vendedorCommission: totalVendedorCommission,
    balance,
    totalPaid,
    totalCollected, // Agregar totalCollected al objeto retornado
    totalPaymentsCollections, // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
    remainingBalance,
    isSettled,
    canEdit,
    ticketCount,
    ventanaId: finalStatement.ventanaId,
    vendedorId: finalStatement.vendedorId,
  };
}

/**
 * ✅ OPTIMIZACIÓN: Obtiene statement desde la vista materializada
 * Esta función es MUCHO más rápida que calcular desde cero
 */
async function getStatementFromMaterializedView(
  filters: AccountsFilters,
  materializedSummaries: Map<string, {
    date: Date;
    ventanaId: string | null;
    vendedorId: string | null;
    ticket_count: number;
    total_sales: number;
    total_payouts: number;
    vendedor_commission: number;
    listero_commission: number;
    balance: number;
  }>,
  startDate: Date,
  endDate: Date,
  daysInMonth: number
) {
  const { month, date, fromDate, toDate, dimension, ventanaId, vendedorId, bancaId, sort = "desc" } = filters;
  
  // Calcular effectiveMonth para compatibilidad
  let effectiveMonth: string;
  if (date) {
    effectiveMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
  } else if (month) {
    effectiveMonth = month;
  } else {
    const today = new Date();
    effectiveMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  
  // Obtener o crear AccountStatement para cada día (para movimientos y otros datos)
  const statementDates = Array.from(materializedSummaries.values()).map(s => s.date);
  const statementsMap = new Map<string, {
    id: string;
    date: Date;
    ventanaId: string | null;
    vendedorId: string | null;
    totalSales: number;
    totalPayouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    totalPaid: number;
    totalCollected: number;
    remainingBalance: number;
    isSettled: boolean;
    canEdit: boolean;
    ticketCount: number;
    createdAt: Date;
    updatedAt: Date;
  }>();
  
  // Obtener statements existentes o crearlos
  for (const summary of materializedSummaries.values()) {
    const dateKey = summary.date.toISOString().split("T")[0];
    let statement: {
      id: string;
      date: Date;
      ventanaId: string | null;
      vendedorId: string | null;
      totalSales: number;
      totalPayouts: number;
      listeroCommission: number;
      vendedorCommission: number;
      balance: number;
      totalPaid: number;
      totalCollected: number;
      remainingBalance: number;
      isSettled: boolean;
      canEdit: boolean;
      ticketCount: number;
      createdAt: Date;
      updatedAt: Date;
    } | null = await AccountStatementRepository.findByDate(summary.date, {
      ventanaId: summary.ventanaId ?? undefined,
      vendedorId: summary.vendedorId ?? undefined,
    });
    
    if (!statement) {
      // Crear statement si no existe
      const newStatement = await AccountStatementRepository.findOrCreate({
        date: summary.date,
        month: effectiveMonth, // ✅ Usar effectiveMonth en lugar de month (que puede ser undefined)
        ventanaId: summary.ventanaId ?? undefined,
        vendedorId: summary.vendedorId ?? undefined,
      });
      statement = newStatement as NonNullable<typeof statement>;
    }
    
    if (statement) {
      statementsMap.set(dateKey, statement);
    }
  }
  
  // Obtener IDs de statements para batch queries
  const statementIds = Array.from(statementsMap.values()).map(s => s.id);
  
  // Obtener totales y movimientos en batch
  const [totalsBatch, movementsBatch, sorteoBreakdownBatch] = await Promise.all([
    AccountPaymentRepository.getTotalsBatch(statementIds),
    AccountPaymentRepository.findMovementsBatch(statementIds),
    getSorteoBreakdownBatch(statementDates, dimension, ventanaId, vendedorId, bancaId),
  ]);
  
  // Obtener información de ventanas/vendedores
  const ventanaInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();
  const vendedorInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();
  
  const ventanaIds = Array.from(materializedSummaries.values())
    .map(s => s.ventanaId)
    .filter((id): id is string => id !== null);
  const vendedorIds = Array.from(materializedSummaries.values())
    .map(s => s.vendedorId)
    .filter((id): id is string => id !== null);
  
  if (ventanaIds.length > 0) {
    const ventanas = await prisma.ventana.findMany({
      where: { id: { in: ventanaIds } },
      select: { id: true, name: true, code: true },
    });
    for (const ventana of ventanas) {
      ventanaInfoMap.set(ventana.id, {
        id: ventana.id,
        name: ventana.name,
        code: ventana.code,
      });
    }
  }
  
  if (vendedorIds.length > 0) {
    const vendedores = await prisma.user.findMany({
      where: { id: { in: vendedorIds } },
      select: { id: true, name: true, code: true },
    });
    for (const vendedor of vendedores) {
      vendedorInfoMap.set(vendedor.id, {
        id: vendedor.id,
        name: vendedor.name,
        code: vendedor.code || null,
      });
    }
  }
  
  // Construir statements desde la vista materializada
  const statementsToUpdate: Array<{ id: string; totalPaid: number; totalCollected: number; remainingBalance: number }> = [];
  const statements = Array.from(materializedSummaries.entries())
    .map(([dateKey, summary]) => {
      const statement = statementsMap.get(dateKey);
      if (!statement) return null;
      
      const totals = totalsBatch.get(statement.id) || { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 };
      const verifiedTotalPaid = totals.totalPaid;
      const verifiedTotalCollected = totals.totalCollected;
      const verifiedTotalPaymentsCollections = totals.totalPaymentsCollections; // ✅ NUEVO
      const verifiedRemainingBalance = summary.balance - verifiedTotalCollected + verifiedTotalPaid;
      
      // Preparar actualización si es necesario
      if (Math.abs(verifiedTotalPaid - statement.totalPaid) > 0.01 || 
          Math.abs(verifiedTotalCollected - statement.totalCollected) > 0.01 ||
          Math.abs(verifiedRemainingBalance - statement.remainingBalance) > 0.01) {
        statementsToUpdate.push({
          id: statement.id,
          totalPaid: verifiedTotalPaid,
          totalCollected: verifiedTotalCollected,
          remainingBalance: verifiedRemainingBalance,
        });
      }
      
      const movements = movementsBatch.get(statement.id) || [];
      const bySorteo = sorteoBreakdownBatch.get(dateKey) || [];
      
      const base = {
        date: summary.date.toISOString().split("T")[0],
        totalSales: summary.total_sales,
        totalPayouts: summary.total_payouts,
        listeroCommission: summary.listero_commission,
        vendedorCommission: summary.vendedor_commission,
        balance: summary.balance,
        totalPaid: verifiedTotalPaid,
        totalCollected: verifiedTotalCollected,
        totalPaymentsCollections: verifiedTotalPaymentsCollections, // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
        remainingBalance: verifiedRemainingBalance,
        isSettled: calculateIsSettled(
          summary.ticket_count,
          verifiedRemainingBalance,
          verifiedTotalPaid,
          verifiedTotalCollected
        ),
        canEdit: !calculateIsSettled(
          summary.ticket_count,
          verifiedRemainingBalance,
          verifiedTotalPaid,
          verifiedTotalCollected
        ),
        ticketCount: summary.ticket_count,
        createdAt: statement.createdAt.toISOString(),
        updatedAt: statement.updatedAt.toISOString(),
        bySorteo,
        movements,
      };
      
      if (dimension === "ventana") {
        return {
          ...base,
          ventanaId: summary.ventanaId,
          ventanaName: summary.ventanaId ? ventanaInfoMap.get(summary.ventanaId)?.name || null : null,
          ventanaCode: summary.ventanaId ? ventanaInfoMap.get(summary.ventanaId)?.code || null : null,
        };
      } else {
        return {
          ...base,
          vendedorId: summary.vendedorId,
          vendedorName: summary.vendedorId ? vendedorInfoMap.get(summary.vendedorId)?.name || null : null,
          vendedorCode: summary.vendedorId ? vendedorInfoMap.get(summary.vendedorId)?.code || null : null,
        };
      }
    })
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      return sort === "desc" ? dateB - dateA : dateA - dateB;
    });
  
  // Actualizar statements en batch si es necesario
  if (statementsToUpdate.length > 0) {
    await Promise.all(
      statementsToUpdate.map(({ id, totalPaid, totalCollected, remainingBalance }) =>
        AccountStatementRepository.update(id, {
          totalPaid,
          totalCollected,
          remainingBalance,
        })
      )
    );
  }
  
  // Calcular totales
  const totals = {
    totalSales: statements.reduce((sum, s) => sum + s.totalSales, 0),
    totalPayouts: statements.reduce((sum, s) => sum + s.totalPayouts, 0),
    totalListeroCommission: statements.reduce((sum, s) => sum + s.listeroCommission, 0),
    totalVendedorCommission: statements.reduce((sum, s) => sum + s.vendedorCommission, 0),
    totalBalance: statements.reduce((sum, s) => sum + s.balance, 0),
    totalPaid: statements.reduce((sum, s) => sum + s.totalPaid, 0),
    totalCollected: statements.reduce((sum, s) => sum + s.totalCollected, 0),
    totalRemainingBalance: statements.reduce((sum, s) => sum + s.remainingBalance, 0),
    settledDays: statements.filter((s) => s.isSettled).length,
    pendingDays: statements.filter((s) => !s.isSettled).length,
  };
  
  const meta = {
    month: effectiveMonth, // ✅ Usar effectiveMonth para compatibilidad
    ...(date ? { date, fromDate, toDate } : {}), // ✅ Incluir filtros de período si se usaron
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],
    dimension,
    totalDays: daysInMonth,
  };
  
  return {
    statements,
    totals,
    meta,
  };
}

/**
 * Accounts Service
 * Proporciona endpoints para consultar y gestionar estados de cuenta
 */
export const AccountsService = {
  /**
   * Obtiene el estado de cuenta día a día del mes o período
   */
  async getStatement(filters: AccountsFilters) {
    const { month, date, fromDate, toDate, dimension, ventanaId, vendedorId, bancaId, sort = "desc" } = filters;
    
    // ✅ NUEVO: Resolver rango de fechas según filtros proporcionados
    // Prioridad: date > month > mes actual por defecto
    let startDate: Date;
    let endDate: Date;
    let daysInMonth: number;
    let effectiveMonth: string;
    
    if (date) {
      // Usar filtros de período (date, fromDate, toDate)
      const dateRange = resolveDateRange(date, fromDate, toDate);
      startDate = dateRange.fromAt;
      endDate = dateRange.toAt;
      // Calcular días en el rango
      const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
      daysInMonth = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      // Usar el mes del inicio del rango para compatibilidad
      effectiveMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
    } else if (month) {
      // Usar filtro de mes (comportamiento existente)
      const monthRange = getMonthDateRange(month);
      startDate = monthRange.startDate;
      endDate = monthRange.endDate;
      daysInMonth = monthRange.daysInMonth;
      effectiveMonth = month;
    } else {
      // Por defecto: mes actual
      const today = new Date();
      const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
      const monthRange = getMonthDateRange(currentMonth);
      startDate = monthRange.startDate;
      endDate = monthRange.endDate;
      daysInMonth = monthRange.daysInMonth;
      effectiveMonth = currentMonth;
    }
    
    // ✅ OPTIMIZACIÓN: Intentar leer de la vista materializada primero (MUY RÁPIDO)
    const materializedSummaries = await getDailySummariesFromMaterializedView(
      startDate,
      endDate,
      dimension,
      ventanaId,
      vendedorId,
      sort as "asc" | "desc"
    );
    
    // Si la vista materializada tiene datos, usarla; si no, usar método tradicional
    const useMaterializedView = materializedSummaries.size > 0;
    
    // ✅ OPTIMIZACIÓN: Si tenemos datos de la vista materializada, usarlos directamente
    if (useMaterializedView && materializedSummaries.size > 0) {
      return await getStatementFromMaterializedView(
        filters,
        materializedSummaries,
        startDate,
        endDate,
        daysInMonth
      );
    }

    // Si scope=all y no hay ventanaId/vendedorId, obtener estados existentes
    // Si no hay estados existentes, calcular basándose en tickets del mes
    const ventanaInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();
    const vendedorInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();

    if (!ventanaId && !vendedorId) {
      // ✅ CRÍTICO: Si date está presente, NO usar findByMonth (no procesar mes completo)
      // Filtrar directamente por rango de fechas en la query de base de datos
      let statementsWithRelations: Array<{
        id: string;
        date: Date;
        ventanaId: string | null;
        vendedorId: string | null;
        totalSales: number;
        totalPayouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        balance: number;
        totalPaid: number;
        totalCollected: number;
        remainingBalance: number;
        isSettled: boolean;
        canEdit: boolean;
        ticketCount: number;
        createdAt: Date;
        updatedAt: Date;
        ventana?: { id: string; name: string; code: string } | null;
        vendedor?: { id: string; name: string; code: string } | null;
      }>;

      if (date) {
        // ✅ Filtrar DIRECTAMENTE por rango de fechas cuando date está presente
        // NO procesar el mes completo
        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];
        
        statementsWithRelations = (await prisma.accountStatement.findMany({
          where: {
            date: {
              gte: new Date(startDateStr + "T00:00:00.000Z"),
              lte: new Date(endDateStr + "T23:59:59.999Z"),
            },
          },
          orderBy: {
            date: sort as "asc" | "desc",
          },
          include: {
            ventana: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
            vendedor: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        })) as typeof statementsWithRelations;
      } else {
        // Solo usar findByMonth si date NO está presente (compatibilidad hacia atrás)
        statementsWithRelations = (await AccountStatementRepository.findByMonth(
          effectiveMonth,
          {},
          {
            sort: sort as "asc" | "desc",
            include: {
              ventana: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
              vendedor: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          }
        )) as typeof statementsWithRelations;
      }

      // Filtrar por dimensión (el filtro de fecha ya se aplicó arriba si date estaba presente)
      const existingStatementsForDimension = statementsWithRelations.filter((s) => {
        // Filtrar por dimensión
        const matchesDimension = dimension === "ventana" 
          ? (s.ventanaId !== null && s.vendedorId === null)
          : (s.vendedorId !== null && s.ventanaId === null);
        
        if (!matchesDimension) return false;
        
        // ✅ Si date está presente, el filtro de fecha ya se aplicó en la query de arriba
        // Solo aplicar lógica adicional si date NO está presente (compatibilidad hacia atrás)
        if (!date) {
          const statementDate = new Date(s.date);
          statementDate.setUTCHours(0, 0, 0, 0);
          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          
          // Si el mes del statement es el mes actual, solo incluir hasta hoy
          const isCurrentMonth = statementDate.getUTCFullYear() === today.getUTCFullYear() &&
                                 statementDate.getUTCMonth() === today.getUTCMonth();
          
          if (isCurrentMonth) {
            return statementDate <= today;
          }
        }
        
        return true;
      });

      // ✅ OPTIMIZACIÓN: Solo recalcular statements si hay cambios recientes
      // Verificar si hay tickets nuevos o movimientos nuevos desde updatedAt del statement
      const todayForCheck = new Date();
      todayForCheck.setUTCHours(0, 0, 0, 0);
      const twoDaysAgo = new Date(todayForCheck);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      
      // Obtener IDs de statements para verificar cambios
      const statementIdsForCheck = existingStatementsForDimension.map(s => s.id);
      
      // Verificar si hay tickets nuevos o movimientos nuevos para estos statements
      const [recentTickets, recentPayments] = await Promise.all([
        // Tickets creados o actualizados recientemente que afectan estos statements
        prisma.ticket.findMany({
          where: {
            OR: [
              { businessDate: { gte: twoDaysAgo } },
              { createdAt: { gte: twoDaysAgo } },
            ],
            deletedAt: null,
            status: { not: "CANCELLED" },
            ...(dimension === "ventana" 
              ? { ventanaId: { in: existingStatementsForDimension.filter(s => s.ventanaId).map(s => s.ventanaId!) } }
              : { vendedorId: { in: existingStatementsForDimension.filter(s => s.vendedorId).map(s => s.vendedorId!) } }
            ),
          },
          select: {
            businessDate: true,
            createdAt: true,
            ventanaId: true,
            vendedorId: true,
          },
        }),
        // Movimientos creados recientemente para estos statements
        prisma.accountPayment.findMany({
          where: {
            accountStatementId: { in: statementIdsForCheck },
            createdAt: { gte: twoDaysAgo },
          },
          select: {
            accountStatementId: true,
          },
        }),
      ]);

      // Crear Set de statementIds que tienen cambios recientes
      const statementsWithChanges = new Set<string>();
      for (const ticket of recentTickets) {
        const ticketDate = ticket.businessDate 
          ? new Date(ticket.businessDate)
          : new Date(ticket.createdAt);
        ticketDate.setUTCHours(0, 0, 0, 0);
        const dateKey = ticketDate.toISOString().split("T")[0];
        const targetId = dimension === "ventana" ? ticket.ventanaId : ticket.vendedorId;
        if (targetId) {
          const key = `${dateKey}-${targetId}`;
          const statement = existingStatementsForDimension.find(s => {
            const sDateKey = s.date.toISOString().split("T")[0];
            const sTargetId = dimension === "ventana" ? s.ventanaId : s.vendedorId;
            return `${sDateKey}-${sTargetId}` === key;
          });
          if (statement) {
            statementsWithChanges.add(statement.id);
          }
        }
      }
      for (const payment of recentPayments) {
        statementsWithChanges.add(payment.accountStatementId);
      }

      // Solo recalcular statements con cambios recientes o si updatedAt es muy antiguo
      let filteredStatements: DayStatement[] = await Promise.all(
        existingStatementsForDimension.map(async (s) => {
          const statementDate = new Date(s.date);
          statementDate.setUTCHours(0, 0, 0, 0);
          
          const hasRecentChanges = statementsWithChanges.has(s.id);
          const isOld = s.updatedAt < twoDaysAgo;
          
          if (hasRecentChanges || isOld) {
            // Recalcular si hay cambios recientes o si el statement es muy antiguo
            return await calculateDayStatement(
              statementDate,
              effectiveMonth, // ✅ Usar effectiveMonth en lugar de month (que puede ser undefined)
              dimension,
              s.ventanaId ?? undefined,
              s.vendedorId ?? undefined,
              bancaId
            );
          } else {
            // Usar valores guardados y solo refrescar movimientos (ya optimizado con batch)
            return {
              ...s,
              date: statementDate,
            } as DayStatement;
          }
        })
      );

      // Detectar días/targets del mes que tienen tickets pero aún no existen como statements
      const existingKeys = new Set<string>();
      for (const s of filteredStatements) {
        const dateKey = s.date.toISOString().split("T")[0];
        const targetId = dimension === "ventana" ? s.ventanaId : s.vendedorId;
        if (targetId) {
          existingKeys.add(`${dateKey}-${targetId}`);
        }
      }

      const ticketsInMonth = await prisma.ticket.findMany({
        where: {
          OR: [
            {
              businessDate: {
                gte: startDate,
                lte: endDate,
              },
            },
            {
              businessDate: null,
              createdAt: {
                gte: startDate,
                lte: endDate,
              },
            },
          ],
          deletedAt: null,
          status: { not: "CANCELLED" },
        },
        select: {
          ventanaId: true,
          vendedorId: true,
          businessDate: true,
          createdAt: true,
        },
      });

      const pendingStatements = new Map<string, { date: Date; ventanaId?: string; vendedorId?: string }>();
      const todayForPending = new Date();
      todayForPending.setUTCHours(0, 0, 0, 0);

      for (const ticket of ticketsInMonth) {
        const ticketDate = ticket.businessDate
          ? new Date(ticket.businessDate)
          : new Date(ticket.createdAt);
        ticketDate.setUTCHours(0, 0, 0, 0);

        const isCurrentMonth = ticketDate.getUTCFullYear() === todayForPending.getUTCFullYear() &&
          ticketDate.getUTCMonth() === todayForPending.getUTCMonth();
        if (isCurrentMonth && ticketDate > todayForPending) {
          continue;
        }

        const dateKey = ticketDate.toISOString().split("T")[0];
        if (dimension === "ventana") {
          if (!ticket.ventanaId) continue;
          const key = `${dateKey}-${ticket.ventanaId}`;
          if (existingKeys.has(key) || pendingStatements.has(key)) continue;
          pendingStatements.set(key, {
            date: ticketDate,
            ventanaId: ticket.ventanaId,
          });
        } else {
          if (!ticket.vendedorId) continue;
          const key = `${dateKey}-${ticket.vendedorId}`;
          if (existingKeys.has(key) || pendingStatements.has(key)) continue;
          pendingStatements.set(key, {
            date: ticketDate,
            vendedorId: ticket.vendedorId,
          });
        }
      }

      if (pendingStatements.size > 0) {
        const additionalStatements: DayStatement[] = [];
        for (const info of pendingStatements.values()) {
          const calculated = await calculateDayStatement(
            info.date,
            effectiveMonth, // ✅ Usar effectiveMonth en lugar de month (que puede ser undefined)
            dimension,
            info.ventanaId,
            info.vendedorId,
            bancaId
          );
          additionalStatements.push(calculated);
        }
        filteredStatements = filteredStatements.concat(additionalStatements);
      }

      // Si no hay statements existentes (después de filtrar), calcular basándose en tickets del mes
      if (filteredStatements.length === 0) {
        logger.info({
          layer: "service",
          action: "ACCOUNTS_STATEMENT_CALCULATE_FROM_TICKETS",
          payload: { month, dimension, message: "No hay statements existentes, calculando desde tickets" },
        });

        // Obtener todas las ventanas/vendedores que tienen tickets en el mes
        // FIX: Usar businessDate si existe, fallback a createdAt
        const tickets = await prisma.ticket.findMany({
          where: {
            OR: [
              {
                businessDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                businessDate: null,
                createdAt: {
                  gte: startDate,
                  lte: endDate,
                },
              },
            ],
            deletedAt: null,
            status: { not: "CANCELLED" },
          },
          select: {
            id: true,
            ventanaId: true,
            vendedorId: true,
            businessDate: true,
            createdAt: true,
          },
        });

        // Agrupar por ventana/vendedor y fecha
        const statementsMap = new Map<string, any>();

        for (const ticket of tickets) {
          // FIX: Usar businessDate si existe, fallback a createdAt
          const ticketDate = ticket.businessDate 
            ? new Date(ticket.businessDate)
            : new Date(ticket.createdAt);
          ticketDate.setUTCHours(0, 0, 0, 0);
          const dateKey = ticketDate.toISOString().split("T")[0];

          if (dimension === "ventana" && ticket.ventanaId) {
            const key = `${dateKey}-${ticket.ventanaId}`;
            if (!statementsMap.has(key)) {
              statementsMap.set(key, {
                date: ticketDate,
                ventanaId: ticket.ventanaId,
                vendedorId: null,
              });
            }
          } else if (dimension === "vendedor" && ticket.vendedorId) {
            const key = `${dateKey}-${ticket.vendedorId}`;
            if (!statementsMap.has(key)) {
              statementsMap.set(key, {
                date: ticketDate,
                ventanaId: null,
                vendedorId: ticket.vendedorId,
              });
            }
          }
        }

        // Calcular statements para cada día/ventana o día/vendedor
        // FIX: Filtrar días futuros antes de calcular statements
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        
        const calculatedStatements = [];
        for (const [key, statementInfo] of statementsMap) {
          // Excluir días futuros cuando el mes consultado es el mes actual
          const statementDate = new Date(statementInfo.date);
          statementDate.setUTCHours(0, 0, 0, 0);
          
          const isCurrentMonth = statementDate.getUTCFullYear() === today.getUTCFullYear() &&
                                 statementDate.getUTCMonth() === today.getUTCMonth();
          
          if (isCurrentMonth && statementDate > today) {
            // Saltar días futuros del mes actual
            continue;
          }
          
          const calculated = await calculateDayStatement(
            statementInfo.date,
            effectiveMonth, // ✅ Usar effectiveMonth en lugar de month (que puede ser undefined)
            dimension,
            statementInfo.ventanaId || undefined,
            statementInfo.vendedorId || undefined,
            bancaId
          );

          // Obtener relaciones para nombres y códigos
          let ventana = null;
          let vendedor = null;

          if (calculated.ventanaId) {
            const ventanaData = await prisma.ventana.findUnique({
              where: { id: calculated.ventanaId },
              select: { id: true, name: true, code: true },
            });
            ventana = ventanaData;
          }

          if (calculated.vendedorId) {
            const vendedorData = await prisma.user.findUnique({
              where: { id: calculated.vendedorId },
              select: { id: true, name: true, code: true },
            });
            vendedor = vendedorData ? {
              id: vendedorData.id,
              name: vendedorData.name,
              code: vendedorData.code || "",
            } : null;
          }

          calculatedStatements.push({
            ...calculated,
            ventana,
            vendedor,
          });
        }

        // Ordenar según sort
        if (sort === "asc") {
          calculatedStatements.sort((a, b) => a.date.getTime() - b.date.getTime());
        } else {
          calculatedStatements.sort((a, b) => b.date.getTime() - a.date.getTime());
        }

        filteredStatements = calculatedStatements;
      } else {
        // Ordenar statements existentes según sort
        if (sort === "asc") {
          filteredStatements.sort((a, b) => a.date.getTime() - b.date.getTime());
        } else {
          filteredStatements.sort((a, b) => b.date.getTime() - a.date.getTime());
        }
      }

      // Mapear info de ventana/vendedor existente
      for (const s of statementsWithRelations) {
        if (s.ventana) {
          ventanaInfoMap.set(s.ventana.id, {
            id: s.ventana.id,
            name: s.ventana.name,
            code: s.ventana.code,
          });
        }
        if (s.vendedor) {
          vendedorInfoMap.set(s.vendedor.id, {
            id: s.vendedor.id,
            name: s.vendedor.name,
            code: s.vendedor.code,
          });
        }
      }

      // Cargar info faltante
      const ventanaIdsNeeded = new Set<string>();
      const vendedorIdsNeeded = new Set<string>();
      for (const s of filteredStatements) {
        if (s.ventanaId) ventanaIdsNeeded.add(s.ventanaId);
        if (s.vendedorId) vendedorIdsNeeded.add(s.vendedorId);
      }

      const ventanaIdsToFetch = Array.from(ventanaIdsNeeded).filter(
        (id) => !ventanaInfoMap.has(id)
      );
      if (ventanaIdsToFetch.length > 0) {
        const ventanas = await prisma.ventana.findMany({
          where: { id: { in: ventanaIdsToFetch } },
          select: { id: true, name: true, code: true },
        });
        for (const ventana of ventanas) {
          ventanaInfoMap.set(ventana.id, {
            id: ventana.id,
            name: ventana.name,
            code: ventana.code,
          });
        }
      }

      const vendedorIdsToFetch = Array.from(vendedorIdsNeeded).filter(
        (id) => !vendedorInfoMap.has(id)
      );
      if (vendedorIdsToFetch.length > 0) {
        const vendedores = await prisma.user.findMany({
          where: { id: { in: vendedorIdsToFetch } },
          select: { id: true, name: true, code: true },
        });
        for (const vendedor of vendedores) {
          vendedorInfoMap.set(vendedor.id, {
            id: vendedor.id,
            name: vendedor.name,
            code: vendedor.code || null,
          });
        }
      }

      // ✅ OPTIMIZACIÓN: Obtener todos los IDs de statements para hacer batch queries
      const statementIdsForBatch = filteredStatements.map(s => s.id);
      
      // ✅ OPTIMIZACIÓN: Obtener fechas para batch query de getSorteoBreakdown
      const statementDatesForBatch = filteredStatements.map(s => {
        const d = new Date(s.date);
        d.setUTCHours(0, 0, 0, 0);
        return d;
      });
      
      // ✅ OPTIMIZACIÓN: Obtener totales, movimientos y breakdowns en batch (una sola query en lugar de N queries)
      const [totalsBatch, movementsBatch, sorteoBreakdownBatch] = await Promise.all([
        AccountPaymentRepository.getTotalsBatch(statementIdsForBatch),
        AccountPaymentRepository.findMovementsBatch(statementIdsForBatch),
        getSorteoBreakdownBatch(statementDatesForBatch, dimension, undefined, undefined, bancaId),
      ]);

      // ✅ OPTIMIZACIÓN: Preparar actualizaciones batch para statements que necesitan actualización
      const statementsToUpdate: Array<{ id: string; totalPaid: number; totalCollected: number; remainingBalance: number }> = [];

      // Obtener bySorteo y movements para cada statement en paralelo
      const statements = await Promise.all(
        filteredStatements.map(async (s) => {
          // ✅ OPTIMIZACIÓN: Usar valores del batch en lugar de queries individuales
          const totals = totalsBatch.get(s.id) || { totalPaid: 0, totalCollected: 0 };
          const verifiedTotalPaid = totals.totalPaid;
          const verifiedTotalCollected = totals.totalCollected;
          // Recalcular remainingBalance con los valores verificados
          const verifiedRemainingBalance = s.balance - verifiedTotalCollected + verifiedTotalPaid;
          
          // Si los valores verificados son diferentes a los del statement, preparar actualización
          if (Math.abs(verifiedTotalPaid - s.totalPaid) > 0.01 || 
              Math.abs(verifiedTotalCollected - s.totalCollected) > 0.01 ||
              Math.abs(verifiedRemainingBalance - s.remainingBalance) > 0.01) {
            statementsToUpdate.push({
              id: s.id,
              totalPaid: verifiedTotalPaid,
              totalCollected: verifiedTotalCollected,
              remainingBalance: verifiedRemainingBalance,
            });
          }
          
          // ✅ SIEMPRE actualizar el objeto s con los valores verificados para que se usen en los totales
          // Esto asegura que los totales acumulados reflejen los movimientos actuales
          s.totalPaid = verifiedTotalPaid;
          s.totalCollected = verifiedTotalCollected;
          s.remainingBalance = verifiedRemainingBalance;

          const base = {
            date: s.date.toISOString().split("T")[0],
            totalSales: s.totalSales,
            totalPayouts: s.totalPayouts,
            listeroCommission: s.listeroCommission,
            vendedorCommission: s.vendedorCommission,
            balance: s.balance,
            totalPaid: verifiedTotalPaid, // ✅ Usar valores verificados desde movimientos
            totalCollected: verifiedTotalCollected, // ✅ Usar valores verificados desde movimientos
            remainingBalance: verifiedRemainingBalance, // ✅ Usar valores verificados
            isSettled: s.isSettled,
            canEdit: s.canEdit,
            ticketCount: s.ticketCount,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
          };

          // ✅ OPTIMIZACIÓN: Obtener movimientos del batch en lugar de query individual
          const movements = movementsBatch.get(s.id) || [];

          // ✅ OPTIMIZACIÓN: Obtener desglose por sorteo del batch en lugar de query individual
          const dateKeyForSorteo = s.date.toISOString().split("T")[0];
          const bySorteo = sorteoBreakdownBatch.get(dateKeyForSorteo) || [];

          if (dimension === "ventana") {
            return {
              ...base,
              ventanaId: s.ventanaId,
              ventanaName: s.ventanaId ? ventanaInfoMap.get(s.ventanaId)?.name || null : null,
              ventanaCode: s.ventanaId ? ventanaInfoMap.get(s.ventanaId)?.code || null : null,
              bySorteo,
              movements,
            };
          } else {
            return {
              ...base,
              vendedorId: s.vendedorId,
              vendedorName: s.vendedorId ? vendedorInfoMap.get(s.vendedorId)?.name || null : null,
              vendedorCode: s.vendedorId ? vendedorInfoMap.get(s.vendedorId)?.code || null : null,
              bySorteo,
              movements,
            };
          }
        })
      );

      // ✅ OPTIMIZACIÓN: Actualizar statements en batch (paralelo) en lugar de secuencial
      if (statementsToUpdate.length > 0) {
        await Promise.all(
          statementsToUpdate.map(({ id, totalPaid, totalCollected, remainingBalance }) =>
            AccountStatementRepository.update(id, {
              totalPaid,
              totalCollected,
              remainingBalance,
            })
          )
        );
      }

      // ✅ FIX: Usar statements (que tienen valores verificados) en lugar de filteredStatements
      // para los totales acumulados, asegurando que reflejen los movimientos actuales
      const totals = {
        totalSales: statements.reduce((sum, s) => sum + s.totalSales, 0),
        totalPayouts: statements.reduce((sum, s) => sum + s.totalPayouts, 0),
        totalListeroCommission: statements.reduce((sum, s) => sum + s.listeroCommission, 0),
        totalVendedorCommission: statements.reduce((sum, s) => sum + s.vendedorCommission, 0),
        totalBalance: statements.reduce((sum, s) => sum + s.balance, 0),
        totalPaid: statements.reduce((sum, s) => sum + s.totalPaid, 0), // ✅ Usar valores verificados
        totalCollected: statements.reduce((sum, s) => sum + s.totalCollected, 0), // ✅ Usar valores verificados
        totalRemainingBalance: statements.reduce((sum, s) => sum + s.remainingBalance, 0), // ✅ Usar valores verificados
        settledDays: statements.filter((s) => s.isSettled).length,
        pendingDays: statements.filter((s) => !s.isSettled).length,
      };

      const meta = {
        month: effectiveMonth, // ✅ Usar effectiveMonth para compatibilidad
        ...(date ? { date, fromDate, toDate } : {}), // ✅ Incluir filtros de período si se usaron
        startDate: startDate.toISOString().split("T")[0],
        endDate: endDate.toISOString().split("T")[0],
        dimension,
        totalDays: daysInMonth,
      };

      return {
        statements,
        totals,
        meta,
      };
    }

    // Calcular estados de cuenta solo para días que tienen tickets (cuando hay ventanaId o vendedorId específico)
    // ✅ CRÍTICO: Convertir startDate y endDate a fechas de día en CR para construir filtros correctos
    // startDate y endDate vienen en UTC pero representan días en CR
    // toAt puede ser casi las 06:00 del día siguiente en UTC, necesitamos convertir a CR para obtener el día correcto
    const crOffsetMs = -6 * 60 * 60 * 1000; // UTC-6
    const startDateInCR = new Date(startDate.getTime() + crOffsetMs);
    const endDateInCR = new Date(endDate.getTime() + crOffsetMs);
    const startDateStr = `${startDateInCR.getUTCFullYear()}-${String(startDateInCR.getUTCMonth() + 1).padStart(2, '0')}-${String(startDateInCR.getUTCDate()).padStart(2, '0')}`;
    const endDateStr = `${endDateInCR.getUTCFullYear()}-${String(endDateInCR.getUTCMonth() + 1).padStart(2, '0')}-${String(endDateInCR.getUTCDate()).padStart(2, '0')}`;
    
    // Construir filtros para cada día en el rango (solo días que están dentro del rango)
    const dateFilters: any[] = [];
    const startDay = new Date(startDateStr + "T00:00:00.000Z");
    const endDay = new Date(endDateStr + "T00:00:00.000Z");
    const currentDay = new Date(startDay);
    
    while (currentDay <= endDay) {
      dateFilters.push(buildTicketDateFilter(new Date(currentDay)));
      currentDay.setUTCDate(currentDay.getUTCDate() + 1);
    }

    const ticketsWithDates = await prisma.ticket.findMany({
      where: {
        OR: dateFilters, // ✅ Usar filtros de fecha correctos para cada día
        deletedAt: null,
        status: { not: "CANCELLED" },
        ...(ventanaId ? { ventanaId } : {}),
        ...(vendedorId ? { vendedorId } : {}),
      },
      select: {
        businessDate: true,
        createdAt: true,
      },
    });

    // Extraer días únicos usando la fecha correcta (businessDate o createdAt convertido a día en CR)
    // ✅ CRÍTICO: Agrupar por la fecha del día en CR, no por UTC
    const uniqueDays = new Set<string>();
    for (const ticket of ticketsWithDates) {
      // Usar businessDate si existe, sino usar createdAt pero convertir a día en CR
      let ticketDate: Date;
      if (ticket.businessDate) {
        ticketDate = new Date(ticket.businessDate);
        ticketDate.setUTCHours(0, 0, 0, 0);
      } else {
        // ✅ Convertir createdAt (UTC) a día en CR
        // createdAt está en UTC, necesitamos convertir a día en CR
        // Ejemplo: createdAt = 2025-01-20T10:00:00Z (UTC) = 2025-01-20T04:00:00 (CR)
        // El día en CR es 2025-01-20
        const crOffsetMs = -6 * 60 * 60 * 1000; // UTC-6
        const crDate = new Date(ticket.createdAt.getTime() + crOffsetMs);
        ticketDate = new Date(Date.UTC(crDate.getUTCFullYear(), crDate.getUTCMonth(), crDate.getUTCDate()));
      }
      
      // ✅ Si date está presente, ya filtramos por el rango arriba, solo agregar días únicos
      // Si no está presente, excluir días futuros del mes actual
      if (!date) {
        const todayForCheck = new Date();
        todayForCheck.setUTCHours(0, 0, 0, 0);
        const isCurrentMonth = ticketDate.getUTCFullYear() === todayForCheck.getUTCFullYear() &&
                               ticketDate.getUTCMonth() === todayForCheck.getUTCMonth();
        
        if (isCurrentMonth && ticketDate > todayForCheck) {
          // Saltar días futuros del mes actual
          continue;
        }
      }
      
      // ✅ CRÍTICO: Solo agregar días que están dentro del rango cuando date está presente
      const ticketDateStr = ticketDate.toISOString().split("T")[0];
      if (date) {
        // Verificar que la fecha del ticket esté dentro del rango
        if (ticketDateStr >= startDateStr && ticketDateStr <= endDateStr) {
          uniqueDays.add(ticketDateStr);
        }
      } else {
        uniqueDays.add(ticketDateStr);
      }
    }

    // ✅ CRÍTICO: Si date está presente, NO usar findByMonth (no procesar mes completo)
    // Filtrar directamente por rango de fechas en la query de base de datos
    let statementsWithRelations: Array<{
      date: Date;
      ventana?: { id: string; name: string; code: string } | null;
      vendedor?: { id: string; name: string; code: string | null } | null;
    }>;

    if (date) {
      // ✅ Filtrar DIRECTAMENTE por rango de fechas cuando date está presente
      // NO procesar el mes completo
      // startDateStr y endDateStr ya están definidos arriba
      // ✅ CRÍTICO: Asegurar que cuando dimension=vendedor, ventanaId=null, y viceversa
      const whereClause: any = {
        date: {
          gte: new Date(startDateStr + "T00:00:00.000Z"),
          lte: new Date(endDateStr + "T23:59:59.999Z"),
        },
      };
      
      if (dimension === "ventana" && ventanaId) {
        whereClause.ventanaId = ventanaId;
        whereClause.vendedorId = null; // ✅ Asegurar que vendedorId es null para statements de ventana
      } else if (dimension === "vendedor" && vendedorId) {
        whereClause.vendedorId = vendedorId;
        whereClause.ventanaId = null; // ✅ Asegurar que ventanaId es null para statements de vendedor
      }
      
      statementsWithRelations = await prisma.accountStatement.findMany({
        where: whereClause,
        orderBy: {
          date: sort as "asc" | "desc",
        },
        select: {
          date: true,
          ventana: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
          vendedor: {
            select: {
              id: true,
              name: true,
              code: true,
            },
          },
        },
      });
    } else {
      // Solo usar findByMonth si date NO está presente (compatibilidad hacia atrás)
      statementsWithRelations = (await AccountStatementRepository.findByMonth(
        effectiveMonth,
        { ventanaId, vendedorId },
        {
          sort: sort as "asc" | "desc",
          include: {
            ventana: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
            vendedor: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        }
      )) as typeof statementsWithRelations;
    }

    // ✅ Si date está presente, el filtro de fecha ya se aplicó en la query de arriba
    // Solo aplicar filtro adicional si date NO está presente (compatibilidad hacia atrás)
    const filteredStatements = statementsWithRelations.filter((s) => {
      // ✅ Si date está presente, el filtro de fecha ya se aplicó en la query de arriba
      // Solo aplicar lógica adicional si date NO está presente (compatibilidad hacia atrás)
      if (!date) {
        const statementDate = new Date(s.date);
        statementDate.setUTCHours(0, 0, 0, 0);
        const todayForCheck = new Date();
        todayForCheck.setUTCHours(0, 0, 0, 0);
        const isCurrentMonth = statementDate.getUTCFullYear() === todayForCheck.getUTCFullYear() &&
          statementDate.getUTCMonth() === todayForCheck.getUTCMonth();

        if (isCurrentMonth && statementDate > todayForCheck) {
          return false;
        }
      }
      
      return true;
    });

    for (const statement of filteredStatements) {
      const statementDate = new Date(statement.date);
      statementDate.setUTCHours(0, 0, 0, 0);
      uniqueDays.add(statementDate.toISOString().split("T")[0]);
    }
    
    // ✅ Si date está presente, los días ya están filtrados correctamente arriba
    // No necesitamos filtrar uniqueDays nuevamente porque ya filtramos los tickets por rango

    // ✅ OPTIMIZACIÓN CRÍTICA: Calcular statements en paralelo usando Promise.all
    // Esto reduce significativamente el tiempo de respuesta (de ~14s a ~2-3s)
    const statementsPromises = Array.from(uniqueDays).map(async (dateStr) => {
      const date = new Date(dateStr + "T00:00:00.000Z");
      return await calculateDayStatement(date, effectiveMonth, dimension, ventanaId, vendedorId, bancaId);
    });
    
    const statements = await Promise.all(statementsPromises);

    // Ordenar según sort
    if (sort === "asc") {
      statements.sort((a, b) => a.date.getTime() - b.date.getTime());
    } else {
      statements.sort((a, b) => b.date.getTime() - a.date.getTime());
    }

    // Crear un mapa de statements por fecha para acceso rápido
    const statementsMap = new Map(
      statementsWithRelations.map((s) => [s.date.toISOString().split("T")[0], s])
    );

    // Obtener información de ventana/vendedor cuando está especificado
    // Esto es necesario porque si no hay statements existentes, el mapa estará vacío
    // y no tendremos la información de nombres y códigos
    let ventanaInfo: { id: string; name: string; code: string } | null = null;
    let vendedorInfo: { id: string; name: string; code: string | null } | null = null;

    if (ventanaId) {
      // Verificar si ya tenemos la información en el mapa
      const firstStatement = statementsWithRelations.find((s) => s.ventana);
      if (firstStatement?.ventana) {
        ventanaInfo = firstStatement.ventana;
      } else {
        // Si no está en el mapa, obtenerla directamente
        const ventana = await prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: { id: true, name: true, code: true },
        });
        if (ventana) {
          ventanaInfo = ventana;
        }
      }
    }

    if (vendedorId) {
      // Verificar si ya tenemos la información en el mapa
      const firstStatement = statementsWithRelations.find((s) => s.vendedor);
      if (firstStatement?.vendedor) {
        vendedorInfo = {
          id: firstStatement.vendedor.id,
          name: firstStatement.vendedor.name,
          code: firstStatement.vendedor.code,
        };
      } else {
        // Si no está en el mapa, obtenerla directamente
        const vendedor = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: { id: true, name: true, code: true },
        });
        if (vendedor) {
          vendedorInfo = {
            id: vendedor.id,
            name: vendedor.name,
            code: vendedor.code || "",
          };
        }
      }
    }

    // ✅ OPTIMIZACIÓN: Obtener todos los IDs de statements para hacer batch queries
    const statementIdsForBatch2 = statements.map(s => s.id);
    
    // ✅ OPTIMIZACIÓN: Obtener fechas para batch query de getSorteoBreakdown
    const statementDatesForBatch2 = statements.map(s => {
      const d = new Date(s.date);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    });
    
    // ✅ OPTIMIZACIÓN: Obtener totales, movimientos y breakdowns en batch (una sola query en lugar de N queries)
    const [totalsBatch, movementsBatch, sorteoBreakdownBatch] = await Promise.all([
      AccountPaymentRepository.getTotalsBatch(statementIdsForBatch2),
      AccountPaymentRepository.findMovementsBatch(statementIdsForBatch2),
      getSorteoBreakdownBatch(statementDatesForBatch2, dimension, ventanaId, vendedorId, bancaId),
    ]);

    // ✅ OPTIMIZACIÓN: Preparar actualizaciones batch para statements que necesitan actualización
    const statementsToUpdate: Array<{ id: string; totalPaid: number; totalCollected: number; remainingBalance: number }> = [];

    // Formatear respuesta - retornar directamente el array en lugar de data.data
    // Incluir campos según la dimensión (omitir campos null innecesarios)
    // Obtener bySorteo y movements para cada statement en paralelo
    const formattedStatements = await Promise.all(
      statements.map(async (s) => {
        const dateISOCR = toCostaRicaISODate(s.date);
        const dateKey = dateISOCR.split("T")[0];
        const statementWithRelations = statementsMap.get(dateKey);

        // ✅ OPTIMIZACIÓN: Usar valores del batch en lugar de queries individuales
        const totals = totalsBatch.get(s.id) || { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 };
        const verifiedTotalPaid = totals.totalPaid;
        const verifiedTotalCollected = totals.totalCollected;
        const verifiedTotalPaymentsCollections = totals.totalPaymentsCollections; // ✅ NUEVO
        // Recalcular remainingBalance con los valores verificados
        const verifiedRemainingBalance = s.balance - verifiedTotalCollected + verifiedTotalPaid;
        
        // Si los valores verificados son diferentes a los del statement, preparar actualización
        if (Math.abs(verifiedTotalPaid - s.totalPaid) > 0.01 || 
            Math.abs(verifiedTotalCollected - s.totalCollected) > 0.01 ||
            Math.abs(verifiedRemainingBalance - s.remainingBalance) > 0.01) {
          statementsToUpdate.push({
            id: s.id,
            totalPaid: verifiedTotalPaid,
            totalCollected: verifiedTotalCollected,
            remainingBalance: verifiedRemainingBalance,
          });
        }
        
        // ✅ SIEMPRE actualizar el objeto s con los valores verificados para que se usen en los totales
        // Esto asegura que los totales acumulados reflejen los movimientos actuales
        s.totalPaid = verifiedTotalPaid;
        s.totalCollected = verifiedTotalCollected;
        s.remainingBalance = verifiedRemainingBalance;

        const base = {
          date: dateISOCR,
          totalSales: s.totalSales,
          totalPayouts: s.totalPayouts,
          listeroCommission: s.listeroCommission,
          vendedorCommission: s.vendedorCommission,
          balance: s.balance,
          totalPaid: verifiedTotalPaid, // ✅ Usar valores verificados desde movimientos
          totalCollected: verifiedTotalCollected, // ✅ Usar valores verificados desde movimientos
          totalPaymentsCollections: verifiedTotalPaymentsCollections, // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
          remainingBalance: verifiedRemainingBalance, // ✅ Usar valores verificados
          isSettled: s.isSettled,
          canEdit: s.canEdit,
          ticketCount: s.ticketCount,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        };

        // ✅ OPTIMIZACIÓN: Obtener movimientos del batch en lugar de query individual
        const movements = movementsBatch.get(s.id) || [];

        // ✅ OPTIMIZACIÓN: Obtener desglose por sorteo del batch en lugar de query individual
        const dateKeyForSorteo2 = dateISOCR.split("T")[0];
        const bySorteo = sorteoBreakdownBatch.get(dateKeyForSorteo2) || [];

        if (dimension === "ventana") {
          const info =
            (s.ventanaId && ventanaInfoMap.get(s.ventanaId)) ||
            ventanaInfo ||
            statementWithRelations?.ventana ||
            null;

          return {
            ...base,
            ventanaId: s.ventanaId ?? ventanaId ?? null,
            ventanaName: info?.name ?? null,
            ventanaCode: info?.code ?? null,
            bySorteo,
            movements,
          };
        } else {
          const info =
            (s.vendedorId && vendedorInfoMap.get(s.vendedorId)) ||
            vendedorInfo ||
            statementWithRelations?.vendedor ||
            null;

          return {
            ...base,
            vendedorId: s.vendedorId ?? vendedorId ?? null,
            vendedorName: info?.name ?? null,
            vendedorCode: info?.code ?? null,
            bySorteo,
            movements,
          };
        }
      })
    );

    // ✅ OPTIMIZACIÓN: Actualizar statements en batch (paralelo) en lugar de secuencial
    if (statementsToUpdate.length > 0) {
      await Promise.all(
        statementsToUpdate.map(({ id, totalPaid, totalCollected, remainingBalance }) =>
          AccountStatementRepository.update(id, {
            totalPaid,
            totalCollected,
            remainingBalance,
          })
        )
      );
    }

    const totals = {
      totalSales: formattedStatements.reduce((sum, s) => sum + s.totalSales, 0),
      totalPayouts: formattedStatements.reduce((sum, s) => sum + s.totalPayouts, 0),
      totalListeroCommission: formattedStatements.reduce((sum, s) => sum + s.listeroCommission, 0),
      totalVendedorCommission: formattedStatements.reduce((sum, s) => sum + s.vendedorCommission, 0),
      totalBalance: formattedStatements.reduce((sum, s) => sum + s.balance, 0),
      totalPaid: formattedStatements.reduce((sum, s) => sum + s.totalPaid, 0),
      totalCollected: formattedStatements.reduce((sum, s) => sum + s.totalCollected, 0),
      totalRemainingBalance: formattedStatements.reduce((sum, s) => sum + s.remainingBalance, 0),
      settledDays: formattedStatements.filter((s) => s.isSettled).length,
      pendingDays: formattedStatements.filter((s) => !s.isSettled).length,
    };

    const meta = {
      month,
      startDate: startDate.toISOString().split("T")[0],
      endDate: endDate.toISOString().split("T")[0],
      dimension,
      totalDays: daysInMonth,
      daysWithStatements: formattedStatements.length,
    };

    return {
      statements: formattedStatements,
      totals,
      meta,
    };
  },

  /**
   * Registra un pago o cobro
   */
  async createPayment(data: {
    date: string; // YYYY-MM-DD
    ventanaId?: string;
    vendedorId?: string;
    amount: number;
    type: "payment" | "collection";
    method: "cash" | "transfer" | "check" | "other";
    notes?: string;
    isFinal?: boolean;
    idempotencyKey?: string;
    paidById: string;
    paidByName: string;
  }) {
    const paymentDate = new Date(data.date + "T00:00:00.000Z");
    const month = data.date.substring(0, 7); // YYYY-MM

    // Validar idempotencia
    if (data.idempotencyKey) {
      const existing = await AccountPaymentRepository.findByIdempotencyKey(data.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    // Recalcular el estado de cuenta antes de validar el pago
    const dimension: "ventana" | "vendedor" = data.ventanaId ? "ventana" : "vendedor";
    const statement = await calculateDayStatement(
      paymentDate,
      month,
      dimension,
      data.ventanaId ?? undefined,
      data.vendedorId ?? undefined
    );

    // Validar que se puede editar
    if (!statement.canEdit) {
      throw new AppError("El estado de cuenta ya está saldado", 400, "STATEMENT_SETTLED");
    }

    // FIX: Usar el saldo recalculado del statement para validar pagos/cobros
    const baseBalance = statement.balance || 0;
    const currentTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const currentTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

    // Validar que el statement no esté saldado
    if (statement.isSettled) {
      throw new AppError("El estado de cuenta ya está saldado", 400, "STATEMENT_SETTLED");
    }

    // Validar monto según el tipo de movimiento
    // Los movimientos solo afectan remainingBalance, no balance
    // Se permite registrar cualquier movimiento mientras el statement no esté saldado
    // El usuario puede seleccionar libremente el tipo (payment o collection)
    if (data.type === "payment") {
      // Payment: suma al remainingBalance (reduce CxP o aumenta CxC)
      // Efecto: newRemainingBalance = currentRemainingBalance + amount
      // Validar que el monto sea positivo
      if (data.amount <= 0) {
        throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
      }
    } else if (data.type === "collection") {
      // Collection: resta del remainingBalance (reduce CxC o aumenta CxP)
      // Efecto: newRemainingBalance = currentRemainingBalance - amount
      // Validar que el monto sea positivo
      if (data.amount <= 0) {
        throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
      }
    }

    // Crear pago
    const payment = await AccountPaymentRepository.create({
      accountStatementId: statement.id,
      date: paymentDate,
      month,
      ventanaId: data.ventanaId,
      vendedorId: data.vendedorId,
      amount: data.amount,
      type: data.type,
      method: data.method,
      notes: data.notes,
      isFinal: data.isFinal || false,
      idempotencyKey: data.idempotencyKey,
      paidById: data.paidById,
      paidByName: data.paidByName,
    });

    // Recalcular total pagado y cobrado después de crear el pago (solo pagos activos)
    const newTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const newTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

    // FIX: Reutilizar baseBalance ya calculado arriba (línea 1039)
    // Fórmula según tipo de movimiento:
    // - payment: suma al remainingBalance (reduce CxP o aumenta CxC)
    // - collection: resta del remainingBalance (reduce CxC o aumenta CxP)
    // Fórmula: remainingBalance = balance - totalCollected + totalPaid
    // Esto es equivalente a:
    // - payment: remainingBalance += amount (porque totalPaid aumenta)
    // - collection: remainingBalance -= amount (porque totalCollected aumenta)
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;
    
    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    const isSettled = calculateIsSettled(statement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ FIX: Actualizar también totalCollected cuando se registra un movimiento
    await AccountStatementRepository.update(statement.id, {
      totalPaid: newTotalPaid,
      totalCollected: newTotalCollected, // ✅ NUEVO: Actualizar totalCollected
      remainingBalance: newRemainingBalance,
      isSettled,
      canEdit: !isSettled,
    });

    return payment;
  },

  /**
   * Obtiene el historial de pagos/cobros de un día
   */
  async getPaymentHistory(date: string, filters: { ventanaId?: string; vendedorId?: string }) {
    const paymentDate = new Date(date + "T00:00:00.000Z");
    // Incluir TODOS los pagos (activos y revertidos) según el documento
    const payments = await AccountPaymentRepository.findByDate(paymentDate, {
      ...filters,
      includeReversed: true, // Incluir todos los pagos
    });

    return payments.map((p) => ({
      id: p.id,
      date: p.date.toISOString().split("T")[0],
      amount: p.amount,
      type: p.type,
      method: p.method,
      notes: p.notes,
      isFinal: p.isFinal,
      isReversed: p.isReversed,
      reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
      reversedBy: p.reversedBy,
      reversedByUser: p.reversedByUser
        ? {
            id: p.reversedByUser.id,
            name: p.reversedByUser.name,
          }
        : null,
      paidById: p.paidById,
      paidByName: p.paidByName,
      createdAt: p.createdAt.toISOString(),
    }));
  },

  /**
   * Revierte un pago/cobro
   * CRÍTICO: No permite revertir si el día quedaría saldado (saldo = 0)
   */
  async reversePayment(paymentId: string, userId: string, reason?: string) {
    const payment = await AccountPaymentRepository.findById(paymentId);

    if (!payment) {
      throw new AppError("Pago no encontrado", 404, "PAYMENT_NOT_FOUND");
    }

    if (payment.isReversed) {
      throw new AppError("El pago ya está revertido", 400, "PAYMENT_ALREADY_REVERSED");
    }

    // Validar motivo si se proporciona
    if (reason && reason.length < 5) {
      throw new AppError("El motivo de reversión debe tener al menos 5 caracteres", 400, "INVALID_REASON");
    }

    // Obtener el estado de cuenta del día
    const statement = await AccountStatementRepository.findOrCreate({
      date: payment.date,
      month: payment.month,
      ventanaId: payment.ventanaId ?? undefined,
      vendedorId: payment.vendedorId ?? undefined,
    });

    // Calcular saldo base del día (sin pagos/cobros)
    // Para VENTANA: solo resta comisión vendedor (listero es informativo)
    // Obtener dimension del statement (si tiene ventanaId es ventana, si tiene vendedorId es vendedor)
    const isVentana = statement.ventanaId !== null && statement.vendedorId === null;
    const baseBalance = statement.totalSales - statement.totalPayouts - (statement.vendedorCommission || 0);

    // FIX: Eliminar cálculo redundante - usar directamente el repositorio para obtener totales actuales
    const currentTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const currentTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

    // Calcular saldo actual (con todos los pagos activos)
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

    // Calcular saldo después de revertir este pago
    let balanceAfterReversal: number;
    if (payment.type === "payment") {
      // Si es un pago, al revertirlo se suma al saldo (se quita el pago)
      balanceAfterReversal = currentRemainingBalance + payment.amount;
    } else {
      // Si es un cobro, al revertirlo se resta del saldo (se quita el cobro)
      balanceAfterReversal = currentRemainingBalance - payment.amount;
    }

    // CRÍTICO: Validar que el día NO quede saldado
    // FIX: Validar usando la misma lógica que isSettled (incluye hasPayments)
    // Después de revertir, si no quedan pagos activos, no debería quedar saldado
    const remainingPaymentsAfterReversal = 
      (payment.type === "payment" ? currentTotalPaid - payment.amount : currentTotalPaid) +
      (payment.type === "collection" ? currentTotalCollected - payment.amount : currentTotalCollected);
    const hasPaymentsAfterReversal = remainingPaymentsAfterReversal > 0;
    const absBalance = Math.abs(balanceAfterReversal);
    
    // No permitir revertir si quedaría saldado (balance ≈ 0 Y hay pagos restantes)
    if (absBalance <= 0.01 && hasPaymentsAfterReversal) {
      throw new AppError(
        "No se puede revertir este pago porque el día quedaría saldado. El saldo resultante sería cero o muy cercano a cero.",
        400,
        "CANNOT_REVERSE_SETTLED_DAY"
      );
    }

    // Revertir pago
    const reversed = await AccountPaymentRepository.reverse(paymentId, userId);

    // Recalcular total pagado y cobrado después de la reversión (solo pagos activos)
    const newTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const newTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;
    
    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    const isSettled = calculateIsSettled(statement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ FIX: Actualizar también totalCollected cuando se revierte un movimiento
    await AccountStatementRepository.update(statement.id, {
      totalPaid: newTotalPaid,
      totalCollected: newTotalCollected, // ✅ NUEVO: Actualizar totalCollected
      remainingBalance: newRemainingBalance,
      isSettled,
      canEdit: !isSettled,
    });

    return reversed;
  },

  /**
   * Elimina un estado de cuenta
   * Solo permite eliminar statements vacíos (sin tickets ni pagos activos)
   */
  async deleteStatement(statementId: string) {
    const statement = await AccountStatementRepository.findById(statementId);
    
    if (!statement) {
      throw new AppError("Estado de cuenta no encontrado", 404, "STATEMENT_NOT_FOUND");
    }

    // Validar que no tenga tickets
    if (statement.ticketCount > 0) {
      throw new AppError(`No se puede eliminar un estado de cuenta con tickets registrados (ticketCount: ${statement.ticketCount})`, 400, "STATEMENT_HAS_TICKETS");
    }

    // Validar que no tenga pagos activos (solo pagos no revertidos)
    const allPayments = statement.payments || [];
    const activePayments = allPayments.filter(p => !p.isReversed);
    
    if (activePayments.length > 0) {
      throw new AppError(`No se puede eliminar un estado de cuenta con pagos/cobros registrados (${activePayments.length} pagos activos)`, 400, "STATEMENT_HAS_PAYMENTS");
    }

    // Eliminar el statement (los pagos revertidos se eliminarán automáticamente por cascade)
    await AccountStatementRepository.delete(statementId);

    return { id: statementId, deleted: true };
  },
};

