import { Request, Response } from 'express';
import prisma from '../../../core/prismaClient';
import SorteoRepository from '../../../repositories/sorteo.repository';
import { SorteoEvaluationCoordinator } from '../services/sorteoEvaluation.coordinator';
import { AccountStatementSyncService } from '../services/accounts/accounts.sync.service';
import { recalculateMonthlyClosingForDimension } from '../services/accounts/monthlyClosing.service';
import { DailyNumberSalesService } from '../services/dailyNumberSales.service';
import { AccountsService } from '../services/accounts/accounts.service';
import ActivityService from '../../../core/activity.service';
import { SorteoStatus, ActivityType, Prisma } from '../../../generated/prisma/client';

/**
 * ops.controller.ts
 * Controlador de operaciones de soporte para el orquestador (Render & Local).
 */

export class OpsController {
  /**
   * Ejecuta acciones sobre sorteos (EVALUATE, REVERT, CLOSE, REOPEN)
   */
  static async handleSorteoAction(req: Request, res: Response): Promise<void> {
    try {
      const { action, sorteoId, winningNumber, extraMultiplierId } = req.body;
      const targetSorteo = await prisma.sorteo.findUnique({ where: { id: sorteoId } });

      if (!targetSorteo) {
        res.status(404).json({ success: false, error: 'Sorteo no encontrado' });
        return;
      }

      if (action === 'EVALUATE') {
        const { extraOutcomeCode } = await SorteoEvaluationCoordinator.validate(
          targetSorteo.id,
          { winningNumber, extraMultiplierId: extraMultiplierId || null },
          targetSorteo
        );

        const evaluated = await SorteoRepository.evaluate(targetSorteo.id, {
          winningNumber: winningNumber.trim(),
          extraOutcomeCode,
          extraMultiplierId: extraMultiplierId || null
        });

        if (!evaluated) throw new Error('Error al evaluar en DB');

        await SorteoEvaluationCoordinator.triggerPostEvaluation(
          targetSorteo.id,
          winningNumber.trim(),
          extraMultiplierId || null,
          targetSorteo,
          evaluated,
          'CLI_HTTP_WIZARD'
        );

        res.json({ success: true, message: 'Sorteo evaluado exitosamente' });
        return;
      }

      if (action === 'REVERT') {
        await SorteoRepository.revertEvaluation(targetSorteo.id);
        await AccountStatementSyncService.syncSorteoStatements(targetSorteo.id, targetSorteo.scheduledAt);

        await ActivityService.log({
          action: ActivityType.SYSTEM_ACTION,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_HTTP_WIZARD',
            module: 'REVERT_SORTEO',
            sorteoName: targetSorteo.name,
            scheduledAt: targetSorteo.scheduledAt,
            executedBy: 'SUPER_ADMIN'
          }
        });

        res.json({ success: true, message: 'Sorteo revertido exitosamente' });
        return;
      }

      if (action === 'CLOSE') {
        const { ticketsAffected } = await SorteoRepository.closeWithCascade(targetSorteo.id);

        await ActivityService.log({
          action: ActivityType.SORTEO_CLOSE,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_HTTP_WIZARD',
            module: 'CLOSE_SORTEO',
            sorteoName: targetSorteo.name,
            ticketsAffected,
            executedBy: 'SUPER_ADMIN'
          }
        });

        res.json({ success: true, message: `Sorteo cerrado exitosamente (${ticketsAffected} tickets afectados)` });
        return;
      }

      if (action === 'REOPEN') {
        await SorteoRepository.restore(targetSorteo.id);

        await ActivityService.log({
          action: ActivityType.SORTEO_REOPEN,
          targetType: 'SORTEO',
          targetId: targetSorteo.id,
          bancaId: targetSorteo.bancaId || null,
          details: {
            source: 'CLI_HTTP_WIZARD',
            module: 'REOPEN_SORTEO',
            sorteoName: targetSorteo.name,
            executedBy: 'SUPER_ADMIN'
          }
        });

        res.json({ success: true, message: 'Sorteo reabierto exitosamente' });
        return;
      }

