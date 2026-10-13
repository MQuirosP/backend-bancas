// AHORA
import { SorteoStatus, Role, ActivityType, Prisma } from "../../generated/prisma/client";
import prisma from "../../core/prismaClient";
import { AppError } from "../../core/errors";
import SorteoRepository from "../../repositories/sorteo.repository";
import { EvaluateSorteoDTO } from "../../api/v1/dto/sorteo.dto";
import logger from "../../core/logger";
import { CacheService } from "../../core/cache.service";
import ActivityService from "../../core/activity.service";
import { clearSorteoCache } from "../../utils/sorteoCache";
import { SocketService } from "../../core/socket.service";
import { runAsGlobalJob } from "../../core/tenantContext";

const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

export class SorteoEvaluationCoordinator {
  /**
   * Valida las reglas de negocio previas a la evaluación
   */
  static async validate(
    id: string,
    body: EvaluateSorteoDTO,
    existingSorteo: any,
    bancaId?: string,
    role?: Role
  ) {
    const { winningNumber, extraMultiplierId = null } = body;

    if (!winningNumber?.length) {
      throw new AppError("winningNumber es requerido", 400);
    }

    if (bancaId && !existingSorteo.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para evaluar un sorteo global", 403);
    }

    if (!EVALUABLE_STATES.has(existingSorteo.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409);
    }

    const requiredDigits = existingSorteo.digits ?? 2;
    if (winningNumber.length !== requiredDigits) {
      throw new AppError(
        `El número ganador debe tener ${requiredDigits} dígitos (recibido: ${winningNumber.length})`,
        400
      );
    }

    let extraX = 0;
    let extraOutcomeCode: string | null = null;

    if (extraMultiplierId) {
      const mul = await prisma.loteriaMultiplier.findUnique({
        where: { id: extraMultiplierId },
        select: {
          id: true,
          valueX: true,
          isActive: true,
          loteriaId: true,
          kind: true,
          name: true,
          appliesToSorteoId: true,
        },
      });

      if (!mul || !mul.isActive) {
        throw new AppError("extraMultiplierId inválido o inactivo", 400);
      }
      if (mul.loteriaId !== existingSorteo.loteriaId) {
        throw new AppError("extraMultiplierId no pertenece a la lotería del sorteo", 400);
      }
      if (mul.kind !== "REVENTADO") {
        throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
      }
      if (mul.appliesToSorteoId && mul.appliesToSorteoId !== id) {
        throw new AppError("extraMultiplierId no aplica a este sorteo", 400);
      }

      extraX = mul.valueX;
      extraOutcomeCode = (body.extraOutcomeCode ?? mul.name ?? null) || null;
    }

    return { extraX, extraOutcomeCode };
  }

