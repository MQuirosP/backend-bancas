// src/api/v1/services/accounts.service.ts
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { AccountStatementRepository } from "../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { resolveCommission } from "../../../services/commission.resolver";

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
 */
function getMonthDateRange(month: string): { startDate: Date; endDate: Date; daysInMonth: number } {
  const [year, monthNum] = month.split("-").map(Number);
  const startDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));
  const daysInMonth = endDate.getDate();
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
  const where: any = {
    createdAt: {
      gte: new Date(date.getTime()),
      lt: new Date(date.getTime() + 24 * 60 * 60 * 1000),
    },
    deletedAt: null,
    status: { not: "CANCELLED" },
  };

  if (ventanaId) {
    where.ventanaId = ventanaId;
  }
  if (vendedorId) {
    where.vendedorId = vendedorId;
  }

  // Usar agregaciones de Prisma para calcular totales directamente en la base de datos
  // Esto es mucho más eficiente que traer todos los tickets y jugadas a memoria
  const [ticketAgg, jugadaAggAll, jugadaAggWinners] = await Promise.all([
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
        // Sin filtro isWinner para comisiones (todas las jugadas tienen comisión)
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
  // IMPORTANTE: totalVendedorCommission debe incluir TODAS las jugadas, no solo ganadoras
  // Las comisiones se aplican a todas las jugadas, no solo a las ganadoras
  const totalVendedorCommission = jugadaAggAll._sum.commissionAmount || 0;

  // Calcular comisiones según dimensión
  let totalListeroCommission = 0;

  if (dimension === "ventana") {
    // Para ventana, necesitamos la comisión del listero (ventana)
    // La comisión guardada en jugadas puede ser del vendedor (USER), ventana (VENTANA) o banca (BANCA)
    // Si commissionOrigin es "VENTANA" o "BANCA", usar directamente commissionAmount
    // Si commissionOrigin es "USER", necesitamos calcular la comisión de la ventana
    // Obtener jugadas con commissionOrigin para optimizar
    const jugadas = await prisma.jugada.findMany({
      where: {
        ticket: where,
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        commissionAmount: true,
        commissionOrigin: true, // Para saber si es USER, VENTANA o BANCA
        type: true,
        finalMultiplierX: true,
        ticket: {
          select: {
            loteriaId: true,
            ventanaId: true,
          },
        },
      },
    });

    // Separar jugadas por origen de comisión
    const jugadasFromVentanaOrBanca = jugadas.filter(
      (j) => j.commissionOrigin === "VENTANA" || j.commissionOrigin === "BANCA"
    );
    const jugadasFromUser = jugadas.filter((j) => j.commissionOrigin === "USER");

    // Sumar directamente las comisiones que ya son de ventana/banca
    totalListeroCommission = jugadasFromVentanaOrBanca.reduce(
      (sum, j) => sum + (j.commissionAmount || 0),
      0
    );

    // Para jugadas con comisión del vendedor (USER), calcular la comisión de la ventana
    if (jugadasFromUser.length > 0) {
      // Obtener políticas de ventana/banca de una vez
      const ventanaIds = new Set<string>();
      for (const jugada of jugadasFromUser) {
        if (jugada.ticket.ventanaId) {
          ventanaIds.add(jugada.ticket.ventanaId);
        }
      }

      if (ventanaIds.size > 0) {
        const ventanasWithBancas = await prisma.ventana.findMany({
          where: {
            id: { in: Array.from(ventanaIds) },
          },
          select: {
            id: true,
            commissionPolicyJson: true,
            banca: {
              select: {
                commissionPolicyJson: true,
              },
            },
          },
        });

        // Crear mapa de políticas
        const policiesMap = new Map<string, { ventanaPolicy: any; bancaPolicy: any }>();
        for (const ventana of ventanasWithBancas) {
          policiesMap.set(ventana.id, {
            ventanaPolicy: ventana.commissionPolicyJson as any,
            bancaPolicy: ventana.banca?.commissionPolicyJson as any,
          });
        }

        // Calcular comisión de la ventana solo para jugadas con comisión del vendedor
        for (const jugada of jugadasFromUser) {
          const ventanaId = jugada.ticket.ventanaId;
          if (!ventanaId) continue;

          const policies = policiesMap.get(ventanaId);
          if (!policies) continue;

          // Calcular comisión de la ventana (sin considerar USER)
          const res = resolveCommission(
            {
              loteriaId: jugada.ticket.loteriaId,
              betType: jugada.type as "NUMERO" | "REVENTADO",
              finalMultiplierX: jugada.finalMultiplierX || 0,
              amount: jugada.amount,
            },
            null, // No considerar USER
            policies.ventanaPolicy,
            policies.bancaPolicy
          );

          totalListeroCommission += res.commissionAmount;
        }
      }
    }
  } else {
    // Para vendedor, necesitamos calcular la comisión del listero
    // La comisión guardada es del vendedor, necesitamos calcular la de la ventana
    // OPTIMIZACIÓN: Solo obtener jugadas necesarias para calcular comisión del listero
    // Si hay muchas jugadas, esto puede ser lento, pero es mejor que traer todos los tickets
    
    // Obtener solo las jugadas necesarias con información mínima
    const jugadas = await prisma.jugada.findMany({
      where: {
        ticket: where,
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        commissionAmount: true,
        type: true,
        finalMultiplierX: true,
        ticket: {
          select: {
            loteriaId: true,
            ventanaId: true,
          },
        },
      },
    });

    // Obtener políticas de ventana/banca de una vez
    const ventanaIds = new Set<string>();
    for (const jugada of jugadas) {
      if (jugada.ticket.ventanaId) {
        ventanaIds.add(jugada.ticket.ventanaId);
      }
    }

    if (ventanaIds.size > 0) {
      const ventanasWithBancas = await prisma.ventana.findMany({
        where: {
          id: { in: Array.from(ventanaIds) },
        },
        select: {
          id: true,
          commissionPolicyJson: true,
          banca: {
            select: {
              commissionPolicyJson: true,
            },
          },
        },
      });

      // Crear mapa de políticas
      const policiesMap = new Map<string, { ventanaPolicy: any; bancaPolicy: any }>();
      for (const ventana of ventanasWithBancas) {
        policiesMap.set(ventana.id, {
          ventanaPolicy: ventana.commissionPolicyJson as any,
          bancaPolicy: ventana.banca?.commissionPolicyJson as any,
        });
      }

      // Calcular comisión del listero solo para las jugadas
      for (const jugada of jugadas) {
        const ventanaId = jugada.ticket.ventanaId;
        if (!ventanaId) continue;

        const policies = policiesMap.get(ventanaId);
        if (!policies) continue;

        // Calcular comisión de la ventana
        const res = resolveCommission(
          {
            loteriaId: jugada.ticket.loteriaId,
            betType: jugada.type as "NUMERO" | "REVENTADO",
            finalMultiplierX: jugada.finalMultiplierX || 0,
            amount: jugada.amount,
          },
          null,
          policies.ventanaPolicy,
          policies.bancaPolicy
        );

        const ventanaCommissionAmount = res.commissionAmount;
        const vendedorCommissionAmount = jugada.commissionAmount || 0;

        // Comisión del listero = diferencia entre ventana y vendedor
        totalListeroCommission += Math.max(0, ventanaCommissionAmount - vendedorCommissionAmount);
      }
    }
  }

  // Calcular saldo
  const balance = totalSales - totalPayouts;

  // Si no hay tickets, no crear statement (retornar valores por defecto)
  if (ticketCount === 0) {
    return {
      date,
      month,
      ventanaId: ventanaId || null,
      vendedorId: vendedorId || null,
      totalSales: 0,
      totalPayouts: 0,
      listeroCommission: 0,
      vendedorCommission: 0,
      balance: 0,
      totalPaid: 0,
      remainingBalance: 0,
      isSettled: false, // No está saldado si no hay tickets
      canEdit: true,
      ticketCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
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

  // Calcular saldo restante según el documento: remainingBalance = baseBalance - totalPaid + totalCollected
  const remainingBalance = balance - totalPaid + totalCollected;

  // Determinar si está saldado
  // CRÍTICO: Solo está saldado si hay tickets Y el saldo es cero Y hay pagos/cobros registrados
  // IMPORTANTE: No marcar como saldado si no hay pagos registrados, incluso si balance = 0
  // Esto evita confusión cuando un listero ve su propio estado de cuenta (no puede registrar pagos de sí mismo)
  // Un día solo está saldado si:
  // 1. Hay tickets
  // 2. El saldo restante es cero (o muy cercano)
  // 3. Hay al menos un pago o cobro registrado (totalPaid > 0 o totalCollected > 0)
  const hasPayments = totalPaid > 0 || totalCollected > 0;
  const isSettled = ticketCount > 0 && Math.abs(remainingBalance) < 0.01 && hasPayments;
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
      let filteredStatements = statementsWithRelations.filter((s) => {
        if (dimension === "ventana") {
          return s.ventanaId !== null && s.vendedorId === null;
        } else {
          return s.vendedorId !== null && s.ventanaId === null;
        }
      });

      // Si no hay statements existentes, calcular basándose en tickets del mes
      if (filteredStatements.length === 0) {
        logger.info({
          layer: "service",
          action: "ACCOUNTS_STATEMENT_CALCULATE_FROM_TICKETS",
          payload: { month, dimension, message: "No hay statements existentes, calculando desde tickets" },
        });

        // Obtener todas las ventanas/vendedores que tienen tickets en el mes
        const tickets = await prisma.ticket.findMany({
          where: {
            createdAt: {
              gte: startDate,
              lte: endDate,
            },
            deletedAt: null,
            status: { not: "CANCELLED" },
          },
          select: {
            id: true,
            ventanaId: true,
            vendedorId: true,
            createdAt: true,
          },
        });

        // Agrupar por ventana/vendedor y fecha
        const statementsMap = new Map<string, any>();

        for (const ticket of tickets) {
          const ticketDate = new Date(ticket.createdAt);
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
        const calculatedStatements = [];
        for (const [key, statementInfo] of statementsMap) {
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

      // Formatear respuesta - retornar directamente el array en lugar de data.data
      // Incluir campos según la dimensión (omitir campos null innecesarios)
      const statements = filteredStatements.map((s) => {
        const base = {
          date: s.date.toISOString().split("T")[0],
          totalSales: s.totalSales,
          totalPayouts: s.totalPayouts,
          listeroCommission: s.listeroCommission,
          vendedorCommission: s.vendedorCommission,
          balance: s.balance,
          totalPaid: s.totalPaid,
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
            ventanaName: s.ventana?.name || null,
            ventanaCode: s.ventana?.code || null,
          };
        } else {
          return {
            ...base,
            vendedorId: s.vendedorId,
            vendedorName: s.vendedor?.name || null,
            vendedorCode: s.vendedor?.code || null,
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
    const ticketsWithDates = await prisma.ticket.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        deletedAt: null,
        status: { not: "CANCELLED" },
        ...(ventanaId ? { ventanaId } : {}),
        ...(vendedorId ? { vendedorId } : {}),
      },
      select: {
        createdAt: true,
      },
    });

    // Extraer días únicos
    const uniqueDays = new Set<string>();
    for (const ticket of ticketsWithDates) {
      const ticketDate = new Date(ticket.createdAt);
      ticketDate.setUTCHours(0, 0, 0, 0);
      uniqueDays.add(ticketDate.toISOString().split("T")[0]);
    }

    // Calcular statements solo para días con tickets
    const statements = [];
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

    // Obtener estados de cuenta del repositorio con relaciones para obtener nombres y códigos
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

    // Obtener o crear estado de cuenta
    const statement = await AccountStatementRepository.findOrCreate({
      date: paymentDate,
      month,
      ventanaId: data.ventanaId,
      vendedorId: data.vendedorId,
    });

    // Validar que se puede editar
    if (!statement.canEdit) {
      throw new AppError("El estado de cuenta ya está saldado", 400, "STATEMENT_SETTLED");
    }

    // Validar tipo de pago según saldo
    const remainingBalance = statement.remainingBalance || 0;
    if (remainingBalance < 0) {
      // CxP (Cuenta por Pagar) - solo permite payment
      if (data.type !== "payment") {
        throw new AppError("Solo se permiten pagos cuando el saldo es negativo", 400, "INVALID_PAYMENT_TYPE");
      }
      if (data.amount > Math.abs(remainingBalance)) {
        throw new AppError(`El monto excede el saldo pendiente (${Math.abs(remainingBalance)})`, 400, "AMOUNT_EXCEEDS_BALANCE");
      }
    } else if (remainingBalance > 0) {
      // CxC (Cuenta por Cobrar) - solo permite collection
      if (data.type !== "collection") {
        throw new AppError("Solo se permiten cobros cuando el saldo es positivo", 400, "INVALID_PAYMENT_TYPE");
      }
      if (data.amount > remainingBalance) {
        throw new AppError(`El monto excede el saldo pendiente (${remainingBalance})`, 400, "AMOUNT_EXCEEDS_BALANCE");
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

    // Calcular saldo base del día (sin pagos/cobros)
    const baseBalance = statement.totalSales - statement.totalPayouts;

    // Recalcular saldo restante según el documento: remainingBalance = baseBalance - totalPaid + totalCollected
    const newRemainingBalance = baseBalance - newTotalPaid + newTotalCollected;
    const isSettled = Math.abs(newRemainingBalance) < 0.01;

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

    // Obtener todos los pagos activos del día (no revertidos)
    const activePayments = await AccountPaymentRepository.findActiveByDate(
      payment.date,
      {
        ventanaId: payment.ventanaId ?? undefined,
        vendedorId: payment.vendedorId ?? undefined,
      }
    );

    // Calcular saldo base del día (sin pagos/cobros)
    const baseBalance = statement.totalSales - statement.totalPayouts;

    // Calcular total de pagos y cobros activos (ya están filtrados por findActiveByDate)
    const totalPaid = activePayments
      .filter((p) => p.type === "payment")
      .reduce((sum, p) => sum + p.amount, 0);
    const totalCollected = activePayments
      .filter((p) => p.type === "collection")
      .reduce((sum, p) => sum + p.amount, 0);

    // Calcular saldo actual (con todos los pagos activos)
    const currentBalance = baseBalance - totalPaid + totalCollected;

    // Calcular saldo después de revertir este pago
    let balanceAfterReversal: number;
    if (payment.type === "payment") {
      // Si es un pago, al revertirlo se suma al saldo (se quita el pago)
      balanceAfterReversal = currentBalance + payment.amount;
    } else {
      // Si es un cobro, al revertirlo se resta del saldo (se quita el cobro)
      balanceAfterReversal = currentBalance - payment.amount;
    }

    // CRÍTICO: Validar que el día NO quede saldado
    const absBalance = Math.abs(balanceAfterReversal);
    if (absBalance <= 0.01) {
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

    // Recalcular saldo restante según el documento: remainingBalance = baseBalance - totalPaid + totalCollected
    // (baseBalance ya fue calculado arriba)
    const newRemainingBalance = baseBalance - newTotalPaid + newTotalCollected;
    const isSettled = Math.abs(newRemainingBalance) < 0.01;

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