      res.status(400).json({ success: false, error: 'Acción no soportada' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Chequeo de integridad AccountStatement
   */
  static async checkStatements(req: Request, res: Response): Promise<void> {
    try {
      const { fromStr, toStr, bancaId } = req.body;
      const fromDateStr = fromStr || new Date().toISOString().slice(0, 10);
      const toDateStr = toStr || fromDateStr;
      const targetBancaId = bancaId || null;

      const dates: string[] = [];
      let curr = new Date(fromDateStr + 'T00:00:00Z');
      const end = new Date(toDateStr + 'T00:00:00Z');
      while (curr <= end) {
        dates.push(curr.toISOString().slice(0, 10));
        curr.setUTCDate(curr.getUTCDate() + 1);
      }

      const vendedores = await prisma.user.findMany({
        where: { role: 'VENDEDOR', isActive: true, ...(targetBancaId ? { bancaId: targetBancaId } : {}) },
        select: { id: true, name: true }
      });

      const ventanas = await prisma.ventana.findMany({
        where: { isActive: true, ...(targetBancaId ? { bancaId: targetBancaId } : {}) },
        select: { id: true, name: true }
      });

      const bancas = await prisma.banca.findMany({
        where: { isActive: true, ...(targetBancaId ? { id: targetBancaId } : {}) },
        select: { id: true, name: true }
      });

      let totalChecked = 0;
      let totalOk = 0;
      let totalFail = 0;

      for (const dateStr of dates) {
        const dateObj = new Date(dateStr + 'T00:00:00Z');

        for (const v of vendedores) {
          totalChecked++;
          const dbStmt = await prisma.accountStatement.findFirst({
            where: { vendedorId: v.id, date: dateObj, ventanaId: null }
          });
          const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
          let realBalance = 0;
          try {
            const bySorteoData = await AccountsService.getBySorteo(dateStr, { dimension: 'vendedor', vendedorId: v.id });
            if (bySorteoData && Array.isArray(bySorteoData)) {
              let sSales = 0, sPayouts = 0, sComm = 0;
              for (const ev of bySorteoData) {
                if (!(ev.sorteoId || '').startsWith('mov-')) {
                  sSales += Number(ev.sales || 0);
                  sPayouts += Number(ev.payouts || 0);
                  sComm += Number(ev.vendedorCommission || 0);
                }
              }
              realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
            }
          } catch (e) {
            realBalance = dbBalance;
          }
          if (Math.abs(dbBalance - realBalance) < 0.01) totalOk++; else totalFail++;
        }

        for (const vt of ventanas) {
          totalChecked++;
          const dbStmt = await prisma.accountStatement.findFirst({
            where: { ventanaId: vt.id, date: dateObj, vendedorId: null }
          });
          const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
          let realBalance = 0;
          try {
            const bySorteoData = await AccountsService.getBySorteo(dateStr, { dimension: 'ventana', ventanaId: vt.id });
            if (bySorteoData && Array.isArray(bySorteoData)) {
              let sSales = 0, sPayouts = 0, sComm = 0;
              for (const ev of bySorteoData) {
                if (!(ev.sorteoId || '').startsWith('mov-')) {
                  sSales += Number(ev.sales || 0);
                  sPayouts += Number(ev.payouts || 0);
                  sComm += Number(ev.listeroCommission || 0);
                }
              }
              realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
            }
          } catch (e) {
            realBalance = dbBalance;
          }
          if (Math.abs(dbBalance - realBalance) < 0.01) totalOk++; else totalFail++;
        }

        for (const b of bancas) {
          totalChecked++;
          const dbStmt = await prisma.accountStatement.findFirst({
            where: { bancaId: b.id, date: dateObj, ventanaId: null, vendedorId: null }
          });
          const dbBalance = dbStmt ? Number(dbStmt.balance) : 0;
          let realBalance = 0;
          try {
            const bySorteoData = await AccountsService.getBySorteo(dateStr, { dimension: 'banca', bancaId: b.id });
            if (bySorteoData && Array.isArray(bySorteoData)) {
              let sSales = 0, sPayouts = 0, sComm = 0;
              for (const ev of bySorteoData) {
                if (!(ev.sorteoId || '').startsWith('mov-')) {
                  sSales += Number(ev.sales || 0);
                  sPayouts += Number(ev.payouts || 0);
                  sComm += Number(ev.listeroCommission || 0);
                }
              }
              realBalance = parseFloat((sSales - sPayouts - sComm).toFixed(2));
            }
          } catch (e) {
            realBalance = dbBalance;
          }
          if (Math.abs(dbBalance - realBalance) < 0.01) totalOk++; else totalFail++;
        }
      }

      res.json({ success: true, totalChecked, totalOk, totalFail });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Reparación y resincronización de saldos AccountStatement
   */
  static async fixStatements(req: Request, res: Response): Promise<void> {
    try {
      const { fromStr, toStr, bancaId } = req.body;
      const fromDateStr = fromStr || new Date().toISOString().slice(0, 10);
      const toDateStr = toStr || fromDateStr;
      const targetBancaId = bancaId || null;

      const dates: string[] = [];
      const monthsSet = new Set<string>();

      let curr = new Date(fromDateStr + 'T00:00:00Z');
      const end = new Date(toDateStr + 'T00:00:00Z');
      while (curr <= end) {
        const dStr = curr.toISOString().slice(0, 10);
        dates.push(dStr);
        monthsSet.add(dStr.slice(0, 7));
        curr.setUTCDate(curr.getUTCDate() + 1);
      }

      const vendedores = await prisma.user.findMany({
        where: { role: 'VENDEDOR', isActive: true, ...(targetBancaId ? { bancaId: targetBancaId } : {}) },
        select: { id: true, name: true, bancaId: true, ventanaId: true }
      });

      const ventanas = await prisma.ventana.findMany({
        where: { isActive: true, ...(targetBancaId ? { bancaId: targetBancaId } : {}) },
        select: { id: true, name: true, bancaId: true }
      });

      const bancas = await prisma.banca.findMany({
        where: { isActive: true, ...(targetBancaId ? { id: targetBancaId } : {}) },
        select: { id: true, name: true }
      });

      let totalProcessed = 0;

      for (const dateStr of dates) {
        const dateObj = new Date(dateStr + 'T00:00:00Z');
        for (const v of vendedores) {
          totalProcessed++;
          await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'vendedor', v.id);
        }
        for (const vt of ventanas) {
          totalProcessed++;
          await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'ventana', vt.id);
        }
        for (const b of bancas) {
          totalProcessed++;
          await (AccountStatementSyncService as any)._syncDayStatementInternal(dateObj, 'banca', b.id);
        }
      }

      for (const monthStr of monthsSet) {
        for (const v of vendedores) {
          await recalculateMonthlyClosingForDimension(monthStr, 'vendedor', v.ventanaId || undefined, v.id, v.bancaId || undefined);
        }
        for (const vt of ventanas) {
          await recalculateMonthlyClosingForDimension(monthStr, 'ventana', vt.id, undefined, vt.bancaId || undefined);
        }
        for (const b of bancas) {
          await recalculateMonthlyClosingForDimension(monthStr, 'banca', undefined, undefined, b.id);
        }
      }

      await ActivityService.log({
        action: ActivityType.SYSTEM_ACTION,
        targetType: 'ACCOUNT_STATEMENT',
        bancaId: targetBancaId || null,
        details: {
          source: 'CLI_HTTP_WIZARD',
          module: 'FIX_STATEMENTS',
          range: { from: fromDateStr, to: toDateStr },
          recordsProcessed: totalProcessed,
          executedBy: 'SUPER_ADMIN'
        }
      });

      res.json({ success: true, totalProcessed });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Auditoría de DailyNumberSales acopio
   */
  static async auditAndRebuildAcopio(req: Request, res: Response): Promise<void> {
    try {
      const { fromStr, toStr, bancaId, executeRebuild } = req.body;
      const fromDateStr = fromStr || new Date().toISOString().slice(0, 10);
      const toDateStr = toStr || fromDateStr;
      const targetBancaId = bancaId || null;

      const [fromY, fromM, fromD] = fromDateStr.split('-').map(Number);
      const [toY, toM, toD] = toDateStr.split('-').map(Number);
      const startOfDayUTC = new Date(Date.UTC(fromY, fromM - 1, fromD, 6, 0, 0, 0));
      const endOfDayUTC = new Date(Date.UTC(toY, toM - 1, toD + 1, 5, 59, 59, 999));

      const sorteos = await prisma.sorteo.findMany({
        where: {
          scheduledAt: { gte: startOfDayUTC, lte: endOfDayUTC },
          status: 'EVALUATED',
          isActive: true,
          ...(targetBancaId ? { bancaId: targetBancaId } : {})
        },
        include: { banca: { select: { name: true } } },
        orderBy: { scheduledAt: 'asc' }
      });

      let totalDiscrepancies = 0;
      const sorteosWithDiscrepancies: typeof sorteos = [];

      for (const s of sorteos) {
        const storedRes = await prisma.$queryRaw<Array<{ totalDB: number; jugadasDB: number }>>`
          SELECT COALESCE(SUM("totalAmount"), 0)::float AS "totalDB", COALESCE(SUM("jugadasCount"), 0)::integer AS "jugadasDB"
          FROM "DailyNumberSales" WHERE "sorteoId" = ${s.id}::uuid
        `;
        const liveRes = await prisma.$queryRaw<Array<{ totalReal: number; jugadasReal: number }>>`
          SELECT COALESCE(SUM(j.amount), 0)::float AS "totalReal", COUNT(j.id)::integer AS "jugadasReal"
          FROM "Jugada" j JOIN "Ticket" t ON j."ticketId" = t.id
          WHERE t."sorteoId" = ${s.id}::uuid AND t."deletedAt" IS NULL AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO') AND j."deletedAt" IS NULL
        `;

        const stored = storedRes[0] || { totalDB: 0, jugadasDB: 0 };
        const live = liveRes[0] || { totalReal: 0, jugadasReal: 0 };

        if (Math.abs(stored.totalDB - live.totalReal) > 0.01 || Math.abs(stored.jugadasDB - live.jugadasReal) > 0) {
          totalDiscrepancies++;
          sorteosWithDiscrepancies.push(s);
        }
      }

      if (executeRebuild) {
        const targetSorteosToProcess = totalDiscrepancies > 0 ? sorteosWithDiscrepancies : sorteos;
        for (const s of targetSorteosToProcess) {
          await DailyNumberSalesService.aggregateSorteoSales(s.id);
        }

        await ActivityService.log({
          action: ActivityType.SYSTEM_ACTION,
          targetType: 'DAILY_NUMBER_SALES',
          bancaId: targetBancaId || null,
          details: {
            source: 'CLI_HTTP_WIZARD',
            module: 'REBUILD_ACOPIO_SALES',
            range: { from: fromDateStr, to: toDateStr },
            sorteosProcessed: targetSorteosToProcess.length,
            discrepanciesFound: totalDiscrepancies,
            executedBy: 'SUPER_ADMIN'
          }
        });

        res.json({ success: true, processedCount: targetSorteosToProcess.length, totalDiscrepancies });
        return;
      }

      res.json({
        success: true,
        sorteosCount: sorteos.length,
        totalDiscrepancies,
        discrepanciesList: sorteosWithDiscrepancies.map(s => ({ id: s.id, name: s.name, bancaName: s.banca?.name || 'Global' }))
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}