  /**
   * Ejecuta los efectos secundarios post-evaluación en background (asíncronos)
   * de forma secuencial para garantizar consistencia contable antes de notificar a los clientes.
   */
  static async triggerPostEvaluation(
    id: string,
    winningNumber: string,
    extraMultiplierId: string | null | undefined,
    existingSorteo: any,
    evaluatedSorteo: any,
    userId: string,
    bancaId?: string,
  ): Promise<void> {
    return runAsGlobalJob(async () => {
      // Cascada de resolución: priorizar bancaId explícito, luego del registro evaluado, luego del existente
      const targetBancaId =
        bancaId ||
        evaluatedSorteo?.bancaId ||
        existingSorteo?.bancaId ||
        null;
    // 1. Sincronización de Cuentas (Nativo en PostgreSQL vía fn_sync_sorteo_statements)
    try {
      logger.info({
        layer: "coordinator",
        action: "SORTEO_EVALUATE_TRIGGERING_SYNC",
        payload: { sorteoId: id, scheduledAt: existingSorteo.scheduledAt },
      });

      const syncStart = Date.now();
      const syncResultRaw = await prisma.$queryRawUnsafe<Array<{ fn_sync_sorteo_statements: any }>>(
        `SELECT fn_sync_sorteo_statements($1::uuid, false)`,
        id
      );

      const syncOutput = syncResultRaw?.[0]?.fn_sync_sorteo_statements;
      const syncDuration = Date.now() - syncStart;

      // Reconciliar saldos y desmarcar sorteo de evaluación en el módulo de crédito INMEDIATAMENTE
      // tras el commit contable de fn_sync_sorteo_statements y ANTES de fn_sync_sorteo_multipliers_summary
      try {
        const { VendorCreditService } = await import("../credit/vendorCredit.service");
        await VendorCreditService.reconcileSorteo(id);
      } catch (creditErr: any) {
        logger.error({
          layer: "coordinator",
          action: "RECONCILE_CREDIT_ERROR",
          payload: { sorteoId: id, error: creditErr?.message || String(creditErr) },
        });
      }

      // --- SINCRONIZACIÓN DE RESUMEN POR MULTIPLICADORES (O(1) para Warmup y Balances) ---
      await prisma.$queryRawUnsafe(
        `SELECT fn_sync_sorteo_multipliers_summary($1::uuid)`,
        id
      );
      // -----------------------------------------------------------------------------------

      logger.info({
        layer: "coordinator",
        action: "SORTEO_EVALUATE_SYNC_COMPLETED",
        payload: {
          sorteoId: id,
          durationMs: syncDuration,
          dbExecutionMs: syncOutput?.executionTimeMs,
          vendedores: syncOutput?.counts?.vendedores,
          ventanas: syncOutput?.counts?.ventanas,
          bancas: syncOutput?.counts?.bancas,
          totalEntities: syncOutput?.counts?.total,
        },
      });

      // Invalidar caché de statements del día
      const { invalidateCacheForSorteo } = await import("../../utils/accountStatementCache");
      await invalidateCacheForSorteo({ scheduledAt: existingSorteo.scheduledAt });

      // Actualizar tabla de rollups (ResumenCierreDiario) de forma SÍNCRONA Y DETERMINISTA
      // PRERREQUISITO CRÍTICO: fn_get_evaluated_summaries_batch (L1/L2 Warmup) depende directamente de
      // ResumenCierreDiario para construir day_sorteos, total_sorteos y month_rcd (Saldo a Hoy).
      const { CierreRollupService } = await import("../cierre/cierre.rollup.service");
      const { tz } = await import("../../utils/timezone");
      const dateStr = syncOutput?.businessDate || (existingSorteo.scheduledAt ? tz.toDateStr(existingSorteo.scheduledAt) : tz.toDateStr());
      const todayCR = tz.toDateStr();
      const isHistorical = dateStr < todayCR;

      // Si el sorteo evaluado es de una fecha anterior, agregar rollups hasta hoy inclusive
      await CierreRollupService.aggregateRange(dateStr, isHistorical ? todayCR : dateStr);

      // Si es un sorteo histórico (ej. revertido y re-evaluado), propagar cambios de balance
      // a AccountStatement para todos los días posteriores hasta hoy.
      if (isHistorical) {
        logger.info({
          layer: "coordinator",
          action: "SORTEO_HISTORICAL_EVALUATE_PROPAGATION_START",
          payload: { sorteoId: id, dateStr, todayCR },
        });

        const { AccountStatementSyncService } = await import("../accounts/accounts.sync.service");
        const [year, month, day] = dateStr.split('-').map(Number);
        const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

        const uniqueVendedores = new Set<string>();
        const uniqueVentanas = new Set<string>();
        const uniqueBancas = new Set<string>();

        if (Array.isArray(syncOutput?.statements)) {
          for (const s of syncOutput.statements) {
            if (s.dimension === "vendedor" && s.entityId) uniqueVendedores.add(s.entityId);
            if (s.dimension === "ventana" && s.entityId) uniqueVentanas.add(s.entityId);
            if (s.dimension === "banca" && s.entityId) uniqueBancas.add(s.entityId);
          }
        }

        if (uniqueVendedores.size === 0 && uniqueVentanas.size === 0 && uniqueBancas.size === 0) {
          const tickets = await prisma.ticket.findMany({
            where: { sorteoId: id, status: { not: "CANCELLED" }, isActive: true, deletedAt: null },
            select: { vendedorId: true, ventanaId: true, ventana: { select: { bancaId: true } } },
          });
          for (const t of tickets) {
            if (t.vendedorId) uniqueVendedores.add(t.vendedorId);
            if (t.ventanaId) uniqueVentanas.add(t.ventanaId);
            if (t.ventana?.bancaId) uniqueBancas.add(t.ventana.bancaId);
          }
        }

        for (const vendedorId of uniqueVendedores) {
          await AccountStatementSyncService.propagateBalanceChange(sorteoDateUTC, "vendedor", vendedorId);
        }
        for (const ventanaId of uniqueVentanas) {
          await AccountStatementSyncService.propagateBalanceChange(sorteoDateUTC, "ventana", ventanaId);
        }
        for (const bancaId of uniqueBancas) {
          await AccountStatementSyncService.propagateBalanceChange(sorteoDateUTC, "banca", bancaId);
        }

        // Reconciliar saldos base de crédito en Redis con el nuevo balance de hoy ya propagado
        try {
          const { VendorCreditService } = await import("../credit/vendorCredit.service");
          for (const vendedorId of uniqueVendedores) {
            await VendorCreditService.updateBaseBalance(vendedorId).catch(() => {});
          }
        } catch (_) {}

        // Invalidar caché de statements para hoy también en Redis
        const { invalidateAccountStatementCache } = await import("../../utils/accountStatementCache");
        await invalidateAccountStatementCache({ date: todayCR });

        logger.info({
          layer: "coordinator",
          action: "SORTEO_HISTORICAL_EVALUATE_PROPAGATION_COMPLETED",
          payload: {
            sorteoId: id,
            dateStr,
            todayCR,
            vendedoresCount: uniqueVendedores.size,
            ventanasCount: uniqueVentanas.size,
            bancasCount: uniqueBancas.size,
          },
        });
      }
    } catch (syncErr: any) {
      // NOTA CRÍTICA: NO limpiar el marcador sorteos:evaluating si el sync contable falla.
      // Como el sorteo ya quedó en estado EVALUATED en PostgreSQL, si se eliminara el marcador
      // sus ventas desaparecerían del saldo efectivo (subconteo riesgoso).
      // Se conserva en el ZSET hasta que un sync posterior termine bien (reconcileSorteo) o expire su TTL.
      logger.error({
        layer: "coordinator",
        action: "ACCOUNT_STATEMENT_SYNC_BACKGROUND_ERROR",
        payload: {
          sorteoId: id,
          error: syncErr?.message || String(syncErr),
          creditMarkerRetained: true,
          note: "Marcador sorteos:evaluating retenido en Redis para evitar subconteo hasta reconciliación exitosa o expiración de TTL",
        },
      });
    }

    // 2. Agregar ventas por número para reporte histórico
    try {
      const { DailyNumberSalesService } = await import("./dailyNumberSales.service");
      await DailyNumberSalesService.aggregateSorteoSales(id);
    } catch (salesErr: any) {
      logger.error({
        layer: "coordinator",
        action: "DAILY_NUMBER_SALES_AGGREGATION_BACKGROUND_ERROR",
        payload: { sorteoId: id, error: salesErr?.message || String(salesErr) },
      });
    }

    // 3. Limpieza de Caché (Memoria y Redis)
    try {
      clearSorteoCache();
      await CacheService.invalidateTag('sorteos').catch(() => { });
      await CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
      await CacheService.invalidateTag('dashboard').catch(() => { });
      await CacheService.invalidateTag('cierre').catch(() => { });
      await CacheService.invalidateTag('report:summary').catch(() => { });
      // NOTA ARQUITECTÓNICA: report:summary NO se invalida por tags.
      // El WarmupCoordinator sobrescribe directamente las claves en L1/L2 mediante SET atómico
      // tras actualizar ResumenSorteoMultiplicador. Esto evita cache stampedes y permite
      // que evaluaciones consecutivas en ráfaga actualicen los balances sin vaciar la caché.
    } catch (cacheErr: any) {
      logger.error({
        layer: "coordinator",
        action: "CACHE_INVALIDATION_ERROR",
        payload: { sorteoId: id, error: cacheErr?.message || String(cacheErr) },
      });
    }

    // 4. Registro de Actividad
    try {
      await ActivityService.log({
        userId,
        bancaId: existingSorteo.bancaId,
        action: ActivityType.SORTEO_EVALUATE,
        targetType: "SORTEO",
        targetId: id,
        details: {
          winningNumber,
          extraMultiplierId,
          hasWinner: (evaluatedSorteo as any)?.hasWinner,
        } as Prisma.InputJsonObject,
      });
    } catch (actErr: any) {
      logger.error({
        layer: "coordinator",
        action: "ACTIVITY_LOG_ERROR",
        payload: { sorteoId: id, error: actErr?.message || String(actErr) },
      });
    }

    // 5. Despachar Warmup coalescido + WebSocket Broadcast en Background (Fire-and-Forget controlado)
    // El ciclo contable y transaccional concluyó con éxito. Despachamos el warmup L1/L2 para que prepare la caché
    // y emita los eventos de socket una vez caliente, sin suspender el response HTTP 200 de la evaluación.
    const socketBroadcastPayload = {
      sorteoId: id,
      sorteoNombre: existingSorteo?.name || existingSorteo?.nombre || 'Sorteo',
      loteriaNombre: existingSorteo?.loteria?.name || existingSorteo?.loteriaName || undefined,
      winningNumber,
      extraOutcomeCode: (evaluatedSorteo as any)?.extraOutcomeCode || null,
      scheduledAt: existingSorteo?.scheduledAt ? new Date(existingSorteo.scheduledAt).toISOString() : new Date().toISOString(),
      bancaId: targetBancaId,
      evaluatedAt: new Date().toISOString(),
    };

    import("./warmup.coordinator")
      .then(({ WarmupCoordinator }) => {
        WarmupCoordinator.scheduleWarmupAndBroadcast(id, targetBancaId, socketBroadcastPayload);
      })
      .catch((err) => {
        logger.error({
          layer: "coordinator",
          action: "WARMUP_DISPATCH_BACKGROUND_ERROR",
          payload: { sorteoId: id, error: err?.message || String(err) },
        });
      });
    });
  }
}
