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
    options?: { force?: boolean } // Forzar recálculo incluso si isSettled=true
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

    // Usar transacción para asegurar consistencia
    await prisma.$transaction(async (tx) => {
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

      // Obtener tickets del día (SOLO tickets con sorteos EVALUADOS para consistencia de balance)
      const tickets = await tx.ticket.findMany({
        where: {
          ...dateFilter,
          deletedAt: null,
          isActive: true,
          status: { in: ["EVALUATED", "PAID", "PAGADO"] }, // Excluir ACTIVE
          sorteo: {
            status: "EVALUATED",
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
          ventanaId: true,
          vendedorId: true,
          ventana: {
            select: { bancaId: true }
          }
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
            NOT: {
              OR: [
                { notes: { contains: 'Saldo arrastrado' } },
                { method: 'Saldo del mes anterior' }
              ]
            }
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
            NOT: {
              OR: [
                { notes: { contains: 'Saldo arrastrado' } },
                { method: 'Saldo del mes anterior' }
              ]
            }
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
        // Buscar statement del día anterior
        const previousDayDate = new Date(Date.UTC(year, month - 1, day - 1));
        const previousDateStrCR = crDateService.postgresDateToCRString(previousDayDate);

        // ️ CRÍTICO: Para vendedores, buscar SOLO por vendedorId (sin ventanaId)
        // porque los statements de vendedores pueden tener ventanaId: null para evitar conflictos
        let previousStatement: any = null;

        if (vendedorId) {
          // Buscar por vendedorId (sin considerar ventanaId)
          previousStatement = await tx.accountStatement.findFirst({
            where: {
              date: previousDayDate,
              vendedorId: vendedorId,
            },
            select: {
              accumulatedBalance: true,
            },
          });
        } else if (ventanaId) {
          // Para ventanas: buscar por ventanaId sin vendedorId
          previousStatement = await tx.accountStatement.findFirst({
            where: {
              date: previousDayDate,
              ventanaId: ventanaId,
              vendedorId: null,
            },
            select: {
              accumulatedBalance: true,
            },
          });
        } else if (bancaId) {
          // Para bancas: buscar por bancaId sin ventanaId ni vendedorId
          previousStatement = await tx.accountStatement.findFirst({
            where: {
              date: previousDayDate,
              bancaId: bancaId,
              ventanaId: null,
              vendedorId: null,
            },
            select: {
              accumulatedBalance: true,
            },
          });
        }

        if (previousStatement && previousStatement.accumulatedBalance !== null && previousStatement.accumulatedBalance !== undefined) {
          //  CRÍTICO: Usar accumulatedBalance del día anterior + balance recalculado
          // El balance recalculado debe reflejar el estado actual de tickets y movimientos
          const previousAccumulated = Number(previousStatement.accumulatedBalance) || 0;
          accumulatedBalance = previousAccumulated + balance;

          logger.info({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_FROM_PREVIOUS",
            payload: {
              date: dateStrCR,
              previousDate: previousDateStrCR,
              dimension,
              entityId,
              previousAccumulatedBalance: Number(previousStatement.accumulatedBalance),
              balance,
              accumulatedBalance,
            },
          });
        } else {
          //  CRÍTICO: Si no hay statement del día anterior, usar saldo del mes anterior
          // NO buscar retroactivamente porque puede encontrar valores de otros vendedores/ventanas
          // El saldo del mes anterior es la fuente de verdad cuando no hay statement del día anterior
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
              previousDate: previousDateStrCR,
              dimension,
              entityId,
              previousMonthBalance: Number(previousMonthBalance),
              balance,
              accumulatedBalance,
              note: "No se encontró statement del día anterior, usando saldo del mes anterior",
            },
          });
        }
      }

      // 5. Calcular remainingBalance desde sorteos evaluados y movimientos
      //  CORRECCIÓN CRÍTICA: remainingBalance debe ser el acumulado al FINAL del día
      // después de todos los sorteos y movimientos en orden cronológico.
      // 
      // accumulatedBalance = saldoInicialDia + balance
      // donde balance = totalSales - totalPayouts - commission + totalPaid - totalCollected
      // 
      // remainingBalance debe ser igual a accumulatedBalance porque accumulatedBalance
      // ya incluye todos los sorteos y movimientos del día (a través de balance).
      // 
      // Sin embargo, si queremos ser más precisos, remainingBalance debería ser el
      // último accumulated después de intercalar sorteos y movimientos, pero eso
      // requiere calcular bySorteo, lo cual es costoso aquí.
      // 
      // Por ahora, usamos accumulatedBalance como remainingBalance porque:
      // - accumulatedBalance ya incluye todo el balance del día
      // - El orden cronológico de sorteos/movimientos no cambia el balance total
      // - La diferencia solo importa para el desglose bySorteo, que se calcula en getStatementDirect
      let remainingBalance = accumulatedBalance;

      //  VALIDACIÓN: Si accumulatedBalance es 0 pero hay actividad, puede ser un error
      // (a menos que el saldo del día anterior también sea 0 y el balance del día sea 0)
      if (accumulatedBalance === 0 && (totalSales > 0 || totalPayouts > 0 || totalPaid > 0 || totalCollected > 0)) {
        logger.warn({
          layer: "service",
          action: "SYNC_DAY_STATEMENT_ZERO_ACCUMULATED_WITH_ACTIVITY",
          payload: {
            date: dateStrCR,
            dimension,
            entityId,
            totalSales,
            totalPayouts,
            totalPaid,
            totalCollected,
            balance,
            accumulatedBalance,
            note: "accumulatedBalance is 0 but there is activity - this may be correct if previous day balance was negative and day balance is positive, or vice versa",
          },
        });
      }

      // 6. Determinar isSettled
      const ticketCount = tickets.length;
      const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);

      // 7-8. Usar upsert directamente dentro de la transacción (más seguro y eficiente)
      //  CORREGIDO: Usar upsert en lugar de findOrCreate + update para evitar errores
      // cuando el registro no existe o está fuera de la transacción
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
        ventanaId: dimension === "vendedor" ? null : (finalVentanaId || null), //  CORREGIDO: Usar null explícito para vendedores
        vendedorId: vendedorId || null,
      };

      //  CORRECCIÓN: Usar findFirst + update/create en lugar de upsert
      // porque Prisma no soporta upsert con constraints únicos compuestos directamente
      //  CRÍTICO: Para vendedor, buscar por date + vendedorId (puede tener o no ventanaId)
      const existingStatement = await tx.accountStatement.findFirst({
        where: dimension === "vendedor" && vendedorId
          ? { date, vendedorId } //  No filtrar por ventanaId, puede tener o no
          : dimension === "ventana" && finalVentanaId
            ? { date, ventanaId: finalVentanaId, vendedorId: null }
            : dimension === "banca" && finalBancaId
              ? { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null }
              : { date },
      });

      if (existingStatement) {
        await tx.accountStatement.update({
          where: { id: existingStatement.id },
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
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 30000,
    });
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
        distinct: ['businessDate', 'ventanaId', 'vendedorId'],
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

      // 2. Agrupar por combinación única de día/ventana/vendedor/banca
      const uniqueCombinations = new Map<string, {
        businessDate: Date;
        bancaId: string | null;
        ventanaId: string | null;
        vendedorId: string | null;
      }>();

      for (const ticket of affectedTickets) {
        if (!ticket.businessDate) continue;

        // ️ CRÍTICO: businessDate ya está en formato CR (DATE de PostgreSQL)
        const ticketDateStrCR = crDateService.postgresDateToCRString(ticket.businessDate);

        // Solo sincronizar statements del día del sorteo
        if (ticketDateStrCR !== sorteoDateStrCR) {
          continue;
        }

        const bancaId = ticket.ventana?.bancaId || null;
        const key = `${ticketDateStrCR}|${bancaId || 'null'}|${ticket.ventanaId || 'null'}|${ticket.vendedorId || 'null'}`;

        if (!uniqueCombinations.has(key)) {
          uniqueCombinations.set(key, {
            businessDate: ticket.businessDate,
            bancaId,
            ventanaId: ticket.ventanaId,
            vendedorId: ticket.vendedorId,
          });
        }
      }

      // 3. Sincronizar statements para cada combinación única
      const syncPromises = Array.from(uniqueCombinations.values()).map(async (combo) => {
        // Sincronizar statement de vendedor (si hay vendedorId)
        if (combo.vendedorId) {
          await this.syncDayStatement(
            combo.businessDate,
            "vendedor",
            combo.vendedorId,
            { force: true }
          );
        }

        // Sincronizar statement consolidado de ventana (si hay ventanaId)
        if (combo.ventanaId) {
          await this.syncDayStatement(
            combo.businessDate,
            "ventana",
            combo.ventanaId,
            { force: true }
          );
        }

        // Sincronizar statement consolidado de banca (si hay bancaId)
        if (combo.bancaId) {
          await this.syncDayStatement(
            combo.businessDate,
            "banca",
            combo.bancaId,
            { force: true }
          );
        }
      });

      await Promise.all(syncPromises);

      logger.info({
        layer: "service",
        action: "SYNC_SORTEO_STATEMENTS_COMPLETED",
        payload: {
          sorteoId,
          sorteoDateStrCR,
          combinationsSynced: uniqueCombinations.size,
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
}
