/**
 * ️ ESTÁNDAR CRÍTICO: ZONA HORARIA COSTA RICA
 * 
 * TODAS las fechas en este servicio se manejan en hora LOCAL de Costa Rica (UTC-6).
 * NUNCA usar new Date() directamente sin convertir primero a CR.
 * 
 * Este servicio sincroniza AccountStatement para mantener accumulatedBalance como fuente de verdad.
 */

import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AppError } from "../../../../core/errors";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountStatementRepository as ASRepo } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { ACCOUNT_CARRY_OVER_NOTES, ACCOUNT_PREVIOUS_MONTH_METHOD } from "./accounts.types";
import { calculateIsSettled } from "./accounts.commissions";
import { buildTicketDateFilter } from "./accounts.dates.utils";
import { crDateService } from "../../../../utils/crDateService";
import { getPreviousMonthFinalBalance } from "./accounts.balances";
import { getExcludedTicketIdsForDate } from "./accounts.calculations";

/**
 * Servicio de sincronización de AccountStatement
 * 
 * Mantiene accumulatedBalance como fuente de verdad, actualizando statements cuando ocurren eventos.
 * El acumulado progresivo se calcula día a día en orden cronológico, basándose siempre en el día anterior.
 */
export class AccountStatementSyncService {
  /**
   * Sincroniza el statement de un día específico
   * Recalcula todos los campos desde tickets EVALUADOS y movimientos
   * Actualiza accumulatedBalance basado en el día anterior (o saldo del mes anterior si es día 1)
   * 
   * ️ CRÍTICO: date debe ser Date UTC que representa un día calendario en CR
   * Usar: new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)) donde year/month/day son del día en CR
   * 
   * @param date - Date UTC que representa día calendario en CR
   * @param dimension - Dimensión: "banca" | "ventana" | "vendedor"
   * @param entityId - ID de la entidad (bancaId, ventanaId o vendedorId según dimension)
   * @param options - Opciones adicionales
   */
  static async syncDayStatement(
    date: Date, // Date UTC que representa día calendario en CR
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string,
    options?: { force?: boolean, tx?: Prisma.TransactionClient } // Forzar recálculo incluso si isSettled=true
  ): Promise<void> {
    // ️ CRÍTICO: Convertir date a string CR para operaciones
    const dateStrCR = crDateService.postgresDateToCRString(date);

    //  VALIDACIÓN CRÍTICA: No permitir crear AccountStatement para días futuros
    // EXCEPCIÓN: Si force=true, permitir procesar (puede ser necesario para correcciones)
    const todayCR = crDateService.dateUTCToCRString(new Date());
    if (dateStrCR > todayCR && !options?.force) {
      logger.warn({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_FUTURE_DATE_PREVENTED",
        payload: {
          date: dateStrCR,
          today: todayCR,
          dimension,
          entityId,
          note: "Prevented creating AccountStatement for future date (use force=true to override)",
        },
      });
      return; // No procesar días futuros (a menos que force=true)
    }

    //  Si es día futuro pero force=true, permitir procesar (para correcciones o sincronización de sorteos)
    if (dateStrCR > todayCR && options?.force) {
      logger.info({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_FUTURE_DATE_ALLOWED",
        payload: {
          date: dateStrCR,
          today: todayCR,
          dimension,
          entityId,
          note: "Processing future date because force=true (may be for sorteo sync or corrections)",
        },
      });
    }

    const [year, month, day] = dateStrCR.split('-').map(Number);
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    // Determinar IDs según dimensión
    let bancaId: string | undefined = undefined;
    let ventanaId: string | undefined = undefined;
    let vendedorId: string | undefined = undefined;

    if (dimension === "banca") {
      bancaId = entityId;
    } else if (dimension === "ventana") {
      ventanaId = entityId;
    } else {
      vendedorId = entityId;
    }

    // ️ CRÍTICO: Inferir ventanaId y bancaId ANTES de la transacción
    // para buscar correctamente el statement (puede que ya exista)
    let finalVentanaId = ventanaId;
    let finalBancaId = bancaId;

    if (!finalVentanaId && vendedorId) {
      const vendedor = await prisma.user.findUnique({
        where: { id: vendedorId },
        select: { ventanaId: true },
      });
      finalVentanaId = vendedor?.ventanaId || undefined;
    }

    if (!finalBancaId && finalVentanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: finalVentanaId },
        select: { bancaId: true },
      });
      finalBancaId = ventana?.bancaId || undefined;
    }

    // Definir lógica de ejecución
    const execute = async (tx: Prisma.TransactionClient) => {
      // 1. Buscar statement existente con los IDs correctos
      // ️ CRÍTICO: Para vendedores, buscar primero por vendedorId específicamente
      // porque el constraint único (date, ventanaId) puede tener conflicto con statement consolidado
      let statement: any = null;

      if (vendedorId) {
        // Para vendedores: buscar por vendedorId (constraint único: date, vendedorId)
        statement = await tx.accountStatement.findFirst({
          where: {
            date: date,
            vendedorId: vendedorId,
          },
        });
      } else if (finalVentanaId) {
        // Para ventanas: buscar por ventanaId sin vendedorId (constraint único: date, ventanaId)
        statement = await tx.accountStatement.findFirst({
          where: {
            date: date,
            ventanaId: finalVentanaId,
            vendedorId: null,
          },
        });
      } else if (finalBancaId) {
        // Para bancas: buscar por bancaId sin ventanaId ni vendedorId
        statement = await tx.accountStatement.findFirst({
          where: {
            date: date,
            bancaId: finalBancaId,
            ventanaId: null,
            vendedorId: null,
          },
        });
      }

      // 2. Si no existe y force=false, no hacer nada (puede que el día no tenga actividad)
      if (!statement && !options?.force) {
        return;
      }

      // 3. Calcular balance del día desde tickets EVALUADOS y movimientos
      // ️ CRÍTICO: Solo considerar sorteos EVALUADOS para payouts y comisiones
      const dateFilter = buildTicketDateFilter(date);

      //  Obtener tickets excluidos para esta fecha
      const excludedTicketIds = await getExcludedTicketIdsForDate(date);

      // Obtener tickets del día (Incluir ACTIVE para reportar ventas en tiempo real)
      const tickets = await tx.ticket.findMany({
        where: {
          ...dateFilter,
          deletedAt: null,
          isActive: true,
          status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
          sorteo: {
            deletedAt: null,
          },
          ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
          ...(bancaId ? {
            ventana: { bancaId: bancaId }
          } : {}),
          ...(ventanaId ? { ventanaId: ventanaId } : {}),
          ...(vendedorId ? { vendedorId: vendedorId } : {}),
        },
        select: {
          id: true,
          totalAmount: true,
          status: true,
          ventanaId: true,
          vendedorId: true,
          ventana: {
            select: { bancaId: true }
          }
        },
      });

      logger.info({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_TICKETS_FOUND",
        payload: {
          date: dateStrCR,
          dimension,
          entityId,
          ticketsCount: tickets.length,
          activeTickets: tickets.filter(t => t.status === "ACTIVE").length,
          evaluatedTickets: tickets.filter(t => ["EVALUATED", "PAID", "PAGADO"].includes(t.status)).length,
        },
      });

      // ️ CRÍTICO: Usar la MISMA lógica que calculateDayStatement para mantener consistencia
      // Para payouts: solo tickets que tienen jugadas ganadoras (isWinner=true)
      // NO solo tickets con sorteos EVALUADOS, porque un ticket puede tener sorteo EVALUATED
      // pero no tener jugadas ganadoras
      const ticketsWithWinningJugadas = await tx.ticket.findMany({
        where: {
          ...dateFilter,
          deletedAt: null,
          isActive: true,
          status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
          ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
          sorteo: {
            status: "EVALUATED",
            deletedAt: null,
          },
          jugadas: {
            some: {
              isWinner: true,
              deletedAt: null,
            },
          },
          ...(bancaId ? {
            ventana: { bancaId: bancaId }
          } : {}),
          ...(ventanaId ? { ventanaId: ventanaId } : {}),
          ...(vendedorId ? { vendedorId: vendedorId } : {}),
        },
        select: {
          id: true,
          totalPayout: true,
          jugadas: {
            where: {
              deletedAt: null,
              isActive: true,
            },
            select: {
              amount: true,
              commissionAmount: true,
              listeroCommissionAmount: true,
              commissionOrigin: true,
              isWinner: true,
            },
          },
        },
      });

      // Obtener tickets con sorteos EVALUADOS para calcular comisiones (TODAS las jugadas, no solo ganadoras)
      const ticketsForCommissions = await tx.ticket.findMany({
        where: {
          ...dateFilter,
          deletedAt: null,
          isActive: true,
          status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
          ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
          sorteo: {
            status: "EVALUATED",
            deletedAt: null,
          },
          ...(bancaId ? {
            ventana: { bancaId: bancaId }
          } : {}),
          ...(ventanaId ? { ventanaId: ventanaId } : {}),
          ...(vendedorId ? { vendedorId: vendedorId } : {}),
        },
        select: {
          id: true,
          jugadas: {
            where: {
              deletedAt: null,
              isActive: true,
            },
            select: {
              amount: true,
              commissionAmount: true,
              listeroCommissionAmount: true,
              commissionOrigin: true,
            },
          },
        },
      });

      // Calcular totales
      //  CRÍTICO: totalSales desde TODOS los tickets (como calculateDayStatement)
      const totalSales = tickets.reduce((sum, t) => sum + Number(t.totalAmount || 0), 0);
      //  CRÍTICO: totalPayouts solo de tickets que tienen jugadas ganadoras (como calculateDayStatement)
      const totalPayouts = ticketsWithWinningJugadas.reduce((sum, t) => sum + Number(t.totalPayout || 0), 0);

      // Calcular comisiones desde TODAS las jugadas de tickets con sorteos EVALUADOS
      let listeroCommission = 0;
      let vendedorCommission = 0;

      for (const ticket of ticketsForCommissions) {
        for (const jugada of ticket.jugadas) {
          listeroCommission += Number(jugada.listeroCommissionAmount || 0);
          if (jugada.commissionOrigin === "USER") {
            vendedorCommission += Number(jugada.commissionAmount || 0);
          }
        }
      }

      // Obtener totales de movimientos usando el cliente de la transacción
      const [totalP, totalC] = await Promise.all([
        tx.accountPayment.aggregate({
          where: {
            accountStatementId: statement?.id || undefined,
            // Si el statement no existe aún, necesitamos buscar por fecha y dimensiones
            ...(!statement ? {
              date: date,
              vendedorId: vendedorId || null,
              ventanaId: dimension === "vendedor" ? null : (finalVentanaId || null),
              bancaId: finalBancaId || null,
            } : {}),
            isReversed: false,
            type: "payment",
            //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
            method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
            OR: [
              { notes: null },
              { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
            ]
          },
          _sum: { amount: true }
        }),
        tx.accountPayment.aggregate({
          where: {
            accountStatementId: statement?.id || undefined,
            ...(!statement ? {
              date: date,
              vendedorId: vendedorId || null,
              ventanaId: dimension === "vendedor" ? null : (finalVentanaId || null),
              bancaId: finalBancaId || null,
            } : {}),
            isReversed: false,
            type: "collection",
            //  FIX: Manejar notes=null correctamente (NULL LIKE '%text%' retorna NULL, no false)
            method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
            OR: [
              { notes: null },
              { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }
            ]
          },
          _sum: { amount: true }
        })
      ]);

      const totalPaid = totalP._sum.amount || 0;
      const totalCollected = totalC._sum.amount || 0;

      // Calcular balance del día
      const commissionToUse = dimension === "vendedor" ? vendedorCommission : listeroCommission;
      const balance = totalSales - totalPayouts - commissionToUse + totalPaid - totalCollected;

      // 4. Calcular accumulatedBalance
      let accumulatedBalance: number = 0; // Inicializar con valor por defecto

      // Verificar si es el día 1 del mes
      const isFirstDayOfMonth = day === 1;

      if (isFirstDayOfMonth) {
        // Usar saldo del mes anterior
        const previousMonthBalance = await getPreviousMonthFinalBalance(
          monthStr,
          dimension,
          ventanaId || undefined,
          vendedorId || undefined,
          bancaId || undefined
        );
        accumulatedBalance = Number(previousMonthBalance) + balance;

        logger.info({
          layer: "service",
          action: "SYNC_DAY_STATEMENT_FIRST_DAY",
          payload: {
            date: dateStrCR,
            dimension,
            entityId,
            previousMonthBalance: Number(previousMonthBalance),
            balance,
            accumulatedBalance,
          },
        });
      } else {
        // Buscar statement del día más reciente antes de hoy en el mismo mes
        // ️ MEJORA: Maneja huecos de actividad buscando el último statement disponible
        let previousStatement: any = null;
        const previousCriteria: any = {
          date: { lt: date, gte: new Date(Date.UTC(year, month - 1, 1)) },
        };

        if (vendedorId) {
          // Buscar por vendedorId (sin considerar ventanaId)
          previousCriteria.vendedorId = vendedorId;
        } else if (ventanaId) {
          // Para ventanas: buscar por ventanaId sin vendedorId
          previousCriteria.ventanaId = ventanaId;
          previousCriteria.vendedorId = null;
        } else if (bancaId) {
          // Para bancas: buscar por bancaId sin ventanaId ni vendedorId
          previousCriteria.bancaId = bancaId;
          previousCriteria.ventanaId = null;
          previousCriteria.vendedorId = null;
        }

        previousStatement = await tx.accountStatement.findFirst({
          where: previousCriteria,
          orderBy: { date: 'desc' },
          select: {
            accumulatedBalance: true,
            date: true,
          },
        });

        if (previousStatement && previousStatement.accumulatedBalance !== null && previousStatement.accumulatedBalance !== undefined) {
          //  CRÍTICO: Usar accumulatedBalance del día anterior encontrado + balance recalculado
          const previousAccumulated = Number(previousStatement.accumulatedBalance) || 0;
          accumulatedBalance = previousAccumulated + balance;

          logger.info({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_FROM_PREVIOUS",
            payload: {
              date: dateStrCR,
              previousDate: crDateService.postgresDateToCRString(previousStatement.date),
              dimension,
              entityId,
              previousAccumulatedBalance: Number(previousStatement.accumulatedBalance),
              balance,
              accumulatedBalance,
            },
          });
        } else {
          //  CRÍTICO: Si no hay statement previo en el mes, usar saldo del mes anterior
          const previousMonthBalance = await getPreviousMonthFinalBalance(
            monthStr,
            dimension,
            dimension === "vendedor" ? undefined : (ventanaId || undefined), //  NO pasar ventanaId para vendedores
            vendedorId || undefined,
            bancaId || undefined
          );
          accumulatedBalance = Number(previousMonthBalance) + balance;

          logger.info({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_NO_PREVIOUS_DAY_USE_MONTH_BALANCE",
            payload: {
              date: dateStrCR,
              dimension,
              entityId,
              previousMonthBalance: Number(previousMonthBalance),
              balance,
              accumulatedBalance,
              note: "No se encontró statement previo en el mes, usando saldo del mes anterior",
            },
          });
        }
      }

      // 5. Calcular remainingBalance
      let remainingBalance = accumulatedBalance;

      // 6. Determinar isSettled
      const ticketCount = tickets.length;
      const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);

      // 7. Preparar datos de actualización
      const updateData = {
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        listeroCommission: parseFloat(listeroCommission.toFixed(2)),
        vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalCollected: parseFloat(totalCollected.toFixed(2)),
        remainingBalance: parseFloat(remainingBalance.toFixed(2)),
        accumulatedBalance: parseFloat(accumulatedBalance.toFixed(2)), //  CRÍTICO: Guardar accumulatedBalance
        isSettled,
        canEdit: !isSettled,
        ticketCount,
        month: monthStr,
        bancaId: finalBancaId,
        ventanaId: dimension === "vendedor" ? null : (finalVentanaId || null),
        vendedorId: vendedorId || null,
      };

      // 8. Guardar o actualizar el statement de forma robusta
      // CRÍTICO: Intentar encontrar registro existente primero
      const statementToUpdate = await tx.accountStatement.findFirst({
        where: dimension === "vendedor" && vendedorId
          ? { date, vendedorId }
          : dimension === "ventana" && finalVentanaId
            ? { date, ventanaId: finalVentanaId, vendedorId: null }
            : { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null },
      });

      try {
        if (statementToUpdate) {
          await tx.accountStatement.update({
            where: { id: statementToUpdate.id },
            data: updateData,
          });
        } else {
          await tx.accountStatement.create({
            data: {
              ...updateData,
              date: date,
            },
          });
        }
      } catch (error: any) {
        //  MANEJO DE CONCURRENCIA: Si falla por unique constraint (P2002), intentar update
        if (error.code === "P2002") {
          const retryStatement = await tx.accountStatement.findFirst({
            where: dimension === "vendedor" && vendedorId
              ? { date, vendedorId }
              : dimension === "ventana" && finalVentanaId
                ? { date, ventanaId: finalVentanaId, vendedorId: null }
                : { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null },
          });
          if (retryStatement) {
            await tx.accountStatement.update({
              where: { id: retryStatement.id },
              data: updateData,
            });
          }
        } else {
          throw error;
        }
      }

      logger.info({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_COMPLETED",
        payload: {
          date: dateStrCR,
          dimension,
          entityId,
          totalSales,
          totalPayouts,
          balance,
          accumulatedBalance,
          remainingBalance,
          isSettled,
        },
      });
    };

    // Usar transacción proporcionada o crear una nueva
    if (options?.tx) {
      await execute(options.tx);
    } else {
      await prisma.$transaction(async (tx) => {
        await execute(tx);
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 30000,
      });
    }
  }

  /**
   * Sincroniza todos los statements afectados por un sorteo
   * Se llama después de evaluar un sorteo
   * 
   * ️ CRÍTICO: sorteoDate debe ser Date UTC que representa el día calendario en CR
   * donde ocurrió el sorteo (extraer desde sorteo.scheduledAt convertido a CR)
   * 
   * @param sorteoId - ID del sorteo evaluado
   * @param sorteoDate - Date UTC que representa día calendario en CR
   */
  static async syncSorteoStatements(
    sorteoId: string,
    sorteoDate: Date // Date UTC que representa día calendario en CR
  ): Promise<void> {
    // ️ CRÍTICO: Convertir scheduledAt a fecha CR
    const sorteoDateStrCR = crDateService.postgresDateToCRString(sorteoDate);

    try {
      // 1. Obtener todos los tickets afectados por el sorteo
      // ️ FIX: NO usar distinct - obtener TODOS los tickets y agregar manualmente
      const affectedTickets = await prisma.ticket.findMany({
        where: {
          sorteoId: sorteoId,
          status: { not: "CANCELLED" },
          isActive: true,
          deletedAt: null,
        },
        select: {
          businessDate: true,
          ventanaId: true,
          vendedorId: true,
          ventana: {
            select: {
              bancaId: true,
            },
          },
        },
      });

      if (affectedTickets.length === 0) {
        logger.warn({
          layer: "service",
          action: "SYNC_SORTEO_STATEMENTS_NO_TICKETS",
          payload: {
            sorteoId,
            sorteoDateStrCR,
          },
        });
        return;
      }

      // 2. Agregar manualmente todas las entidades únicas que necesitan sincronización
      // Usar Sets para garantizar unicidad
      const uniqueVendedores = new Set<string>();
      const uniqueVentanas = new Set<string>();
      const uniqueBancas = new Set<string>();

      // Recolectar dimensiones únicas de todos los tickets afectados por el sorteo
      for (const ticket of affectedTickets) {
        // Recolectar todas las dimensiones únicas
        if (ticket.vendedorId) {
          uniqueVendedores.add(ticket.vendedorId);
        }
        if (ticket.ventanaId) {
          uniqueVentanas.add(ticket.ventanaId);
        }
        if (ticket.ventana?.bancaId) {
          uniqueBancas.add(ticket.ventana.bancaId);
        }
      }

      logger.info({
        layer: "service",
        action: "SYNC_SORTEO_STATEMENTS_DIMENSIONS_FOUND",
        payload: {
          sorteoId,
          sorteoDateStrCR,
          uniqueVendedores: Array.from(uniqueVendedores),
          uniqueVentanas: Array.from(uniqueVentanas),
          uniqueBancas: Array.from(uniqueBancas),
        },
      });

      // 3. Sincronizar statements para cada entidad única
      // Convertir sorteoDateStrCR a Date UTC para sincronización
      const [year, month, day] = sorteoDateStrCR.split('-').map(Number);
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      const syncPromises: Promise<void>[] = [];

      // Sincronizar todos los vendedores
      for (const vendedorId of uniqueVendedores) {
        syncPromises.push(
          this.syncDayStatement(
            sorteoDateUTC,
            "vendedor",
            vendedorId,
            { force: true }
          )
        );
      }

      // Sincronizar todas las ventanas
      for (const ventanaId of uniqueVentanas) {
        syncPromises.push(
          this.syncDayStatement(
            sorteoDateUTC,
            "ventana",
            ventanaId,
            { force: true }
          )
        );
      }

      // Sincronizar todas las bancas
      for (const bancaId of uniqueBancas) {
        syncPromises.push(
          this.syncDayStatement(
            sorteoDateUTC,
            "banca",
            bancaId,
            { force: true }
          )
        );
      }

      await Promise.all(syncPromises);

      //  CRÍTICO: Propagar cambios si el sorteo es de una fecha pasada
      const todayCR = crDateService.dateUTCToCRString(new Date());
      if (sorteoDateStrCR < todayCR) {
        logger.info({
          layer: "service",
          action: "SYNC_SORTEO_STATEMENTS_PROPAGATING",
          payload: { sorteoId, sorteoDateStrCR, todayCR }
        });

        // Propagar para cada entidad (en paralelo para rendimiento)
        const propagationPromises: Promise<void>[] = [];

        for (const vendedorId of uniqueVendedores) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "vendedor", vendedorId));
        }
        for (const ventanaId of uniqueVentanas) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "ventana", ventanaId));
        }
        for (const bancaId of uniqueBancas) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "banca", bancaId));
        }

        await Promise.all(propagationPromises);
      }

      logger.info({
        layer: "service",
        action: "SYNC_SORTEO_STATEMENTS_COMPLETED",
        payload: {
          sorteoId,
          sorteoDateStrCR,
          entitiesSynced: uniqueVendedores.size + uniqueVentanas.size + uniqueBancas.size,
        },
      });
    } catch (error) {
      logger.error({
        layer: "service",
        action: "SYNC_SORTEO_STATEMENTS_ERROR",
        payload: {
          sorteoId,
          sorteoDateStrCR,
          error: (error as Error).message,
        },
      });
      // No relanzar el error - no debe romper la evaluación del sorteo
    }
  }

  /**
   * Recalcula accumulatedBalance para un rango de días
   * Útil para correcciones masivas o migración de datos
   * 
   * ️ CRÍTICO: Procesa días en orden cronológico ASC para asegurar que accumulatedBalance
   * se calcule correctamente día a día
   * 
   * @param startDate - Fecha inicio (Date UTC que representa día calendario en CR)
   * @param endDate - Fecha fin (Date UTC que representa día calendario en CR)
   * @param dimension - Dimensión
   * @param entityId - ID de la entidad
   */
  static async recalculateAccumulatedBalance(
    startDate: Date, // Date UTC que representa día calendario en CR
    endDate: Date, // Date UTC que representa día calendario en CR
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
    // ️ CRÍTICO: Convertir fechas a CR
    const startDateStrCR = crDateService.postgresDateToCRString(startDate);
    const endDateStrCR = crDateService.postgresDateToCRString(endDate);

    logger.info({
      layer: "service",
      action: "RECALCULATE_ACCUMULATED_BALANCE_START",
      payload: {
        startDateStrCR,
        endDateStrCR,
        dimension,
        entityId,
      },
    });

    //  CORREGIDO: Si dimension="ventana" o "vendedor" sin entityId, iterar sobre todas las entidades
    if ((dimension === "ventana" || dimension === "vendedor") && !entityId) {
      let entities: Array<{ id: string }>;

      if (dimension === "ventana") {
        entities = await prisma.ventana.findMany({
          where: { deletedAt: null },
          select: { id: true },
        });
      } else {
        entities = await prisma.user.findMany({
          where: {
            role: "VENDEDOR",
            deletedAt: null,
          },
          select: { id: true },
        });
      }

      logger.info({
        layer: "service",
        action: "RECALCULATE_ACCUMULATED_BALANCE_MULTIPLE_ENTITIES",
        payload: {
          dimension,
          totalEntities: entities.length,
        },
      });

      // Procesar cada entidad individualmente
      for (const entity of entities) {
        await this.recalculateAccumulatedBalance(startDate, endDate, dimension, entity.id);
      }

      return;
    }

    // Generar lista de días en orden cronológico ASC
    const daysToProcess: Date[] = [];
    const [startYear, startMonth, startDay] = startDateStrCR.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStrCR.split('-').map(Number);

    let currentDate = new Date(Date.UTC(startYear, startMonth - 1, startDay));
    const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay));

    while (currentDate <= endDateObj) {
      daysToProcess.push(new Date(currentDate));
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    // Procesar días en orden ASC (crítico para accumulatedBalance)
    for (let i = 0; i < daysToProcess.length; i++) {
      const day = daysToProcess[i];
      const dayStrCR = crDateService.postgresDateToCRString(day);

      try {
        await this.syncDayStatement(day, dimension, entityId, { force: true });

        // Log de progreso cada 10 días
        if ((i + 1) % 10 === 0 || i === daysToProcess.length - 1) {
          logger.info({
            layer: "service",
            action: "RECALCULATE_ACCUMULATED_BALANCE_PROGRESS",
            payload: {
              currentDate: dayStrCR,
              processed: i + 1,
              total: daysToProcess.length,
              progress: ((i + 1) / daysToProcess.length * 100).toFixed(1) + '%',
            },
          });
        }
      } catch (error) {
        logger.error({
          layer: "service",
          action: "RECALCULATE_ACCUMULATED_BALANCE_DAY_ERROR",
          payload: {
            date: dayStrCR,
            dimension,
            entityId,
            error: (error as Error).message,
          },
        });
        // Continuar con el siguiente día aunque falle uno
      }
    }

    logger.info({
      layer: "service",
      action: "RECALCULATE_ACCUMULATED_BALANCE_COMPLETED",
      payload: {
        startDateStrCR,
        endDateStrCR,
        dimension,
        entityId,
        daysProcessed: daysToProcess.length,
      },
    });
  }

  /**
   * Propaga un cambio de saldo a los días posteriores del mismo mes
   * Se debe llamar después de registrar o revertir un pago en un día pasado
   * 
   * @param startDate - Fecha del cambio (los cambios se propagan a partir del día SIGUIENTE)
   * @param dimension - Dimensión
   * @param entityId - ID de la entidad
   */
  static async propagateBalanceChange(
    startDate: Date,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
    const dateStrCR = crDateService.postgresDateToCRString(startDate);
    const [year, month] = dateStrCR.split('-').map(Number);
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    logger.info({
      layer: "service",
      action: "PROPAGATE_BALANCE_CHANGE_START",
      payload: {
        startDate: dateStrCR,
        dimension,
        entityId,
      },
    });

    // 1. Encontrar todos los statements existentes de esta entidad a partir de la fecha indicada
    //  CRÍTICO: No limitar al mes actual, permitir propagación a meses futuros si existen
    const where: any = {
      date: { gt: startDate },
    };

    if (dimension === "vendedor") {
      where.vendedorId = entityId;
    } else if (dimension === "ventana") {
      where.ventanaId = entityId;
      where.vendedorId = null;
    } else if (dimension === "banca") {
      where.bancaId = entityId;
      where.ventanaId = null;
      where.vendedorId = null;
    }

    const statementsToUpdate = await prisma.accountStatement.findMany({
      where,
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    if (statementsToUpdate.length === 0) {
      logger.info({
        layer: "service",
        action: "PROPAGATE_BALANCE_CHANGE_NO_STATEMENTS",
        payload: { date: dateStrCR, dimension, entityId },
      });
      return;
    }

    // 2. Sincronizar cada día en orden cronológico ASC
    // Esto asegura que el accumulatedBalance se arrastre correctamente
    for (const stmt of statementsToUpdate) {
      try {
        await this.syncDayStatement(stmt.date, dimension, entityId, { force: true });
      } catch (error) {
        logger.error({
          layer: "service",
          action: "PROPAGATE_BALANCE_CHANGE_DAY_ERROR",
          payload: {
            date: crDateService.postgresDateToCRString(stmt.date),
            dimension,
            entityId,
            error: (error as Error).message,
          },
        });
      }
    }

    logger.info({
      layer: "service",
      action: "PROPAGATE_BALANCE_CHANGE_COMPLETED",
      payload: {
        startDate: dateStrCR,
        dimension,
        entityId,
        statementsUpdated: statementsToUpdate.length,
      },
    });
  }
}
