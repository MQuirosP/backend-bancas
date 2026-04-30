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
import { KeyedTaskQueue } from "../../../../core/keyedTaskQueue";
import { ConcurrencyManager } from "../../../../utils/concurrency";

const SYNC_BATCH_SIZE = 5;

/**
 * Ejecuta promesas en batches de tamaño fijo.
 * Equivalente a p-limit pero sin dependencia externa.
 */
async function batchedAllSettled<T>(
  tasks: (() => Promise<T>)[],
  batchSize: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Servicio de sincronización de AccountStatement
 * 
 * Mantiene accumulatedBalance como fuente de verdad, actualizando statements cuando ocurren eventos.
 * El acumulado progresivo se calcula día a día en orden cronológico, basándose siempre en el día anterior.
 */
export class AccountStatementSyncService {
  /**
   * Obtiene la clave de serialización única por entidad
   */
  private static getQueueKey(dimension: string, entityId?: string): string {
    return `sync-entity-${dimension}-${entityId || 'global'}`;
  }

  /**
   * Sincroniza el statement de un día específico
   */
  static async syncDayStatement(
    date: Date,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string,
    options?: { force?: boolean }
  ): Promise<void> {
    const queueKey = this.getQueueKey(dimension, entityId);
    return KeyedTaskQueue.enqueue(queueKey, () => 
      this._syncDayStatementInternal(date, dimension, entityId, options)
    );
  }

  /**
   * Lógica interna de sincronización (Hilo Único)
   */
  private static async _syncDayStatementInternal(
    date: Date,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string,
    options?: { force?: boolean }
  ): Promise<void> {
    const dateStrCR = crDateService.postgresDateToCRString(date);
    const todayCR = crDateService.dateUTCToCRString(new Date());

    if (dateStrCR > todayCR && !options?.force) {
      return;
    }

    const [year, month, day] = dateStrCR.split('-').map(Number);
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

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

    // 1. Fase de Cómputo (FUERA de transacción)
    // Validación inicial mínima para early exit (opcional, sin bloqueo)
    if (!options?.force) {
      const exists = await prisma.accountStatement.findFirst({
        where: dimension === "vendedor" ? { date, vendedorId } : dimension === "ventana" ? { date, ventanaId: finalVentanaId, vendedorId: null } : { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null },
        select: { id: true }
      });
      if (!exists) return;
    }

    const dateFilter = buildTicketDateFilter(date);
    const excludedTicketIds = await getExcludedTicketIdsForDate(date);

    // Obtener tickets del día (uso de prisma global para cómputo stateless)
    const tickets = await prisma.ticket.findMany({
      where: {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
        sorteo: { status: "EVALUATED", deletedAt: null },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
        ...(bancaId ? { ventana: { bancaId: bancaId } } : {}),
        ...(ventanaId ? { ventanaId: ventanaId } : {}),
        ...(vendedorId ? { vendedorId: vendedorId } : {}),
      },
      select: { id: true, totalAmount: true, status: true }
    });

    const ticketsWithWinningJugadas = await prisma.ticket.findMany({
      where: {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
        sorteo: { status: "EVALUATED", deletedAt: null },
        jugadas: { some: { isWinner: true, deletedAt: null } },
        ...(bancaId ? { ventana: { bancaId: bancaId } } : {}),
        ...(ventanaId ? { ventanaId: ventanaId } : {}),
        ...(vendedorId ? { vendedorId: vendedorId } : {}),
      },
      select: { id: true, totalPayout: true }
    });

    const ticketsForCommissions = await prisma.ticket.findMany({
      where: {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}),
        sorteo: { status: "EVALUATED", deletedAt: null },
        ...(bancaId ? { ventana: { bancaId: bancaId } } : {}),
        ...(ventanaId ? { ventanaId: ventanaId } : {}),
        ...(vendedorId ? { vendedorId: vendedorId } : {}),
      },
      select: {
        id: true,
        jugadas: {
          where: { deletedAt: null, isActive: true, isExcluded: false },
          select: { amount: true, listeroCommissionAmount: true, commissionAmount: true, commissionOrigin: true }
        }
      }
    });

    const totalSales = tickets.reduce((sum, t) => sum + Number(t.totalAmount || 0), 0);
    const totalPayouts = ticketsWithWinningJugadas.reduce((sum, t) => sum + Number(t.totalPayout || 0), 0);

    let listeroCommission = 0;
    let vendedorCommission = 0;
    for (const ticket of ticketsForCommissions) {
      for (const jugada of ticket.jugadas) {
        listeroCommission += Number(jugada.listeroCommissionAmount || 0);
        if (jugada.commissionOrigin === "USER") vendedorCommission += Number(jugada.commissionAmount || 0);
      }
    }

    const [totalP, totalC] = await Promise.all([
      prisma.accountPayment.aggregate({
        where: {
          date,
          vendedorId: vendedorId || null,
          // Si es dimensión vendedor, no filtramos por ventanaId (incluye pagos con/sin ventana)
          // Si es dimensión ventana, buscamos solo los de la ventana que NO son de un vendedor
          ...(dimension === "ventana" ? { ventanaId: finalVentanaId, vendedorId: null } : {}),
          // Si es dimensión banca, buscamos solo los de la banca que NO son de ventana/vendedor
          ...(dimension === "banca" ? { bancaId: finalBancaId, ventanaId: null, vendedorId: null } : {}),
          isReversed: false,
          type: "payment",
          method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
          OR: [{ notes: null }, { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }]
        },
        _sum: { amount: true }
      }),
      prisma.accountPayment.aggregate({
        where: {
          date,
          vendedorId: vendedorId || null,
          // Si es dimensión vendedor, no filtramos por ventanaId (incluye pagos con/sin ventana)
          // Si es dimensión ventana, buscamos solo los de la ventana que NO son de un vendedor
          ...(dimension === "ventana" ? { ventanaId: finalVentanaId, vendedorId: null } : {}),
          // Si es dimensión banca, buscamos solo los de la banca que NO son de ventana/vendedor
          ...(dimension === "banca" ? { bancaId: finalBancaId, ventanaId: null, vendedorId: null } : {}),
          isReversed: false,
          type: "collection",
          method: { not: ACCOUNT_PREVIOUS_MONTH_METHOD },
          OR: [{ notes: null }, { NOT: { notes: { contains: ACCOUNT_CARRY_OVER_NOTES } } }]
        },
        _sum: { amount: true }
      })
    ]);

    const totalPaid = totalP._sum.amount || 0;
    const totalCollected = totalC._sum.amount || 0;
    const balance = totalSales - totalPayouts - (dimension === "vendedor" ? vendedorCommission : listeroCommission);

    let previousDayAccumulated = 0;
    if (day === 1) {
      previousDayAccumulated = await getPreviousMonthFinalBalance(monthStr, dimension, ventanaId || undefined, vendedorId || undefined, bancaId || undefined);
    } else {
      const prevStmt = await prisma.accountStatement.findFirst({
        where: {
          date: { lt: date, gte: new Date(Date.UTC(year, month - 1, 1)) },
          ...(vendedorId ? { vendedorId } : dimension === "ventana" ? { ventanaId, vendedorId: null } : { bancaId, ventanaId: null, vendedorId: null })
        },
        orderBy: { date: 'desc' },
        select: { accumulatedBalance: true, remainingBalance: true }
      });
      previousDayAccumulated = Number(prevStmt?.remainingBalance || prevStmt?.accumulatedBalance || 0);
      if (!prevStmt) {
        previousDayAccumulated = await getPreviousMonthFinalBalance(monthStr, dimension, ventanaId || undefined, vendedorId || undefined, bancaId || undefined);
      }
    }

    const accumulatedBalance = previousDayAccumulated + balance + totalPaid - totalCollected;
    const updateData = {
      totalSales: parseFloat(totalSales.toFixed(2)),
      totalPayouts: parseFloat(totalPayouts.toFixed(2)),
      listeroCommission: parseFloat(listeroCommission.toFixed(2)),
      vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
      balance: parseFloat(balance.toFixed(2)),
      totalPaid: parseFloat(totalPaid.toFixed(2)),
      totalCollected: parseFloat(totalCollected.toFixed(2)),
      remainingBalance: parseFloat(accumulatedBalance.toFixed(2)),
      accumulatedBalance: parseFloat(accumulatedBalance.toFixed(2)),
      isSettled: calculateIsSettled(tickets.length, accumulatedBalance, totalPaid, totalCollected),
      canEdit: true,
      ticketCount: tickets.length,
      month: monthStr,
      bancaId: finalBancaId,
      ventanaId: dimension === "vendedor" ? null : (finalVentanaId || null),
      vendedorId: vendedorId || null,
    };

    // 2. Fase de Escritura (DENTRO de transacción corta)
    const writePhase = async (tx: Prisma.TransactionClient) => {
      // Re-leer SIEMPRE dentro del tx para garantizar consistencia (Race Condition fix)
      let stmt = null;
      if (vendedorId) stmt = await tx.accountStatement.findFirst({ where: { date, vendedorId } });
      else if (finalVentanaId) stmt = await tx.accountStatement.findFirst({ where: { date, ventanaId: finalVentanaId, vendedorId: null } });
      else if (finalBancaId) stmt = await tx.accountStatement.findFirst({ where: { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null } });

      if (stmt) {
        // Bloqueo explícito FOR UPDATE
        await tx.$executeRaw`SELECT 1 FROM "AccountStatement" WHERE id = CAST(${stmt.id} AS uuid) FOR UPDATE`;
        await tx.accountStatement.update({ where: { id: stmt.id }, data: updateData });
      } else {
        try {
          await tx.accountStatement.create({ data: { ...updateData, date: date } });
        } catch (e: any) {
          if (e.code === 'P2002') {
            const retry = await tx.accountStatement.findFirst({
              where: dimension === "vendedor" ? { date, vendedorId } : dimension === "ventana" ? { date, ventanaId: finalVentanaId, vendedorId: null } : { date, bancaId: finalBancaId, ventanaId: null, vendedorId: null }
            });
            if (retry) {
              await tx.$executeRaw`SELECT 1 FROM "AccountStatement" WHERE id = CAST(${retry.id} AS uuid) FOR UPDATE`;
              await tx.accountStatement.update({ where: { id: retry.id }, data: updateData });
            }
          } else throw e;
        }
      }
    };

    await prisma.$transaction(async (tx) => {
      await writePhase(tx);
    }, { timeout: 10000 });
  }

  /**
   * Sincroniza el statement de un día usando getBySorteo como fuente de verdad única.
   */
  static async syncDayStatementFromBySorteo(
    dateStr: string,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
    const queueKey = this.getQueueKey(dimension, entityId);
    return KeyedTaskQueue.enqueue(queueKey, () => 
      this._syncDayStatementFromBySorteoInternal(dateStr, dimension, entityId)
    );
  }

  /**
   * Lógica interna de sincronización desde Sorteo (Hilo Único)
   */
  private static async _syncDayStatementFromBySorteoInternal(
    dateStr: string,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
      // 1. Fase de Cómputo (FUERA de transacción)
      const { AccountsService } = await import('./accounts.service');
      const filters: any = { dimension };
      if (dimension === 'vendedor') filters.vendedorId = entityId;
      else if (dimension === 'ventana') filters.ventanaId = entityId;
      else if (dimension === 'banca') filters.bancaId = entityId;

      // Usar prisma global para el cómputo masivo
      const bySorteoData = await AccountsService.getBySorteo(dateStr, filters, true, prisma);

      if (!bySorteoData || bySorteoData.length === 0) {
        await this.syncCarryForwardStatement(dateStr, dimension, entityId);
        return;
      }

      let totalSales = 0, totalPayouts = 0, listeroCommission = 0, vendedorCommission = 0, totalPaid = 0, totalCollected = 0;
      for (const event of bySorteoData) {
        const isMov = (event.sorteoId || '').startsWith('mov-');
        if (!isMov) {
          totalSales += Number(event.sales || 0);
          totalPayouts += Number(event.payouts || 0);
          listeroCommission += Number(event.listeroCommission || 0);
          vendedorCommission += Number(event.vendedorCommission || 0);
        } else if (event.type !== 'initial_balance' && !event.isReversed) {
          if (event.type === 'payment') totalPaid += Number(event.amount || 0);
          else if (event.type === 'collection') totalCollected += Number(event.amount || 0);
        }
      }

      const balance = totalSales - totalPayouts - (dimension === 'vendedor' ? vendedorCommission : listeroCommission);
      const lastEvent = bySorteoData.reduce((max: any, e: any) => (e.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? e : max, bySorteoData[0]);
      const accumulatedBalance = parseFloat((lastEvent.accumulated || 0).toFixed(2));

      let vendedorId: string | undefined, ventanaId: string | undefined, bancaId: string | undefined;
      if (dimension === 'vendedor') {
        vendedorId = entityId;
        const v = await prisma.user.findUnique({ where: { id: entityId }, select: { ventanaId: true } });
        ventanaId = v?.ventanaId || undefined;
      } else if (dimension === 'ventana') ventanaId = entityId;
      else bancaId = entityId;

      if (!bancaId && ventanaId) {
        const v = await prisma.ventana.findUnique({ where: { id: ventanaId }, select: { bancaId: true } });
        bancaId = v?.bancaId || undefined;
      }

      const [year, month, day] = dateStr.split('-').map(Number);
      const dateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      const updateData = {
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        listeroCommission: parseFloat(listeroCommission.toFixed(2)),
        vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalCollected: parseFloat(totalCollected.toFixed(2)),
        remainingBalance: accumulatedBalance,
        accumulatedBalance: accumulatedBalance,
        isSettled: calculateIsSettled(bySorteoData.filter((e: any) => !(e.sorteoId || '').startsWith('mov-')).reduce((sum: number, e: any) => sum + (e.ticketCount || 0), 0), accumulatedBalance, totalPaid, totalCollected),
        canEdit: true,
        ticketCount: bySorteoData.filter((e: any) => !(e.sorteoId || '').startsWith('mov-')).reduce((sum: number, e: any) => sum + (e.ticketCount || 0), 0),
        month: `${year}-${String(month).padStart(2, '0')}`,
        bancaId: bancaId || null,
        ventanaId: dimension === 'vendedor' ? null : (ventanaId || null),
        vendedorId: vendedorId || null,
      };

      // 2. Fase de Escritura (DENTRO de transacción local corta)
      await prisma.$transaction(async (tx) => {
        let stmt = null;
        if (vendedorId) stmt = await tx.accountStatement.findFirst({ where: { date: dateUTC, vendedorId } });
        else if (ventanaId) stmt = await tx.accountStatement.findFirst({ where: { date: dateUTC, ventanaId, vendedorId: null } });
        else if (bancaId) stmt = await tx.accountStatement.findFirst({ where: { date: dateUTC, bancaId, ventanaId: null, vendedorId: null } });

        if (stmt) {
          await tx.$executeRaw`SELECT 1 FROM "AccountStatement" WHERE id = CAST(${stmt.id} AS uuid) FOR UPDATE`;
          await tx.accountStatement.update({ where: { id: stmt.id }, data: updateData });
        } else {
          try {
            await tx.accountStatement.create({ data: { ...updateData, date: dateUTC } });
          } catch (e: any) {
            if (e.code === 'P2002') {
              const retry = await tx.accountStatement.findFirst({ where: (vendedorId ? { date: dateUTC, vendedorId } : ventanaId ? { date: dateUTC, ventanaId, vendedorId: null } : { date: dateUTC, bancaId, ventanaId: null, vendedorId: null }) });
              if (retry) await tx.accountStatement.update({ where: { id: retry.id }, data: updateData });
            } else throw e;
          }
        }
      }, { timeout: 10000 });
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
    const sorteoDateStrCR = crDateService.dateUTCToCRString(sorteoDate);

    logger.info({
      layer: "service",
      action: "SYNC_SORTEO_STATEMENTS_START",
      payload: { sorteoId, sorteoDate, sorteoDateStrCR }
    });

    try {
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
        return;
      }

      const uniqueVendedores = new Set<string>();
      const uniqueVentanas = new Set<string>();
      const uniqueBancas = new Set<string>();

      for (const ticket of affectedTickets) {
        if (ticket.vendedorId) uniqueVendedores.add(ticket.vendedorId);
        if (ticket.ventanaId) uniqueVentanas.add(ticket.ventanaId);
        if (ticket.ventana?.bancaId) uniqueBancas.add(ticket.ventana.bancaId);
      }

      const [year, month, day] = sorteoDateStrCR.split('-').map(Number);
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      const dateStr = crDateService.postgresDateToCRString(sorteoDateUTC);

      const tasks: (() => Promise<void>)[] = [];
      for (const vendedorId of Array.from(uniqueVendedores)) tasks.push(() => this.syncDayStatementFromBySorteo(dateStr, "vendedor", vendedorId));
      for (const ventanaId of Array.from(uniqueVentanas)) tasks.push(() => this.syncDayStatementFromBySorteo(dateStr, "ventana", ventanaId));
      for (const bancaId of Array.from(uniqueBancas)) tasks.push(() => this.syncDayStatementFromBySorteo(dateStr, "banca", bancaId));

      const syncResults = await ConcurrencyManager.runLimitedSettled(tasks, { limit: 5, label: "SyncSorteoStatements" });
      const syncFailures = syncResults.filter(r => r.status === 'rejected') as PromiseRejectedResult[];

      const todayCR = crDateService.dateUTCToCRString(new Date());
      if (sorteoDateStrCR < todayCR) {
        const propagationTasks: (() => Promise<void>)[] = [];
        for (const vendedorId of Array.from(uniqueVendedores)) propagationTasks.push(() => this.propagateBalanceChange(sorteoDateUTC, "vendedor", vendedorId));
        for (const ventanaId of Array.from(uniqueVentanas)) propagationTasks.push(() => this.propagateBalanceChange(sorteoDateUTC, "ventana", ventanaId));
        for (const bancaId of Array.from(uniqueBancas)) propagationTasks.push(() => this.propagateBalanceChange(sorteoDateUTC, "banca", bancaId));

        await batchedAllSettled(propagationTasks, SYNC_BATCH_SIZE);
      }

      if (syncFailures.length > 0) {
        throw new Error(`Sync parcial: ${syncFailures.length} entidades fallaron.`);
      }

      //  NUEVO: Invalidar el caché DESPUÉS de que la base de datos se actualizó
      const { invalidateCacheForSorteo } = await import('../../../../utils/accountStatementCache');
      await invalidateCacheForSorteo(
        { scheduledAt: sorteoDate },
        affectedTickets
      );

    } catch (error) {
      logger.error({ layer: "service", action: "SYNC_SORTEO_STATEMENTS_ERROR", payload: { sorteoId, sorteoDateStrCR, error: (error as Error).message } });
      throw error;
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
    const startDateStrCR = crDateService.postgresDateToCRString(startDate);
    const endDateStrCR = crDateService.postgresDateToCRString(endDate);

    if ((dimension === "ventana" || dimension === "vendedor") && !entityId) {
      let entities: Array<{ id: string }>;
      if (dimension === "ventana") {
        entities = await prisma.ventana.findMany({ where: { deletedAt: null }, select: { id: true } });
      } else {
        entities = await prisma.user.findMany({ where: { role: "VENDEDOR", deletedAt: null }, select: { id: true } });
      }
      for (const entity of entities) {
        await this.recalculateAccumulatedBalance(startDate, endDate, dimension, entity.id);
      }
      return;
    }

    const daysToProcess: Date[] = [];
    const [startYear, startMonth, startDay] = startDateStrCR.split('-').map(Number);
    const [endYear, endMonth, endDay] = endDateStrCR.split('-').map(Number);

    let currentDate = new Date(Date.UTC(startYear, startMonth - 1, startDay));
    const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay));

    while (currentDate <= endDateObj) {
      daysToProcess.push(new Date(currentDate));
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    for (let i = 0; i < daysToProcess.length; i++) {
      const day = daysToProcess[i];
      const dayStrCR = crDateService.postgresDateToCRString(day);
      try {
        await this._syncDayStatementFromBySorteoInternal(dayStrCR, dimension, entityId!);
      } catch (error) {
        logger.error({ layer: "service", action: "RECALCULATE_ACCUMULATED_BALANCE_DAY_ERROR", payload: { date: dayStrCR, dimension, entityId, error: (error as Error).message } });
      }
    }
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
    entityId?: string
  ): Promise<void> {
    const [year, month, day] = dateStr.split('-').map(Number);
    const dateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    const monthStr = `${year}-${String(month).padStart(2, '0')}`;

    let existingStmt: any = null;
    if (dimension === 'vendedor') {
      existingStmt = await prisma.accountStatement.findFirst({ where: { date: dateUTC, vendedorId: entityId } });
    } else if (dimension === 'ventana') {
      existingStmt = await prisma.accountStatement.findFirst({ where: { date: dateUTC, ventanaId: entityId, vendedorId: null } });
    } else if (dimension === 'banca') {
      existingStmt = await prisma.accountStatement.findFirst({ where: { date: dateUTC, bancaId: entityId, ventanaId: null, vendedorId: null } });
    }

    if (!existingStmt) return;

    let previousDayAccumulated = 0;
    const isFirstDayOfMonth = day === 1;

    if (isFirstDayOfMonth) {
      previousDayAccumulated = Number(await getPreviousMonthFinalBalance(monthStr, dimension, dimension === 'ventana' ? entityId : undefined, dimension === 'vendedor' ? entityId : undefined, dimension === 'banca' ? entityId : undefined)) || 0;
    } else {
      const previousCriteria: any = { date: { lt: dateUTC, gte: new Date(Date.UTC(year, month - 1, 1)) } };
      if (dimension === 'vendedor') previousCriteria.vendedorId = entityId;
      else if (dimension === 'ventana') { previousCriteria.ventanaId = entityId; previousCriteria.vendedorId = null; }
      else if (dimension === 'banca') { previousCriteria.bancaId = entityId; previousCriteria.ventanaId = null; previousCriteria.vendedorId = null; }

      const previousStatement = await prisma.accountStatement.findFirst({
        where: previousCriteria,
        orderBy: { date: 'desc' },
        select: { remainingBalance: true, accumulatedBalance: true },
      });

      if (previousStatement) {
        previousDayAccumulated = Number(previousStatement.remainingBalance) || Number(previousStatement.accumulatedBalance) || 0;
      } else {
        previousDayAccumulated = Number(await getPreviousMonthFinalBalance(monthStr, dimension, dimension === 'ventana' ? entityId : undefined, dimension === 'vendedor' ? entityId : undefined, dimension === 'banca' ? entityId : undefined)) || 0;
      }
    }

    const newRemaining = parseFloat(previousDayAccumulated.toFixed(2));
    if (Math.abs(existingStmt.remainingBalance - newRemaining) > 0.01) {
      await prisma.$transaction(async (localTx) => {
        // Bloqueo explícito para garantizar consistencia en el carry-forward
        await localTx.$executeRaw`SELECT 1 FROM "AccountStatement" WHERE id = CAST(${existingStmt.id} AS uuid) FOR UPDATE`;
        await localTx.accountStatement.update({
          where: { id: existingStmt.id },
          data: { remainingBalance: newRemaining, accumulatedBalance: newRemaining },
        });
      }, { timeout: 10000 });
    }
  }

  /**
   * Propaga un cambio de saldo a los días posteriores del mismo mes
   */
  static async propagateBalanceChange(
    startDate: Date,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
    const queueKey = this.getQueueKey(dimension, entityId);
    return KeyedTaskQueue.enqueue(queueKey, () => 
      this._propagateBalanceChangeInternal(startDate, dimension, entityId)
    );
  }

  /**
   * Lógica interna de propagación (Hilo Único)
   */
  private static async _propagateBalanceChangeInternal(
    startDate: Date,
    dimension: "banca" | "ventana" | "vendedor",
    entityId?: string
  ): Promise<void> {
    const startDateStr = crDateService.postgresDateToCRString(startDate);
      // 1. Fase de Cómputo (FUERA de tx)
      const where: any = { date: { gt: startDate } };
      if (dimension === "vendedor") where.vendedorId = entityId;
      else if (dimension === "ventana") { where.ventanaId = entityId; where.vendedorId = null; }
      else if (dimension === "banca") { where.bancaId = entityId; where.ventanaId = null; where.vendedorId = null; }

      const statementsToUpdate = await prisma.accountStatement.findMany({ 
        where, 
        orderBy: { date: "asc" },
        select: { date: true }
      });

      if (statementsToUpdate.length === 0) return;

      logger.info({
        layer: "service",
        action: "PROPAGATE_BALANCE_CHANGE_STARTED",
        payload: { dimension, entityId, startDateStr, count: statementsToUpdate.length }
      });

      // 2. Procesar cada día en orden cronológico abriendo transacciones cortas por cada día
      for (const stmt of statementsToUpdate) {
        try {
          const stmtDateStr = crDateService.postgresDateToCRString(stmt.date);
          await this._syncDayStatementFromBySorteoInternal(stmtDateStr, dimension, entityId);
        } catch (error) {
          logger.error({ 
            layer: "service", 
            action: "PROPAGATE_BALANCE_CHANGE_DAY_ERROR", 
            payload: { 
              date: crDateService.postgresDateToCRString(stmt.date), 
              dimension, 
              entityId, 
              error: (error as Error).message 
            } 
          });
        }
      }
  }
}

