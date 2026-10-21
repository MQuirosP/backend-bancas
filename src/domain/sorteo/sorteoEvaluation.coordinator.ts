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
import { SocketService, SorteoEvaluatedPayload } from "../../core/socket.service";
import { runAsGlobalJob } from "../../core/tenantContext";

const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

export class SorteoEvaluationCoordinator {
  /**
   * Emite el WebSocket broadcast de sorteo evaluado de forma inmediata a la sala de la banca (< 200 ms).
   */
  public static emitImmediateBroadcast(
    sorteoId: string,
    bancaId: string,
    existingSorteo: any,
    evaluatedSorteo: any,
    winningNumber: string
  ): void {
    const payload: SorteoEvaluatedPayload = {
      sorteoId,
      sorteoNombre: existingSorteo?.name || existingSorteo?.nombre || 'Sorteo',
      loteriaNombre: existingSorteo?.loteria?.name || existingSorteo?.loteriaName || undefined,
      winningNumber,
      extraOutcomeCode: (evaluatedSorteo as any)?.extraOutcomeCode || null,
      scheduledAt: existingSorteo?.scheduledAt ? new Date(existingSorteo.scheduledAt).toISOString() : new Date().toISOString(),
      bancaId,
      evaluatedAt: new Date().toISOString(),
    };

    try {
      SocketService.notifySorteoEvaluated(payload);
      SocketService.notifyDashboardUpdated({ bancaId });
    } catch (wsErr: any) {
      logger.error({
        layer: "coordinator",
        action: "SORTEO_EVALUATED_BROADCAST_ERROR",
        payload: { sorteoId, bancaId, error: wsErr?.message || String(wsErr) },
      });
    }
  }

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

      const affectedBancas = new Set<string>();
      const affectedVendedores = new Set<string>();
      let syncOutput: any = null;

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

        syncOutput = syncResultRaw?.[0]?.fn_sync_sorteo_statements;
        const syncDuration = Date.now() - syncStart;

        if (Array.isArray(syncOutput?.statements)) {
          for (const s of syncOutput.statements) {
            if (s.dimension === "banca" && s.entityId) {
              affectedBancas.add(s.entityId);
            } else if (s.dimension === "vendedor" && s.entityId) {
              affectedVendedores.add(s.entityId);
            }
          }
        }

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

        // --- ACTUALIZACIÓN DE ROLLUPS (ResumenCierreDiario) PARA EL DÍA DEL SORTEO ---
        // Vital antes de WarmupCoordinator.executeWarmup: fn_get_evaluated_summaries_batch
        // depende de ResumenCierreDiario para incluir el nuevo sorteo evaluado y sus totales.
        try {
          const { CierreRollupService } = await import("../cierre/cierre.rollup.service");
          const { tz } = await import("../../utils/timezone");
          const dateStr =
            syncOutput?.businessDate ||
            (existingSorteo.scheduledAt ? tz.toDateStr(existingSorteo.scheduledAt) : tz.toDateStr());
          await CierreRollupService.aggregateRange(dateStr, dateStr);
        } catch (rollupErr: any) {
          logger.error({
            layer: "coordinator",
            action: "ROLLUP_EVALUATION_DAY_ERROR",
            payload: { sorteoId: id, error: rollupErr?.message || String(rollupErr) },
          });
        }
        // -----------------------------------------------------------------------------

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

      // Cascada de bancas a notificar (soporte multi-banca o mono-banca)
      const targetBancas: (string | null)[] = [];
      if (targetBancaId) {
        targetBancas.push(targetBancaId);
      } else if (affectedBancas.size > 0) {
        targetBancas.push(...Array.from(affectedBancas));
      } else {
        targetBancas.push(null);
      }

