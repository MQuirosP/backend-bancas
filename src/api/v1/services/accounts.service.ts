// src/api/v1/services/accounts.service.ts
import { Prisma, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { AccountStatementRepository } from "../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { resolveCommission } from "../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../services/commission/commission.resolver";

/**
 * Filtros para queries de accounts
 */
interface AccountsFilters {
  month: string; // YYYY-MM
  scope: "mine" | "ventana" | "all";
  dimension: "ventana" | "vendedor";
  ventanaId?: string;
  vendedorId?: string;
  sort?: "asc" | "desc";
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
        commissionAmount = Math.round((jugada.amount * resolution.percent) / 100);
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
function buildTicketDateFilter(date: Date): any {
  // Normalizar fecha a inicio del día UTC
  const dateStart = new Date(date.getTime());
  dateStart.setUTCHours(0, 0, 0, 0);
  const dateEnd = new Date(dateStart.getTime() + 24 * 60 * 60 * 1000);

  return {
    OR: [
      // Prioridad: businessDate (fecha de negocio correcta)
      { businessDate: dateStart },
      // Fallback: createdAt para tickets antiguos sin businessDate
      {
        businessDate: null,
        createdAt: {
          gte: dateStart,
          lt: dateEnd,
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
 * Calcula y actualiza el estado de cuenta para un día específico
 */
async function calculateDayStatement(
  date: Date,
  month: string,
  dimension: "ventana" | "vendedor",
  ventanaId?: string,
  vendedorId?: string
) {
  // Construir WHERE clause
  // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
  const dateFilter = buildTicketDateFilter(date);
  const where: any = {
    ...dateFilter,
    deletedAt: null,
    status: { not: "CANCELLED" },
  };

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

  // Calcular saldo
  const balance = totalSales - totalPayouts;

  // Si no hay tickets, retornar valores por defecto sin crear statement
  // FIX: No crear fechas nuevas cada vez para mantener consistencia
  if (ticketCount === 0) {
    // Intentar obtener statement existente si existe
    const existingStatement = await AccountStatementRepository.findByDate(date, {
      ventanaId,
      vendedorId,
    });

    if (existingStatement) {
      // Si existe, retornar el existente
      return {
        ...existingStatement,
        totalSales: 0,
        totalPayouts: 0,
        listeroCommission: 0,
        vendedorCommission: 0,
        balance: 0,
        totalPaid: existingStatement.totalPaid || 0,
        totalCollected: await AccountPaymentRepository.getTotalCollected(existingStatement.id),
        remainingBalance: existingStatement.remainingBalance || 0,
        isSettled: false,
        canEdit: true,
        ticketCount: 0,
      };
    }

    // Si no existe, crear statement para tener un id
    const newStatement = await AccountStatementRepository.findOrCreate({
      date,
      month,
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
      remainingBalance: 0,
      isSettled: false, // No está saldado si no hay tickets
      canEdit: true,
      ticketCount: 0,
    };
  }

  // Crear o actualizar estado de cuenta primero
  const statement = await AccountStatementRepository.findOrCreate({
    date,
    month,
    ventanaId,
    vendedorId,
  });

  // Obtener total pagado y cobrado después de crear el statement
  const totalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
  const totalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

  // Calcular saldo restante: remainingBalance = balance - totalCollected + totalPaid
  // Lógica: Payment reduce deuda (suma), Collection reduce crédito (resta)
  const remainingBalance = balance - totalCollected + totalPaid;

  // FIX: Usar helper para cálculo consistente de isSettled
  const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);
  const canEdit = !isSettled;

  await AccountStatementRepository.update(statement.id, {
    totalSales,
    totalPayouts,
    listeroCommission: totalListeroCommission,
    vendedorCommission: totalVendedorCommission,
    balance,
    totalPaid,
    remainingBalance,
    isSettled,
    canEdit,
    ticketCount,
  });

  return {
    ...statement,
    totalSales,
    totalPayouts,
    listeroCommission: totalListeroCommission,
    vendedorCommission: totalVendedorCommission,
    balance,
    totalPaid,
    totalCollected, // Agregar totalCollected al objeto retornado
    remainingBalance,
    isSettled,
    canEdit,
    ticketCount,
  };
}

/**
 * Accounts Service
 * Proporciona endpoints para consultar y gestionar estados de cuenta
 */
export const AccountsService = {
  /**
   * Obtiene el estado de cuenta día a día del mes
   */
  async getStatement(filters: AccountsFilters) {
    const { month, dimension, ventanaId, vendedorId, sort = "desc" } = filters;
    const { startDate, endDate, daysInMonth } = getMonthDateRange(month);

    // Si scope=all y no hay ventanaId/vendedorId, obtener estados existentes
    // Si no hay estados existentes, calcular basándose en tickets del mes
    if (!ventanaId && !vendedorId) {
      // Obtener todos los estados de cuenta existentes del mes
      const statementsWithRelations = (await AccountStatementRepository.findByMonth(
        month,
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
      )) as Array<{
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
        remainingBalance: number;
        isSettled: boolean;
        canEdit: boolean;
        ticketCount: number;
        createdAt: Date;
        updatedAt: Date;
        ventana?: { id: string; name: string; code: string } | null;
        vendedor?: { id: string; name: string; code: string } | null;
      }>;

      // Filtrar por dimensión
      const existingStatementsForDimension = statementsWithRelations.filter((s) => {
        // Filtrar por dimensión
        const matchesDimension = dimension === "ventana" 
          ? (s.ventanaId !== null && s.vendedorId === null)
          : (s.vendedorId !== null && s.ventanaId === null);
        
        if (!matchesDimension) return false;
        
        // FIX: Excluir días futuros cuando el mes consultado es el mes actual
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
        
        // Para meses pasados o futuros, incluir todos los días
        return true;
      });

      // Recalcular cualquier statement existente para garantizar datos frescos
      let filteredStatements: DayStatement[] = await Promise.all(
        existingStatementsForDimension.map(async (s) => {
          const statementDate = new Date(s.date);
          statementDate.setUTCHours(0, 0, 0, 0);

          const recalculated = await calculateDayStatement(
            statementDate,
            month,
            dimension,
            s.ventanaId ?? undefined,
            s.vendedorId ?? undefined
          );

          return recalculated;
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
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      for (const ticket of ticketsInMonth) {
        const ticketDate = ticket.businessDate
          ? new Date(ticket.businessDate)
          : new Date(ticket.createdAt);
        ticketDate.setUTCHours(0, 0, 0, 0);

        const isCurrentMonth = ticketDate.getUTCFullYear() === today.getUTCFullYear() &&
          ticketDate.getUTCMonth() === today.getUTCMonth();
        if (isCurrentMonth && ticketDate > today) {
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
            month,
            dimension,
            info.ventanaId,
            info.vendedorId
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
            month,
            dimension,
            statementInfo.ventanaId || undefined,
            statementInfo.vendedorId || undefined
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
      const ventanaInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();
      const vendedorInfoMap = new Map<string, { id: string; name: string | null; code: string | null }>();

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

      const ventanaIdsToFetch = Array.from(ventanaIdsNeeded).filter((id) => !ventanaInfoMap.has(id));
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

      const vendedorIdsToFetch = Array.from(vendedorIdsNeeded).filter((id) => !vendedorInfoMap.has(id));
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

      const statements = filteredStatements.map((s) => {
        const base = {
          date: s.date.toISOString().split("T")[0],
          totalSales: s.totalSales,
          totalPayouts: s.totalPayouts,
          listeroCommission: s.listeroCommission,
          vendedorCommission: s.vendedorCommission,
          balance: s.balance,
          totalPaid: s.totalPaid,
          totalCollected: s.totalCollected,
          remainingBalance: s.remainingBalance,
          isSettled: s.isSettled,
          canEdit: s.canEdit,
          ticketCount: s.ticketCount,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        };

        if (dimension === "ventana") {
          return {
            ...base,
            ventanaId: s.ventanaId,
            ventanaName: s.ventanaId ? ventanaInfoMap.get(s.ventanaId)?.name || null : null,
            ventanaCode: s.ventanaId ? ventanaInfoMap.get(s.ventanaId)?.code || null : null,
          };
        } else {
          return {
            ...base,
            vendedorId: s.vendedorId,
            vendedorName: s.vendedorId ? vendedorInfoMap.get(s.vendedorId)?.name || null : null,
            vendedorCode: s.vendedorId ? vendedorInfoMap.get(s.vendedorId)?.code || null : null,
          };
        }
      });

      const totals = {
        totalSales: filteredStatements.reduce((sum, s) => sum + s.totalSales, 0),
        totalPayouts: filteredStatements.reduce((sum, s) => sum + s.totalPayouts, 0),
        totalListeroCommission: filteredStatements.reduce((sum, s) => sum + s.listeroCommission, 0),
        totalVendedorCommission: filteredStatements.reduce((sum, s) => sum + s.vendedorCommission, 0),
        totalBalance: filteredStatements.reduce((sum, s) => sum + s.balance, 0),
        totalPaid: filteredStatements.reduce((sum, s) => sum + s.totalPaid, 0),
        totalCollected: filteredStatements.reduce((sum, s) => sum + s.totalCollected, 0),
        totalRemainingBalance: filteredStatements.reduce((sum, s) => sum + s.remainingBalance, 0),
        settledDays: filteredStatements.filter((s) => s.isSettled).length,
        pendingDays: filteredStatements.filter((s) => !s.isSettled).length,
      };

      const meta = {
        month,
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
    // Primero obtener los días que tienen tickets para evitar calcular días vacíos
    // FIX: Usar businessDate si existe, fallback a createdAt
    const ticketsWithDates = await prisma.ticket.findMany({
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
        ...(ventanaId ? { ventanaId } : {}),
        ...(vendedorId ? { vendedorId } : {}),
      },
      select: {
        businessDate: true,
        createdAt: true,
      },
    });

    // Extraer días únicos
    // FIX: Usar businessDate si existe, fallback a createdAt
    // FIX: Excluir días futuros cuando el mes consultado es el mes actual
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    
    const uniqueDays = new Set<string>();
    for (const ticket of ticketsWithDates) {
      const ticketDate = ticket.businessDate 
        ? new Date(ticket.businessDate)
        : new Date(ticket.createdAt);
      ticketDate.setUTCHours(0, 0, 0, 0);
      
      // Excluir días futuros cuando el mes consultado es el mes actual
      const isCurrentMonth = ticketDate.getUTCFullYear() === today.getUTCFullYear() &&
                             ticketDate.getUTCMonth() === today.getUTCMonth();
      
      if (isCurrentMonth && ticketDate > today) {
        // Saltar días futuros del mes actual
        continue;
      }
      
      uniqueDays.add(ticketDate.toISOString().split("T")[0]);
    }

    // Incluir días existentes en account_statements aunque no haya tickets recientes
    const statementsWithRelations = (await AccountStatementRepository.findByMonth(
      month,
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
    )) as Array<{
      date: Date;
      ventana?: { id: string; name: string; code: string } | null;
      vendedor?: { id: string; name: string; code: string } | null;
    }>;

    for (const statement of statementsWithRelations) {
      const statementDate = new Date(statement.date);
      statementDate.setUTCHours(0, 0, 0, 0);

      const isCurrentMonth = statementDate.getUTCFullYear() === today.getUTCFullYear() &&
        statementDate.getUTCMonth() === today.getUTCMonth();

      if (isCurrentMonth && statementDate > today) {
        continue;
      }

      uniqueDays.add(statementDate.toISOString().split("T")[0]);
    }

    // Calcular statements solo para días con tickets
    const statements: Array<{
      id: string;
      date: Date;
      month: string;
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
    }> = [];
    for (const dateStr of uniqueDays) {
      const date = new Date(dateStr + "T00:00:00.000Z");
      const statement = await calculateDayStatement(date, month, dimension, ventanaId, vendedorId);
      statements.push(statement);
    }

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
    let vendedorInfo: { id: string; name: string; code: string } | null = null;

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
        vendedorInfo = firstStatement.vendedor;
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

    // Formatear respuesta - retornar directamente el array en lugar de data.data
    // Incluir campos según la dimensión (omitir campos null innecesarios)
    const formattedStatements = statements.map((s) => {
      const dateStr = s.date.toISOString().split("T")[0];
      const statementWithRelations = statementsMap.get(dateStr);
      
      const base = {
        date: dateStr,
        totalSales: s.totalSales,
        totalPayouts: s.totalPayouts,
        listeroCommission: s.listeroCommission,
        vendedorCommission: s.vendedorCommission,
        balance: s.balance,
        totalPaid: s.totalPaid,
        totalCollected: s.totalCollected,
        remainingBalance: s.remainingBalance,
        isSettled: s.isSettled,
        canEdit: s.canEdit,
        ticketCount: s.ticketCount,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      };

      if (dimension === "ventana") {
        return {
          ...base,
          ventanaId: s.ventanaId,
          ventanaName: statementWithRelations?.ventana?.name || ventanaInfo?.name || null,
          ventanaCode: statementWithRelations?.ventana?.code || ventanaInfo?.code || null,
        };
      } else {
        return {
          ...base,
          vendedorId: s.vendedorId,
          vendedorName: statementWithRelations?.vendedor?.name || vendedorInfo?.name || null,
          vendedorCode: statementWithRelations?.vendedor?.code || vendedorInfo?.code || null,
        };
      }
    });

    // Calcular totales SOLO de los statements retornados (no de todos los del mes en la BD)
    // Esto asegura que los totales coincidan con los statements mostrados
    const totals = {
      totalSales: formattedStatements.reduce((sum, s) => sum + s.totalSales, 0),
      totalPayouts: formattedStatements.reduce((sum, s) => sum + s.totalPayouts, 0),
      totalListeroCommission: formattedStatements.reduce((sum, s) => sum + s.listeroCommission, 0),
      totalVendedorCommission: formattedStatements.reduce((sum, s) => sum + s.vendedorCommission, 0),
      totalBalance: formattedStatements.reduce((sum, s) => sum + s.balance, 0),
      totalPaid: formattedStatements.reduce((sum, s) => sum + s.totalPaid, 0),
      totalCollected: formattedStatements.reduce((sum, s) => sum + s.totalCollected, 0), // Agregar totalCollected a totales
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
      daysWithStatements: formattedStatements.length, // Días que realmente tienen statements
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

    // Validar tipo de pago según saldo actualizado
    if (currentRemainingBalance < 0) {
      // CxP (Cuenta por Pagar) - solo permite payment
      if (data.type !== "payment") {
        throw new AppError("Solo se permiten pagos cuando el saldo es negativo", 400, "INVALID_PAYMENT_TYPE");
      }
      // FIX: Permitir pagar hasta el saldo exacto (con tolerancia para redondeos)
      const maxAmount = Math.abs(currentRemainingBalance) + 0.01;
      if (data.amount > maxAmount) {
        throw new AppError(`El monto excede el saldo pendiente (${Math.abs(currentRemainingBalance).toFixed(2)})`, 400, "AMOUNT_EXCEEDS_BALANCE");
      }
    } else if (currentRemainingBalance > 0) {
      // CxC (Cuenta por Cobrar) - solo permite collection
      if (data.type !== "collection") {
        throw new AppError("Solo se permiten cobros cuando el saldo es positivo", 400, "INVALID_PAYMENT_TYPE");
      }
      // FIX: Permitir cobrar hasta el saldo exacto (con tolerancia para redondeos)
      const maxAmount = currentRemainingBalance + 0.01;
      if (data.amount > maxAmount) {
        throw new AppError(`El monto excede el saldo pendiente (${currentRemainingBalance.toFixed(2)})`, 400, "AMOUNT_EXCEEDS_BALANCE");
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
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;
    
    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    const isSettled = calculateIsSettled(statement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    await AccountStatementRepository.update(statement.id, {
      totalPaid: newTotalPaid,
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
    const baseBalance = statement.totalSales - statement.totalPayouts;

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

    // Actualizar estado de cuenta
    await AccountStatementRepository.update(statement.id, {
      totalPaid: newTotalPaid,
      remainingBalance: newRemainingBalance,
      isSettled,
      canEdit: !isSettled,
    });

    return reversed;
  },
};

