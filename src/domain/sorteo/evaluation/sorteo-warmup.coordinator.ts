import { Prisma, Role, SorteoStatus } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import logger from "../../../core/logger";
import { CacheService, clearL1Memory } from "../../../core/cache.service";
import { getRedisClient } from "../../../core/redisClient";
import { crDateService } from "../../../utils/crDateService";
import { resolveDateRange } from "../../../utils/dateRange";
import { SharedWarmupPool } from "../../../utils/concurrency";
import {
  WARMUP_CHUNK_SIZE,
  WARMUP_CACHE_DISPATCH_SIZE,
  WARMUP_LOCK_TTL_MS,
} from "../warmup.constants";
import { buildSummaryCacheKey } from "../types/sorteo.types";
import { SorteoEvaluatedSummaryService } from "../summary/sorteo-evaluated-summary.service";

export class SorteoWarmupCoordinatorService {
  /**
   * Espera activa no bloqueante a que otra instancia de Render libere el lock de warmup.
   * Evita que la instancia secundaria emita el broadcast de WebSocket antes de que los datos
   * terminen de escribirse en Redis/L1 por la instancia primaria.
   */
  static async waitForWarmupLockRelease(lockKey: string, maxWaitMs = 5000): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const exists = await redis.exists(lockKey);
        if (!exists) return; // Lock liberado por la instancia activa
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }


  /**
   * Precalentamiento atómico O(1) de resúmenes evaluados para todos los vendedores
   * involucrados en un sorteo y su banca.
   * Ejecuta agregaciones en lote en PostgreSQL (<50ms) y puebla simultáneamente L1 (RAM)
   * y L2 (Redis Render) mediante un pipeline atómico, eliminando 234+ queries individuales.
   */
  static async warmupSorteoSummariesBatch(
    sorteoId: string,
    bancaId?: string | null
  ): Promise<{ totalVendors: number; entriesCached: number }> {
    const redis = getRedisClient();
    const bancaKey = bancaId || 'global';
    const lockKey = `lock:warmup:batch:banca:${bancaKey}`;
    let lockAcquired = false;

    if (redis) {
      const MAX_LOCK_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt++) {
        try {
          // 1. Idempotencia y exclusión mutua distribuida POR BANCA con safety TTL (45s)
          // Previene que 2 réplicas procesen concurrentemente sorteos de la misma banca y causen race conditions
          const lockRes = await (redis as any).set(lockKey, "locked", "PX", WARMUP_LOCK_TTL_MS, "NX");
          if (lockRes === "OK") {
            lockAcquired = true;
            break;
          }

          // Si el lock está ocupado por otra réplica activa para esta misma banca:
          logger.info({
            layer: "service",
            action: "WARMUP_BATCH_LOCK_WAITING",
            payload: {
              sorteoId,
              bancaId: bancaKey,
              attempt,
              message: `Lock de warmup para banca ${bancaKey} ocupado por otra réplica. Esperando liberación (intento ${attempt}/${MAX_LOCK_ATTEMPTS})...`,
            },
          });

          // Esperar activamente hasta 5000ms a que la réplica activa termine de escribir en Redis
          await this.waitForWarmupLockRelease(lockKey, 5000);

          // Jitter aleatorio breve (50-150ms) antes de reintentar para amortiguar colisiones
          if (attempt < MAX_LOCK_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
          }
        } catch (lockErr: any) {
          logger.warn({
            layer: "service",
            action: "WARMUP_BATCH_LOCK_WARN",
            payload: { sorteoId, bancaId: bancaKey, error: lockErr?.message },
          });
          break;
        }
      }

      if (!lockAcquired) {
        logger.info({
          layer: "service",
          action: "WARMUP_BATCH_LOCK_COALESCED",
          payload: {
            sorteoId,
            bancaId: bancaKey,
            message: `Warmup para banca ${bancaKey} absorbido por la réplica activa. El estado consolidado ya fue actualizado en Redis.`,
          },
        });
        return { totalVendors: 0, entriesCached: 0 };
      }
    }

    const startTime = Date.now();

    try {
      // ─────────────────────────────────────────────────────────────────────────
      // 🛡️ BLOQUE SQL AISLADO: fallos aquí nunca propagan hacia arriba.
      //    El try/catch exterior (finally) garantiza la liberación del lockKey
      //    independientemente de lo que ocurra dentro de este bloque.
      // ─────────────────────────────────────────────────────────────────────────
      interface FnBatchRow {
        user_id: string;
        summary_only_payload: Record<string, any>;
        full_payload: Record<string, any>;
        initial_accumulated: string | number;
      }

      const todayRange = resolveDateRange("today");

      // Si se evaluaron múltiples sorteos casi al mismo tiempo, obtener el sorteo evaluado
      // más reciente de la banca para garantizar que el warmup consolide el último estado
      let effectiveSorteoId = sorteoId;
      try {
        const latestEvaluated = await prisma.sorteo.findFirst({
          where: {
            status: SorteoStatus.EVALUATED,
            scheduledAt: {
              gte: todayRange.fromAt,
              lte: todayRange.toAt,
            },
            ...(bancaId ? { bancaId } : {}),
          },
          orderBy: { scheduledAt: 'desc' },
          select: { id: true },
        });
        if (latestEvaluated?.id) {
          effectiveSorteoId = latestEvaluated.id;
        }
      } catch {
        // Fallback al sorteoId recibido si falla la búsqueda
      }

      let batchSucceeded = false;
      let batchTotalVendors = 0;
      let batchEntriesCached = 0;

      try {
        const sqlRows = await prisma.$queryRaw<FnBatchRow[]>(
          Prisma.sql`SELECT * FROM fn_get_evaluated_summaries_batch(
            ${effectiveSorteoId}::uuid,
            ${bancaId ?? null}::uuid
          )`
        );

        if (sqlRows.length === 0) {
          logger.info({
            layer: 'service',
            action: 'WARMUP_BATCH_SKIPPED_NO_VENDORS',
            payload: { sorteoId, bancaId },
          });
          batchSucceeded = true;
          // Devuelve 0,0 sin error — flujo normal cuando la banca no tiene vendedores
        } else {
          logger.info({
            layer: 'service',
            action: 'WARMUP_BATCH_START',
            payload: { sorteoId, bancaId, totalVendors: sqlRows.length },
          });

          // Construir vendorResetMap para el post-proceso de balanceResetAt
          const activeVendorsForReset = await prisma.user.findMany({
            where: { id: { in: sqlRows.map((r) => r.user_id as string) } },
            select: { id: true, settings: true },
          });
          const vendorResetMap = new Map<string, Date | null>();
          for (const v of activeVendorsForReset) {
            const resetAt =
              v.settings && (v.settings as Record<string, any>).balanceResetAt
                ? new Date((v.settings as Record<string, any>).balanceResetAt)
                : null;
            vendorResetMap.set(v.id, resetAt);
          }

          // ── Post-procesamiento O(n): accumulated / chronologicalIndex / resetAt ──
          const cacheEntries: Array<{
            key: string;
            value: any;
            ttlSeconds: number;
            tags: string[];
            useL1: boolean;
            l1TtlMs?: number;
          }> = [];

          for (let i = 0; i < sqlRows.length; i++) {
            // Ceder el event loop cooperativamente cada WARMUP_CHUNK_SIZE filas
            if (i > 0 && i % WARMUP_CHUNK_SIZE === 0) {
              await new Promise((resolve) => setImmediate(resolve));
            }

            const row = sqlRows[i];
            const vId = row.user_id as string;
            const initialAccumulated = Number(row.initial_accumulated) || 0;
            const resetAt = vendorResetMap.get(vId) ?? null;

            // ── A. summaryOnly=true ───────────────────────────────────────────
            let summaryPayload = row.summary_only_payload as any;

            if (resetAt && Array.isArray(summaryPayload?.data)) {
              const resetAtDayStr = crDateService.dateUTCToCRString(resetAt);
              const filteredData = summaryPayload.data.filter((d: any) => d.date >= resetAtDayStr);
              summaryPayload = {
                ...summaryPayload,
                data: filteredData,
                meta: { ...summaryPayload.meta, totalDays: filteredData.length },
              };
            }

            const cacheKeyTrue = buildSummaryCacheKey({
              bancaId: 'all',
              ventanaId: 'all',
              vendedorId: vId,
              summaryOnly: true,
              date: 'today',
              scope: 'mine',
              isActive: true,
              ignoreReset: false,
            });

            cacheEntries.push({
              key: cacheKeyTrue,
              value: summaryPayload,
              ttlSeconds: 1200,
              tags: ['report:summary', `vendedor:${vId}`],
              useL1: false, // Solo Redis L2 — slots L1 reservados para hot-path /tickets
            });

            // ── B. summaryOnly=false — running sum + sort ─────────────────────
            let fullPayload = row.full_payload as any;
            const dayData = fullPayload?.data?.[0];

            if (dayData?.sorteos && Array.isArray(dayData.sorteos) && dayData.sorteos.length > 0) {
              const rawEvents: any[] = dayData.sorteos;
              const totalChronological = rawEvents.length;
              let evAccumulated = initialAccumulated;
              let rApplied = false;

              // Pre-calcular timestamps y flags una sola vez por evento para evitar
              // instanciar new Date() repetidamente dentro de los comparadores de sort.
              const decoratedEvents = rawEvents.map((event: any) => {
                let eventTime = new Date(event.scheduledAt).getTime();
                const isMov = typeof event.sorteoId === 'string' && event.sorteoId.startsWith('mov-');

                if (isMov && event.date && event.time && /^\d{1,2}:\d{2}/.test(event.time.trim())) {
                  const [hh, mm] = event.time.trim().split(':').map(Number);
                  if (!isNaN(hh) && !isNaN(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
                    const [y, m, d] = event.date.split('-').map(Number);
                    const utcDate = new Date(Date.UTC(y, m - 1, d, hh + 6, mm, 0, 0));
                    event.scheduledAt = utcDate.toISOString();
                    eventTime = utcDate.getTime();
                  }
                }

                return {
                  event,
                  time: eventTime,
                  isMov,
                };
              });

              // 1. ORDENAR CRONOLÓGICAMENTE ASCENDENTE ANTES DE ACUMULAR
              decoratedEvents.sort((a, b) => {
                if (a.time !== b.time) return a.time - b.time;
                if (a.isMov !== b.isMov) return a.isMov ? -1 : 1;
                const aSorteoId = a.event.sorteoId || '';
                const bSorteoId = b.event.sorteoId || '';
                return aSorteoId.localeCompare(bSorteoId);
              });

              // 2. CALCULAR EL ACUMULADO Y CHRONOLOGICAL INDEX EN ORDEN REAL
              for (let j = 0; j < decoratedEvents.length; j++) {
                const item = decoratedEvents[j];

                if (resetAt && !rApplied && resetAt.getTime() >= todayRange.fromAt.getTime()) {
                  if (item.time >= resetAt.getTime()) {
                    evAccumulated = 0;
                    rApplied = true;
                  }
                }

                evAccumulated += Number(item.event.subtotal) || 0;
                item.event = {
                  ...item.event,
                  accumulated: evAccumulated,
                  chronologicalIndex: j + 1,
                  totalChronological,
                };
              }

              // 3. REORDENAR DESCENDENTE PARA LA VISTA DE LA APK (MÁS RECIENTE ARRIBA)
              decoratedEvents.sort((a, b) => {
                const idxA = a.event.chronologicalIndex || 0;
                const idxB = b.event.chronologicalIndex || 0;
                if (idxA !== idxB) return idxB - idxA;
                if (a.time !== b.time) return b.time - a.time;
                if (a.isMov !== b.isMov) return a.isMov ? 1 : -1;
                return 0;
              });

              dayData.sorteos = decoratedEvents.map((item) => item.event);

              // ── REGLA 4 AGENTS.md: Respetar AccountStatement como autoridad contable ──
              if (decoratedEvents.length > 0) {
                const dbAccumulated = Number(dayData.dayTotals.accumulated) || 0;
                const closingEvent = decoratedEvents.reduce((max, item) =>
                  ((item.event.chronologicalIndex || 0) > (max.event.chronologicalIndex || 0) ? item : max),
                  decoratedEvents[0]
                );

                if (resetAt) {
                  dayData.dayTotals.accumulated = closingEvent.event.accumulated;
                } else if (dbAccumulated !== 0) {
                  dayData.dayTotals.accumulated = dbAccumulated;
                } else {
                  dayData.dayTotals.accumulated = closingEvent.event.accumulated;
                }
              }
              fullPayload = { ...fullPayload, data: [dayData] };
            }

            if (resetAt && Array.isArray(fullPayload?.data)) {
              const resetAtDayStr = crDateService.dateUTCToCRString(resetAt);
              const filteredData = fullPayload.data.filter((d: any) => d.date >= resetAtDayStr);
              fullPayload = {
                ...fullPayload,
                data: filteredData,
                meta: { ...fullPayload.meta, totalDays: filteredData.length },
              };
            }

            const cacheKeyFalse = buildSummaryCacheKey({
              bancaId: 'all',
              ventanaId: 'all',
              vendedorId: vId,
              summaryOnly: false,
              date: 'today',
              scope: 'mine',
              isActive: true,
              ignoreReset: false,
            });

            cacheEntries.push({
              key: cacheKeyFalse,
              value: fullPayload,
              ttlSeconds: 1200,
              tags: ['report:summary', `vendedor:${vId}`],
              useL1: false, // Solo Redis L2 — payloads ~10-15 KB no deben ocupar slots L1
            });
          }

          // Inyección masiva controlada por lotes desde el orquestador: L1 RAM + Pipeline Redis L2
          for (let j = 0; j < cacheEntries.length; j += WARMUP_CACHE_DISPATCH_SIZE) {
            if (j > 0) {
              await new Promise((resolve) => setImmediate(resolve));
            }
            const chunk = cacheEntries.slice(j, j + WARMUP_CACHE_DISPATCH_SIZE);
            await CacheService.setBatch(chunk);
          }

          batchSucceeded = true;
          batchTotalVendors = sqlRows.length;
          batchEntriesCached = cacheEntries.length;

          // Purgar preventivamente cualquier entrada L1 residual en la instancia
          clearL1Memory('WARMUP_BATCH_SUCCESS');

          logger.info({
            layer: 'service',
            action: 'WARMUP_BATCH_COMPLETED',
            payload: {
              sorteoId,
              bancaId,
              totalVendors: batchTotalVendors,
              entriesCached: batchEntriesCached,
              durationMs: Date.now() - startTime,
            },
          });
        }
      } catch (sqlErr: any) {
        // ─────────────────────────────────────────────────────────────────────
        // 🚨 CONTINGENCIA: El SQL batch falló (schema error, timeout, datos corruptos).
        //    Estrategia: Degradación elegante vía invalidación preventiva de caché.
        //    - NO se propaga el error: el broadcast WebSocket continúa sin interrupción.
        //    - Se invalidan las entradas de caché de resumen del día para la banca afectada
        //      para forzar recálculo bajo demanda vía endpoint transaccional.
        //    - Alerta estructurada a observabilidad con severidad ERROR.
        // ─────────────────────────────────────────────────────────────────────
        logger.error({
          layer: 'service',
          action: 'WARMUP_BATCH_SQL_FALLBACK',
          payload: {
            severity: 'ERROR',
            sorteoId,
            bancaId,
            error: sqlErr?.message ?? String(sqlErr),
            code: sqlErr?.code,
            durationMs: Date.now() - startTime,
            hint: 'fn_get_evaluated_summaries_batch falló; las terminales recalcularán bajo demanda.',
          },
        });

        // Invalidación preventiva: eliminar claves de resumen de hoy de la banca afectada.
        // Esto es seguro en 0.5 vCPU porque no ejecuta queries adicionales a la DB —
        // solo emite DEL por tags en Redis (O(1) pipeline). Las terminales regenerarán
        // sus datos al próximo request via el endpoint transaccional regular.
        try {
          // Invalida por tag: O(1) pipeline Redis, sin queries adicionales a DB
          await CacheService.invalidateTag('report:summary');
          if (bancaId) await CacheService.invalidateTag(`banca:${bancaId}`);

          logger.info({
            layer: 'service',
            action: 'WARMUP_BATCH_CACHE_INVALIDATED',
            payload: { sorteoId, bancaId },
          });
        } catch (invalidateErr: any) {
          // La invalidación falló también — log de advertencia, el sistema sigue operativo.
          logger.warn({
            layer: 'service',
            action: 'WARMUP_BATCH_INVALIDATION_WARN',
            payload: {
              sorteoId,
              bancaId,
              error: invalidateErr?.message ?? String(invalidateErr),
            },
          });
        }
      }

      return {
        totalVendors: batchTotalVendors,
        entriesCached: batchEntriesCached,
      };
    } finally {
      // Liberación obligatoria únicamente del candado global del batch
      if (redis && lockAcquired) {
        try {
          await redis.del(lockKey);
        } catch (releaseErr: any) {
          logger.warn({
            layer: "service",
            action: "WARMUP_LOCK_RELEASE_WARN",
            payload: { sorteoId, bancaId: bancaKey, error: releaseErr?.message },
          });
        }
      }
    }
  }


  /**
   * Pre-calienta el caché de evaluated-summary para los vendedores de la banca
   * justo después de que un sorteo se evalúa y liquida contablemente.
   * Ejecuta primero el batch O(1) masivo, con fallback transparente a SharedWarmupPool.
   */
  static async warmupEvaluatedSummaries(
    sorteoId: string,
    bancaId?: string | null
  ): Promise<{ totalVendors: number; entriesCached: number }> {
    try {
      // 1. Camino primario: Batch Aggregation O(1) con Distributed Lock y MSET/Pipeline
      const batchRes = await this.warmupSorteoSummariesBatch(sorteoId, bancaId);
      return batchRes || { totalVendors: 0, entriesCached: 0 };
    } catch (batchErr: any) {
      logger.warn({
        layer: 'service',
        action: 'WARMUP_BATCH_FAILED_FALLBACK_POOL',
        payload: { sorteoId, bancaId, error: batchErr?.message || String(batchErr) },
      });
    }

    // 2. Fallback de seguridad: pool global con límite estricto de concurrencia
    try {
      let vendorIds: string[] = [];

      if (bancaId) {
        const users = await prisma.user.findMany({
          where: {
            role: Role.VENDEDOR,
            isActive: true,
            ventana: { bancaId },
          },
          select: { id: true },
        });
        vendorIds = users.map((u) => u.id);
      } else {
        const users = await prisma.user.findMany({
          where: {
            role: Role.VENDEDOR,
            isActive: true,
          },
          select: { id: true },
        });
        vendorIds = users.map((u) => u.id);
      }

      if (vendorIds.length === 0) {
        const rcdVendors = await prisma.resumenCierreDiario.findMany({
          where: { sorteoId },
          select: { vendedorId: true },
          distinct: ['vendedorId'],
        });
        vendorIds = rcdVendors.map((r) => r.vendedorId);
      }

      if (vendorIds.length === 0) {
        logger.info({
          layer: 'service',
          action: 'WARMUP_SKIPPED_NO_VENDORS',
          payload: { sorteoId, bancaId },
        });
        return { totalVendors: 0, entriesCached: 0 };
      }

      logger.info({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_FALLBACK_START',
        payload: { sorteoId, bancaId, totalVendors: vendorIds.length },
      });

      const startTime = Date.now();

      const warmupTasks = vendorIds.flatMap((vId) => [
        () =>
          SorteoEvaluatedSummaryService.evaluatedSummary(
            {
              date: 'today',
              scope: 'mine',
              status: 'EVALUATED,OPEN',
              isActive: true,
              summaryOnly: false,
              userRole: Role.VENDEDOR,
              ignoreReset: false,
              forceRefresh: true,
            },
            vId
          ),
        () =>
          SorteoEvaluatedSummaryService.evaluatedSummary(
            {
              date: 'today',
              scope: 'mine',
              status: 'EVALUATED,OPEN',
              isActive: true,
              summaryOnly: true,
              userRole: Role.VENDEDOR,
              ignoreReset: false,
              forceRefresh: true,
            },
            vId
          ),
      ]);

      await SharedWarmupPool.runAllSettled(warmupTasks);

      logger.info({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_FALLBACK_COMPLETED',
        payload: {
          sorteoId,
          bancaId,
          totalVendors: vendorIds.length,
          entriesCached: warmupTasks.length,
          durationMs: Date.now() - startTime,
        },
      });

      return { totalVendors: vendorIds.length, entriesCached: warmupTasks.length };
    } catch (err: any) {
      logger.warn({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_ERROR',
        payload: { sorteoId, bancaId, error: err?.message || String(err) },
      });
      return { totalVendors: 0, entriesCached: 0 };
    }
  }
}