      // =========================================================================
      // ⚡ 1. PRECALENTAMIENTO DE RESÚMENES (WARMUP BEFORE BROADCAST)
      // Se precalientan los resúmenes evaluados en Redis ANTES de emitir el broadcast
      // para garantizar que cuando las terminales consulten caigan en Cache Hit (< 15ms).
      // Timeout defensivo de 2,500ms para garantizar que el broadcast jamás quede retenido.
      // =========================================================================
      // ⚠️ ADVERTENCIA ARQUITECTÓNICA DE RENDIMIENTO (NO MODIFICAR):
      // Queda estrictamente prohibido invocar clearStatusMeRamCache() sin argumentos aquí.
      // La purga global destruye la micro-caché de todas las terminales del sistema simultáneamente
      // provocando un Thundering Herd hacia PostgreSQL. La invalidación DEBE ser selectiva
      // iterando únicamente sobre affectedVendedores.
      try {
        const { warmStatusMeRamCache, clearStatusMeRamCache } = await import("../../api/v1/controllers/credit.controller");
        const { VendorCreditService } = await import("../credit/vendorCredit.service");

        const targetBancaIds = targetBancaId
          ? [targetBancaId]
          : Array.from(affectedBancas).filter(Boolean);

        const vendorWhere: Prisma.UserWhereInput = {
          role: Role.VENDEDOR,
          isActive: true,
        };

        if (targetBancaIds.length === 1) {
          vendorWhere.OR = [
            { bancaId: targetBancaIds[0] },
            { ventana: { bancaId: targetBancaIds[0] } },
          ];
        } else if (targetBancaIds.length > 1) {
          vendorWhere.OR = [
            { bancaId: { in: targetBancaIds } },
            { ventana: { bancaId: { in: targetBancaIds } } },
          ];
        } else if (affectedVendedores.size > 0) {
          vendorWhere.id = { in: Array.from(affectedVendedores) };
        }

        const activeVendors = (targetBancaIds.length > 0 || affectedVendedores.size > 0)
          ? await prisma.user.findMany({
              where: vendorWhere,
              select: { id: true, role: true, bancaId: true, ventanaId: true },
            })
          : [];

        if (activeVendors.length > 0) {
          await Promise.all(
            activeVendors.map(async (v) => {
              try {
                const statusRes = await VendorCreditService.getVendorsCreditStatus(
                  v,
                  { requestedVendedorIds: [v.id] }
                );
                warmStatusMeRamCache(v.id, statusRes, 8000);
              } catch (_) {
                clearStatusMeRamCache(v.id);
              }
            })
          );
        }
      } catch (_) {}

      try {
        const { WarmupCoordinator } = await import("./warmup.coordinator");
        const warmupPromises = targetBancas.map(async (bId) => {
          try {
            await WarmupCoordinator.executeWarmup(id, bId, true);
          } catch (warmupErr: any) {
            logger.warn({
              layer: "coordinator",
              action: "WARMUP_BEFORE_BROADCAST_WARN",
              payload: { sorteoId: id, bancaId: bId, error: warmupErr?.message || String(warmupErr) },
            });
          }
        });

        await Promise.race([
          Promise.all(warmupPromises),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch (err: any) {
        logger.warn({
          layer: "coordinator",
          action: "WARMUP_BEFORE_BROADCAST_UNEXPECTED_ERROR",
          payload: { sorteoId: id, error: err?.message || String(err) },
        });
      }

      // =========================================================================
      // ⚡ 2. EMISIÓN DEL WEBSOCKET BROADCAST
      // Despachado únicamente cuando la caché L2 ya está caliente y los saldos reconciliados.
      // =========================================================================
      for (const bId of targetBancas) {
        if (bId) {
          SorteoEvaluationCoordinator.emitImmediateBroadcast(
            id,
            bId,
            existingSorteo,
            evaluatedSorteo,
            winningNumber
          );
        }
      }

      // =========================================================================
      // 🚀 3. DESACOPLAMIENTO DE TAREAS SECUNDARIAS A SEGUNDO PLANO (BACKGROUND)
      // Rollups, analítica histórica, invalidaciones no conflictivas y auditoría
      // se ejecutan fuera de la ruta crítica del Event Loop mediante setImmediate cooperativo.
      // =========================================================================
      setImmediate(() => {
        runAsGlobalJob(async () => {
          await SorteoEvaluationCoordinator.executeBackgroundTasks({
            id,
            winningNumber,
            extraMultiplierId,
            existingSorteo,
            evaluatedSorteo,
            userId,
            syncOutput,
            targetBancas,
          });
        }).catch((bgErr: any) => {
          logger.error({
            layer: "coordinator",
            action: "POST_EVALUATION_BACKGROUND_ERROR",
            payload: { sorteoId: id, error: bgErr?.message || String(bgErr) },
          });
        });
      });
    });
  }

