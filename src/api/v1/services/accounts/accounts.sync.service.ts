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
import { intercalateSorteosAndMovements } from "./accounts.intercalate";

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

      // Obtener tickets del día (SOLO de sorteos EVALUADOS para consistencia con /bySorteo)
      const tickets = await tx.ticket.findMany({
        where: {
          ...dateFilter,
          deletedAt: null,
          isActive: true,
          status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
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

      // Calcular balance del día (SIN movimientos para mantener consistencia con otros servicios)
      const commissionToUse = dimension === "vendedor" ? vendedorCommission : listeroCommission;
      const balance = totalSales - totalPayouts - commissionToUse;

      // 4. Calcular remainingBalance progresivamente (NO con totales agregados)
      // CRÍTICO: remainingBalance debe calcularse PROGRESIVAMENTE iterando eventos en orden cronológico
      //  Para eso, usamos la misma lógica de intercalateSorteosAndMovements que usa /bySorteo

      // Verificar si es el día 1 del mes
      const isFirstDayOfMonth = day === 1;

      // Primero, obtener el accumulated del día anterior
      let previousDayAccumulated = 0;
      if (isFirstDayOfMonth) {
        // Si es día 1, usar el saldo del mes anterior
        const previousMonthBalance = await getPreviousMonthFinalBalance(
          monthStr,
          dimension,
          ventanaId || undefined,
          vendedorId || undefined,
          bancaId || undefined
        );
        previousDayAccumulated = Number(previousMonthBalance) || 0;
      } else {
        // Buscar el statement del día anterior en el mes
        const previousCriteria: any = {
          date: { lt: date, gte: new Date(Date.UTC(year, month - 1, 1)) },
        };

        if (vendedorId) {
          previousCriteria.vendedorId = vendedorId;
        } else if (ventanaId) {
          previousCriteria.ventanaId = ventanaId;
          previousCriteria.vendedorId = null;
        } else if (bancaId) {
          previousCriteria.bancaId = bancaId;
          previousCriteria.ventanaId = null;
          previousCriteria.vendedorId = null;
        }

        const previousStatement = await tx.accountStatement.findFirst({
          where: previousCriteria,
          orderBy: { date: 'desc' },
          select: {
            accumulatedBalance: true,
            remainingBalance: true,
          },
        });

        if (previousStatement) {
          // Usar remainingBalance del día anterior como inicio (es el accumulated del día anterior)
          previousDayAccumulated = Number(previousStatement.remainingBalance) || Number(previousStatement.accumulatedBalance) || 0;
        } else {
          // Si no hay statement anterior en el mes, usar saldo del mes anterior
          const previousMonthBalance = await getPreviousMonthFinalBalance(
            monthStr,
            dimension,
            ventanaId || undefined,
            vendedorId || undefined,
            bancaId || undefined
          );
          previousDayAccumulated = Number(previousMonthBalance) || 0;
        }
      }

      //  Calcular remainingBalance progresivamente: saldo anterior + balance del día + pagos - cobros
      //  Esto equivale a lo que hace intercalateSorteosAndMovements pero de forma simplificada
      //  cuando solo nos interesa el total del día
      const remainingBalance = previousDayAccumulated + balance + totalPaid - totalCollected;

      // 5. accumulatedBalance es el mismo que remainingBalance (ya incluye todo el acumulado)
      //  remainingBalance ya contiene: saldo anterior + balance + movimientos
      const accumulatedBalance = remainingBalance;

      logger.info({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_CALCULATED",
        payload: {
          date: dateStrCR,
          dimension,
          entityId,
          previousDayAccumulated,
          balance,
          totalPaid,
          totalCollected,
          remainingBalance,
          accumulatedBalance,
          note: "remainingBalance calculado progresivamente: saldo anterior + balance + pagos - cobros"
        },
      });

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
   * Sincroniza el statement de un día usando getBySorteo como fuente de verdad única.
   * Garantiza que AccountStatement contenga EXACTAMENTE los mismos valores que /bySorteo.
   *
   * Se usa para flujos que NO requieren transacción: evaluación/reversión de sorteos.
   * Para pagos/cobros que necesitan tx, se sigue usando syncDayStatement.
   *
   * @param dateStr - Fecha en formato YYYY-MM-DD (CR timezone)
   * @param dimension - Dimensión: "banca" | "ventana" | "vendedor"
   * @param entityId - ID de la entidad
   */
  static async syncDayStatementFromBySorteo(
    dateStr: string,
    dimension: "banca" | "ventana" | "vendedor",
    entityId: string
  ): Promise<void> {
    try {
      // 1. Llamar a getBySorteo para obtener los eventos del día
      const { AccountsService } = await import('./accounts.service');

      const filters: {
        dimension: "banca" | "ventana" | "vendedor";
        vendedorId?: string;
        ventanaId?: string;
        bancaId?: string;
      } = { dimension };

      if (dimension === 'vendedor') filters.vendedorId = entityId;
      else if (dimension === 'ventana') filters.ventanaId = entityId;
      else if (dimension === 'banca') filters.bancaId = entityId;

      const bySorteoData = await AccountsService.getBySorteo(dateStr, filters);

      if (!bySorteoData || bySorteoData.length === 0) {
        // No hay sorteos ni movimientos para este día, pero puede existir un statement carry-forward
        // que necesita actualizar su remainingBalance/accumulatedBalance desde el día anterior.
        // Esto ocurre cuando se revierte un pago en un día pasado y los días posteriores
        // son carry-forwards sin actividad.
        await this.syncCarryForwardStatement(dateStr, dimension, entityId);
        return;
      }

      // 2. Extraer totales desde los eventos (misma lógica que fix-statements.ts)
      let totalSales = 0;
      let totalPayouts = 0;
      let listeroCommission = 0;
      let vendedorCommission = 0;
      let totalPaid = 0;
      let totalCollected = 0;

      for (const event of bySorteoData) {
        const isMov = (event.sorteoId || '').startsWith('mov-');
        const isInitial = event.type === 'initial_balance';

        if (!isMov) {
          totalSales += Number(event.sales || 0);
          totalPayouts += Number(event.payouts || 0);
          listeroCommission += Number(event.listeroCommission || 0);
          vendedorCommission += Number(event.vendedorCommission || 0);
        } else if (!isInitial && !event.isReversed) {
          if (event.type === 'payment') {
            totalPaid += Number(event.amount || 0);
          } else if (event.type === 'collection') {
            totalCollected += Number(event.amount || 0);
          }
        }
      }

      // 3. Calcular balance (misma fórmula que getBySorteo usa internamente)
      const commissionToUse = dimension === 'vendedor' ? vendedorCommission : listeroCommission;
      const balance = totalSales - totalPayouts - commissionToUse;

      // 4. Obtener accumulated del último evento cronológico
      const lastEvent = bySorteoData.reduce((max: any, event: any) => {
        return (event.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? event : max;
      }, bySorteoData[0]);

      const accumulatedBalance = parseFloat((lastEvent.accumulated || 0).toFixed(2));
      const remainingBalance = accumulatedBalance;

      // 5. Inferir IDs de entidades padre
      let vendedorId: string | undefined;
      let ventanaId: string | undefined;
      let bancaId: string | undefined;

      if (dimension === 'vendedor') {
        vendedorId = entityId;
        const vendedor = await prisma.user.findUnique({
          where: { id: entityId },
          select: { ventanaId: true },
        });
        ventanaId = vendedor?.ventanaId || undefined;
      } else if (dimension === 'ventana') {
        ventanaId = entityId;
      } else {
        bancaId = entityId;
      }

      if (!bancaId && ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: { bancaId: true },
        });
        bancaId = ventana?.bancaId || undefined;
      }

      // 6. Convertir dateStr a Date UTC
      const [year, month, day] = dateStr.split('-').map(Number);
      const dateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;

      // 7. Buscar statement existente
      let statementToUpdate: any = null;
      if (vendedorId) {
        statementToUpdate = await prisma.accountStatement.findFirst({
          where: { date: dateUTC, vendedorId },
        });
      } else if (ventanaId) {
        statementToUpdate = await prisma.accountStatement.findFirst({
          where: { date: dateUTC, ventanaId, vendedorId: null },
        });
      } else if (bancaId) {
        statementToUpdate = await prisma.accountStatement.findFirst({
          where: { date: dateUTC, bancaId, ventanaId: null, vendedorId: null },
        });
      }

      // 8. Calcular isSettled y ticketCount
      const ticketCount = bySorteoData
        .filter((e: any) => !(e.sorteoId || '').startsWith('mov-'))
        .reduce((sum: number, e: any) => sum + (e.ticketCount || 0), 0);
      const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);

      // 9. Preparar datos (misma estructura que syncDayStatement)
      const updateData = {
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        listeroCommission: parseFloat(listeroCommission.toFixed(2)),
        vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalCollected: parseFloat(totalCollected.toFixed(2)),
        remainingBalance: parseFloat(remainingBalance.toFixed(2)),
        accumulatedBalance: parseFloat(accumulatedBalance.toFixed(2)),
        isSettled,
        canEdit: !isSettled,
        ticketCount,
        month: monthStr,
        bancaId: bancaId || null,
        ventanaId: dimension === 'vendedor' ? null : (ventanaId || null),
        vendedorId: vendedorId || null,
      };

      // 10. Upsert
      if (statementToUpdate) {
        await prisma.accountStatement.update({
          where: { id: statementToUpdate.id },
          data: updateData,
        });
      } else {
        try {
          await prisma.accountStatement.create({
            data: { ...updateData, date: dateUTC },
          });
        } catch (error: any) {
          if (error.code === 'P2002') {
            const retryStmt = await prisma.accountStatement.findFirst({
              where: vendedorId
                ? { date: dateUTC, vendedorId }
                : ventanaId
                  ? { date: dateUTC, ventanaId, vendedorId: null }
                  : { date: dateUTC, bancaId, ventanaId: null, vendedorId: null },
            });
            if (retryStmt) {
              await prisma.accountStatement.update({
                where: { id: retryStmt.id },
                data: updateData,
              });
            }
          } else {
            throw error;
          }
        }
      }

      logger.info({
        layer: "service",
        action: "SYNC_FROM_BYSORTEO_COMPLETED",
        payload: {
          dateStr, dimension, entityId,
          totalSales: updateData.totalSales,
          totalPayouts: updateData.totalPayouts,
          balance: updateData.balance,
          remainingBalance: updateData.remainingBalance,
          accumulatedBalance: updateData.accumulatedBalance,
        },
      });

    } catch (error) {
      logger.error({
        layer: "service",
        action: "SYNC_FROM_BYSORTEO_ERROR",
        payload: {
          dateStr, dimension, entityId,
          error: (error as Error).message,
        },
      });
      throw error; // Propagar — el caller (syncSorteoStatements) decide qué hacer
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
      const uniqueVendedores = new Set<string>();
      const uniqueVentanas = new Set<string>();
      const uniqueBancas = new Set<string>();

      for (const ticket of affectedTickets) {
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
      const [year, month, day] = sorteoDateStrCR.split('-').map(Number);
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      const syncPromises: Promise<void>[] = [];
      const dateStr = crDateService.postgresDateToCRString(sorteoDateUTC);

      for (const vendedorId of Array.from(uniqueVendedores)) {
        syncPromises.push(
          this.syncDayStatementFromBySorteo(dateStr, "vendedor", vendedorId)
        );
      }
      for (const ventanaId of Array.from(uniqueVentanas)) {
        syncPromises.push(
          this.syncDayStatementFromBySorteo(dateStr, "ventana", ventanaId)
        );
      }
      for (const bancaId of Array.from(uniqueBancas)) {
        syncPromises.push(
          this.syncDayStatementFromBySorteo(dateStr, "banca", bancaId)
        );
      }

      // Ejecutar TODOS los syncs aunque alguno falle (allSettled)
      const syncResults = await Promise.allSettled(syncPromises);
      const syncFailures = syncResults.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

      if (syncFailures.length > 0) {
        logger.error({
          layer: "service",
          action: "SYNC_SORTEO_STATEMENTS_PARTIAL_FAILURE",
          payload: {
            sorteoId,
            sorteoDateStrCR,
            totalSyncs: syncResults.length,
            failures: syncFailures.length,
            errors: syncFailures.map(f => f.reason?.message || String(f.reason)),
          },
        });
      }

      // Propagar cambios si el sorteo es de una fecha pasada
      const todayCR = crDateService.dateUTCToCRString(new Date());
      if (sorteoDateStrCR < todayCR) {
        logger.info({
          layer: "service",
          action: "SYNC_SORTEO_STATEMENTS_PROPAGATING",
          payload: { sorteoId, sorteoDateStrCR, todayCR }
        });

        const propagationPromises: Promise<void>[] = [];
        for (const vendedorId of Array.from(uniqueVendedores)) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "vendedor", vendedorId));
        }
        for (const ventanaId of Array.from(uniqueVentanas)) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "ventana", ventanaId));
        }
        for (const bancaId of Array.from(uniqueBancas)) {
          propagationPromises.push(this.propagateBalanceChange(sorteoDateUTC, "banca", bancaId));
        }

        const propResults = await Promise.allSettled(propagationPromises);
        const propFailures = propResults.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

        if (propFailures.length > 0) {
          logger.error({
            layer: "service",
            action: "SYNC_SORTEO_STATEMENTS_PROPAGATION_FAILURE",
            payload: {
              sorteoId,
              sorteoDateStrCR,
              totalPropagations: propResults.length,
              failures: propFailures.length,
              errors: propFailures.map(f => f.reason?.message || String(f.reason)),
            },
          });
        }
      }

      const totalFailures = syncFailures.length;
      const totalSynced = syncResults.length - totalFailures;

      logger.info({
        layer: "service",
        action: "SYNC_SORTEO_STATEMENTS_COMPLETED",
        payload: {
          sorteoId,
          sorteoDateStrCR,
          entitiesSynced: totalSynced,
          entitiesFailed: totalFailures,
        },
      });

      // Si hubo fallos, propagar el error al caller (evaluate/revert)
      if (totalFailures > 0) {
        throw new Error(
          `Sync parcial: ${totalFailures}/${syncResults.length} entidades fallaron. ` +
          `Errores: ${syncFailures.map(f => f.reason?.message).join('; ')}`
        );
      }
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
      throw error; // Propagar — evaluate()/revertEvaluation() decide qué hacer
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
        await this.syncDayStatementFromBySorteo(dayStrCR, dimension, entityId!);

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
   * Sincroniza un statement carry-forward (sin sorteos ni movimientos) actualizando
   * remainingBalance y accumulatedBalance desde el día anterior.
   *
   * Esto resuelve el caso donde se revierte un pago en un día pasado y los días posteriores
   * son carry-forwards sin actividad: antes se hacía return sin actualizar, dejando
   * remainingBalance/accumulatedBalance desactualizados.
   */
  private static async syncCarryForwardStatement(
    dateStr: string,
    dimension: "banca" | "ventana" | "vendedor",
    entityId: string
  ): Promise<void> {
    const [year, month, day] = dateStr.split('-').map(Number);
    const dateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    // 1. Buscar el statement existente para este día/entidad
    let existingStmt: any = null;
    if (dimension === 'vendedor') {
      existingStmt = await prisma.accountStatement.findFirst({
        where: { date: dateUTC, vendedorId: entityId },
      });
    } else if (dimension === 'ventana') {
      existingStmt = await prisma.accountStatement.findFirst({
        where: { date: dateUTC, ventanaId: entityId, vendedorId: null },
      });
    } else if (dimension === 'banca') {
      existingStmt = await prisma.accountStatement.findFirst({
        where: { date: dateUTC, bancaId: entityId, ventanaId: null, vendedorId: null },
      });
    }

    if (!existingStmt) {
      logger.info({
        layer: "service",
        action: "SYNC_CARRY_FORWARD_NO_STATEMENT",
        payload: { dateStr, dimension, entityId },
      });
      return;
    }

    // 2. Obtener el accumulatedBalance del día anterior
    let previousDayAccumulated = 0;
    const isFirstDayOfMonth = day === 1;

    if (isFirstDayOfMonth) {
      previousDayAccumulated = Number(await getPreviousMonthFinalBalance(
        monthStr,
        dimension,
        dimension === 'ventana' ? entityId : undefined,
        dimension === 'vendedor' ? entityId : undefined,
        dimension === 'banca' ? entityId : undefined
      )) || 0;
    } else {
      const previousCriteria: any = {
        date: { lt: dateUTC, gte: new Date(Date.UTC(year, month - 1, 1)) },
      };

      if (dimension === 'vendedor') {
        previousCriteria.vendedorId = entityId;
      } else if (dimension === 'ventana') {
        previousCriteria.ventanaId = entityId;
        previousCriteria.vendedorId = null;
      } else if (dimension === 'banca') {
        previousCriteria.bancaId = entityId;
        previousCriteria.ventanaId = null;
        previousCriteria.vendedorId = null;
      }

      const previousStatement = await prisma.accountStatement.findFirst({
        where: previousCriteria,
        orderBy: { date: 'desc' },
        select: { remainingBalance: true, accumulatedBalance: true },
      });

      if (previousStatement) {
        previousDayAccumulated = Number(previousStatement.remainingBalance) || Number(previousStatement.accumulatedBalance) || 0;
      } else {
        previousDayAccumulated = Number(await getPreviousMonthFinalBalance(
          monthStr,
          dimension,
          dimension === 'ventana' ? entityId : undefined,
          dimension === 'vendedor' ? entityId : undefined,
          dimension === 'banca' ? entityId : undefined
        )) || 0;
      }
    }

    // 3. Para un carry-forward sin actividad: remaining = previous accumulated
    const newRemaining = parseFloat(previousDayAccumulated.toFixed(2));

    if (Math.abs(existingStmt.remainingBalance - newRemaining) > 0.01) {
      await prisma.accountStatement.update({
        where: { id: existingStmt.id },
        data: {
          remainingBalance: newRemaining,
          accumulatedBalance: newRemaining,
        },
      });

      logger.info({
        layer: "service",
        action: "SYNC_CARRY_FORWARD_UPDATED",
        payload: {
          dateStr, dimension, entityId,
          previousRemaining: existingStmt.remainingBalance,
          newRemaining,
          previousDayAccumulated,
        },
      });
    } else {
      logger.info({
        layer: "service",
        action: "SYNC_CARRY_FORWARD_NO_CHANGE",
        payload: { dateStr, dimension, entityId, remainingBalance: existingStmt.remainingBalance },
      });
    }
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
        const stmtDateStr = crDateService.postgresDateToCRString(stmt.date);
        await this.syncDayStatementFromBySorteo(stmtDateStr, dimension, entityId!);
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
