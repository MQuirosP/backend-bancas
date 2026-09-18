import { SorteoStatus, Role, ActivityType, Prisma } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { EvaluateSorteoDTO } from "../dto/sorteo.dto";
import logger from "../../../core/logger";
import { CacheService } from "../../../core/cache.service";
import ActivityService from "../../../core/activity.service";
import { clearSorteoCache } from "../../../utils/sorteoCache";
import { SocketService } from "../../../core/socket.service";

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
    userId: string
  ): Promise<void> {
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
      const { invalidateCacheForSorteo } = await import("../../../utils/accountStatementCache");
      await invalidateCacheForSorteo({ scheduledAt: existingSorteo.scheduledAt });

      // Actualizar tabla de rollups (ResumenCierreDiario) desacoplada en background con debounce de 25s
      const { CierreRollupService } = await import("./cierre.rollup.service");
      const { tz } = await import("../../../utils/timezone");
      const dateStr = syncOutput?.businessDate || (existingSorteo.scheduledAt ? tz.toDateStr(existingSorteo.scheduledAt) : tz.toDateStr());
      CierreRollupService.scheduleDebouncedAggregate(dateStr, dateStr, 25000);
    } catch (syncErr: any) {
      logger.error({
        layer: "coordinator",
        action: "ACCOUNT_STATEMENT_SYNC_BACKGROUND_ERROR",
        payload: { sorteoId: id, error: syncErr?.message || String(syncErr) },
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
      await CacheService.invalidateTag('sorteos').catch(() => {});
      await CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});
      await CacheService.invalidateTag('dashboard').catch(() => {});
      await CacheService.invalidateTag('cierre').catch(() => {});
      // NOTA: report:summary NO se invalida de forma destructiva global para evitar que la evaluación
      // de un sorteo concurrentemente elimine la caché ya caliente de otro. El warmup la refresca con forceRefresh.
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

    // 5. Pre-calentamiento masivo O(1) de Caché en L1 RAM y Redis L2 (Secuencial con await)
    // Al ejecutarse en ~200ms vía setBatch O(1), esperamos su confirmación para garantizar
    // que el 100% de los datos existan en caché antes de emitir la alerta por WebSocket.
    const warmupStart = Date.now();
    try {
      const activeVendorsCount = await prisma.user.count({
        where: {
          role: Role.VENDEDOR,
          isActive: true,
          ...(existingSorteo.bancaId ? { ventana: { bancaId: existingSorteo.bancaId } } : {}),
        },
      });

      logger.info({
        layer: "coordinator",
        action: "WARMUP_EVALUATED_SUMMARY_START",
        payload: {
          sorteoId: id,
          bancaId: existingSorteo.bancaId,
          totalVendors: activeVendorsCount,
        },
      });

      const { WarmupCoordinator } = await import("./warmup.coordinator");
      const warmupResult = await WarmupCoordinator.executeWarmup(id, existingSorteo.bancaId);

      logger.info({
        layer: "coordinator",
        action: "WARMUP_EVALUATED_SUMMARY_COMPLETED",
        payload: {
          sorteoId: id,
          bancaId: existingSorteo.bancaId,
          totalVendors: warmupResult?.totalVendors ?? activeVendorsCount,
          entriesCached: warmupResult?.entriesCached ?? activeVendorsCount,
          durationMs: Date.now() - warmupStart,
        },
      });
    } catch (warmupErr: any) {
      logger.error({
        layer: "coordinator",
        action: "WARMUP_EVALUATED_SUMMARY_ERROR",
        payload: {
          sorteoId: id,
          error: warmupErr?.message || String(warmupErr),
          durationMs: Date.now() - warmupStart,
        },
      });
    }

    // 6. Notificación en Tiempo Real a Clientes Conectados (WebSocket BROADCAST)
    // Se emite INMEDIATAMENTE DESPUÉS de que el warmup confirma la inyección en L1/L2.
    // Cuando la campana suene en las terminales, el 100% de los datos ya existe en memoria.
    try {
      SocketService.notifySorteoEvaluated({
        sorteoId: id,
        sorteoNombre: existingSorteo?.name || existingSorteo?.nombre || 'Sorteo',
        loteriaNombre: existingSorteo?.loteria?.name || existingSorteo?.loteriaName || undefined,
        winningNumber,
        extraOutcomeCode: (evaluatedSorteo as any)?.extraOutcomeCode || null,
        scheduledAt: existingSorteo?.scheduledAt ? new Date(existingSorteo.scheduledAt).toISOString() : new Date().toISOString(),
        bancaId: existingSorteo?.bancaId || null,
        evaluatedAt: new Date().toISOString(),
      });
    } catch (wsErr: any) {
      logger.warn({
        layer: "coordinator",
        action: "SOCKET_NOTIFY_ERROR",
        payload: { sorteoId: id, error: wsErr?.message || String(wsErr) },
      });
    }
  }
}