  /**
   * Tareas secundarias desacopladas de analítica, rollups, invalidaciones y Warmup L1/L2.
   * Se ejecutan en segundo plano con boundaries de error independientes para cada fase.
   */
  private static async executeBackgroundTasks(params: {
    id: string;
    winningNumber: string;
    extraMultiplierId: string | null | undefined;
    existingSorteo: any;
    evaluatedSorteo: any;
    userId: string;
    syncOutput: any;
    targetBancas: (string | null)[];
  }): Promise<void> {
    const {
      id,
      winningNumber,
      extraMultiplierId,
      existingSorteo,
      evaluatedSorteo,
      userId,
      syncOutput,
      targetBancas,
    } = params;

    // A. Invalidar caché de statements del día
    try {
      const { invalidateCacheForSorteo } = await import("../../utils/accountStatementCache");
      await invalidateCacheForSorteo({ scheduledAt: existingSorteo.scheduledAt });
    } catch (cacheErr: any) {
      logger.error({
        layer: "coordinator",
        action: "INVALIDATE_CACHE_STATEMENTS_BACKGROUND_ERROR",
        payload: { sorteoId: id, error: cacheErr?.message || String(cacheErr) },
      });
    }

    // B. Actualizar tabla de rollups (ResumenCierreDiario) y propagación si es histórico
    try {
      const { CierreRollupService } = await import("../cierre/cierre.rollup.service");
      const { tz } = await import("../../utils/timezone");
      const dateStr = syncOutput?.businessDate || (existingSorteo.scheduledAt ? tz.toDateStr(existingSorteo.scheduledAt) : tz.toDateStr());
      const todayCR = tz.toDateStr();
      const isHistorical = dateStr < todayCR;

      if (isHistorical) {
        // Si el sorteo evaluado es de una fecha anterior, propagar rollups hasta hoy inclusive
        await CierreRollupService.aggregateRange(dateStr, todayCR);

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

        try {
          const { VendorCreditService } = await import("../credit/vendorCredit.service");
          for (const vendedorId of uniqueVendedores) {
            await VendorCreditService.updateBaseBalance(vendedorId).catch(() => {});
          }
        } catch (_) {}

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
    } catch (rollupErr: any) {
      logger.error({
        layer: "coordinator",
        action: "ROLLUP_AGGREGATION_BACKGROUND_ERROR",
        payload: { sorteoId: id, error: rollupErr?.message || String(rollupErr) },
      });
    }

    // C. Agregar ventas por número para reporte histórico
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

    // D. Limpieza de Caché (Memoria y Redis)
    try {
      clearSorteoCache();
      await CacheService.invalidateTag('sorteos').catch(() => {});
      await CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});
      await CacheService.invalidateTag('dashboard').catch(() => {});
      await CacheService.invalidateTag('cierre').catch(() => {});
      // NOTA: NO invalidar 'report:summary' aquí para no purgar el warmup precalentado en L2
    } catch (cacheErr: any) {
      logger.error({
        layer: "coordinator",
        action: "CACHE_INVALIDATION_ERROR",
        payload: { sorteoId: id, error: cacheErr?.message || String(cacheErr) },
      });
    }

    // E. Registro de Actividad
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
  }
}
