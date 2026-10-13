import logger from "../../core/logger";
import SorteoService from "./sorteo.service";
import { WARMUP_CHUNK_SIZE, WARMUP_COOLDOWN_MS } from "./warmup.constants";
import { SocketService } from "../../core/socket.service";

export interface WarmupResult {
  totalVendors: number;
  entriesCached: number;
  coalescedSorteoIds?: string[];
  cooldownAppliedMs?: number;
}

interface DeferredPromise<T> {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

interface BancaWarmupState {
  isRunning: boolean;
  lastCompletedAt: number;
  pendingSorteos: Set<string>;
  pendingBroadcasts: Array<{ sorteoId: string; payload: any }>;
  deferredWaiters: DeferredPromise<WarmupResult>[];
  cooldownTimeout: NodeJS.Timeout | null;
}

/**
 * WarmupCoordinator - Coordinador de precalentamiento de resúmenes evaluados.
 *
 * Responsabilidades críticas:
 * 1. Serialización por Banca (Mutex): Nunca corre 2 warmups masivos en paralelo para la misma banca.
 * 2. Deduplicación y Coalescing: Si mientras corre un warmup se evalúan sorteos adicionales,
 *    se agrupan en una única ejecución subsiguiente para el estado más reciente.
 * 3. Cooldown de 5s: Aplica una ventana mínima de 5,000 ms entre warmups para dejar respirar
 *    al Event Loop de Node.js (0.5 vCPU) y evitar que peticiones HTTP entrantes (OPTIONS, consultas)
 *    sufran retrasos.
 * 4. Broadcast protegido: El WebSocket broadcast de sorteos evaluados se emite tras calentar L1/L2
 *    (o en fallback si falla el warmup) para evitar cold-reads masivos contra PostgreSQL.
 */
export class WarmupCoordinator {
  public static readonly WARMUP_CHUNK_SIZE = WARMUP_CHUNK_SIZE;
  private static readonly COOLDOWN_MS = WARMUP_COOLDOWN_MS;
  private static states = new Map<string, BancaWarmupState>();

  private static getState(bancaKey: string): BancaWarmupState {
    let state = this.states.get(bancaKey);
    if (!state) {
      state = {
        isRunning: false,
        lastCompletedAt: 0,
        pendingSorteos: new Set<string>(),
        pendingBroadcasts: [],
        deferredWaiters: [],
        cooldownTimeout: null,
      };
      this.states.set(bancaKey, state);
    }
    return state;
  }

  /**
   * Encola el warmup y broadcast en background de forma coalescida.
   * Garantiza que el broadcast ocurra ÚNICAMENTE tras calentar L1/L2,
   * o mediante fallback si el warmup falla, sin retrasar el response HTTP 200.
   */
  static scheduleWarmupAndBroadcast(
    sorteoId: string,
    bancaId: string | null | undefined,
    broadcastPayload: any
  ): void {
    const bancaKey = bancaId || "global";
    const state = this.getState(bancaKey);

    state.pendingSorteos.add(sorteoId);
    state.pendingBroadcasts.push({ sorteoId, payload: broadcastPayload });

    // Si no está corriendo y no hay un cooldown activo, disparar ciclo en el próximo tick cooperativo
    if (!state.isRunning && !state.cooldownTimeout) {
      setImmediate(() => {
        this.processNext(bancaKey, 0);
      });
    }
  }

  /**
   * Ejecuta o encola el precalentamiento de evaluated-summary para un sorteo evaluado.
   *
   * @param sorteoId ID del sorteo recién evaluado
   * @param bancaId ID de la banca (opcional)
   * @returns Resultado del warmup ejecutado o coalescido
   */
  static async executeWarmup(
    sorteoId: string,
    bancaId?: string | null
  ): Promise<WarmupResult> {
    const bancaKey = bancaId || "global";
    const state = this.getState(bancaKey);

    // Caso 1: Ya hay un warmup ejecutándose para esta banca
    if (state.isRunning) {
      state.pendingSorteos.add(sorteoId);

      logger.info({
        layer: "coordinator",
        action: "WARMUP_COALESCED_PENDING",
        payload: {
          sorteoId,
          bancaId: bancaKey,
          pendingCount: state.pendingSorteos.size,
          message: `Warmup en progreso para la banca ${bancaKey}. Sorteo ${sorteoId} encolado para coalescing.`,
        },
      });

      return new Promise<WarmupResult>((resolve, reject) => {
        state.deferredWaiters.push({ resolve, reject });
      });
    }

    // Caso 2: Verificar si estamos dentro de la ventana de cooldown de 5s
    const timeSinceLastCompleted = Date.now() - state.lastCompletedAt;
    if (timeSinceLastCompleted < this.COOLDOWN_MS && state.lastCompletedAt > 0) {
      const waitMs = this.COOLDOWN_MS - timeSinceLastCompleted;
      state.pendingSorteos.add(sorteoId);

      logger.info({
        layer: "coordinator",
        action: "WARMUP_COOLDOWN_WAITING",
        payload: {
          sorteoId,
          bancaId: bancaKey,
          waitMs,
          timeSinceLastCompleted,
          message: `Último warmup completado hace ${timeSinceLastCompleted}ms (< ${this.COOLDOWN_MS}ms). Esperando ${waitMs}ms de cooldown para dar aire al Event Loop.`,
        },
      });

      return new Promise<WarmupResult>((resolve, reject) => {
        state.deferredWaiters.push({ resolve, reject });

        // Si no hay un timeout de cooldown activo, programarlo
        if (!state.cooldownTimeout) {
          state.cooldownTimeout = setTimeout(() => {
            state.cooldownTimeout = null;
            this.processNext(bancaKey, waitMs);
          }, waitMs);
        }
      });
    }

    // Caso 3: Sin warmup activo y fuera de cooldown -> Iniciar de inmediato
    return this.runWarmupCycle(sorteoId, bancaKey);
  }

  /**
   * Ejecuta el ciclo de warmup concreto llamando a SorteoService
   */
  private static async runWarmupCycle(
    sorteoId: string,
    bancaKey: string,
    cooldownAppliedMs: number = 0
  ): Promise<WarmupResult> {
    const state = this.getState(bancaKey);
    state.isRunning = true;
    const startTime = Date.now();

    const actualBancaId = bancaKey === "global" ? null : bancaKey;

    logger.info({
      layer: "coordinator",
      action: "WARMUP_COORDINATOR_START",
      payload: {
        sorteoId,
        bancaId: actualBancaId,
        cooldownAppliedMs,
      },
    });

    let result: WarmupResult = { totalVendors: 0, entriesCached: 0 };
    let error: any = null;

    try {
      const rawResult = await SorteoService.warmupEvaluatedSummaries(
        sorteoId,
        actualBancaId
      );

      result = {
        totalVendors: rawResult?.totalVendors ?? 0,
        entriesCached: rawResult?.entriesCached ?? 0,
        cooldownAppliedMs,
      };

      logger.info({
        layer: "coordinator",
        action: "WARMUP_COORDINATOR_COMPLETED",
        payload: {
          sorteoId,
          bancaId: actualBancaId,
          totalVendors: result.totalVendors,
          entriesCached: result.entriesCached,
          durationMs: Date.now() - startTime,
          cooldownAppliedMs,
        },
      });

      // Emisión de WebSocket broadcast: la caché L1/L2 ya está caliente y lista
      this.emitPendingBroadcasts(state);
    } catch (err: any) {
      error = err;
      logger.error({
        layer: "coordinator",
        action: "WARMUP_COORDINATOR_ERROR",
        payload: {
          sorteoId,
          bancaId: actualBancaId,
          error: err?.message || String(err),
          durationMs: Date.now() - startTime,
        },
      });

      // Fallback defensivo: Si el warmup falla, emitir de todas formas para no silenciar
      // la notificación del sorteo evaluado hacia las terminales cliente
      this.emitPendingBroadcasts(state);
    } finally {
      state.isRunning = false;
      state.lastCompletedAt = Date.now();

      // Si NO quedan sorteos pendientes, resolvamos a todos los waiters que aguardaban el estado final
      if (state.pendingSorteos.size === 0) {
        const currentWaiters = [...state.deferredWaiters];
        state.deferredWaiters = [];

        for (const waiter of currentWaiters) {
          if (error) {
            waiter.reject(error);
          } else {
            waiter.resolve(result);
          }
        }
      }

      // Si quedaron sorteos pendientes encolados durante la ejecución de este warmup,
      // programar el siguiente ciclo respetando el cooldown
      if (state.pendingSorteos.size > 0 && !state.cooldownTimeout) {
        const pendingList = Array.from(state.pendingSorteos);
        logger.info({
          layer: "coordinator",
          action: "WARMUP_SCHEDULE_PENDING_AFTER_COOLDOWN",
          payload: {
            bancaId: actualBancaId,
            pendingSorteos: pendingList,
            cooldownMs: this.COOLDOWN_MS,
            message: `Quedan ${pendingList.length} sorteos pendientes de warmup. Programando siguiente ciclo en ${this.COOLDOWN_MS}ms.`,
          },
        });

        state.cooldownTimeout = setTimeout(() => {
          state.cooldownTimeout = null;
          this.processNext(bancaKey, this.COOLDOWN_MS);
        }, this.COOLDOWN_MS);
      }
    }

    if (error) {
      throw error;
    }

    return result;
  }

  /**
   * Emite de forma segura todos los WebSocket broadcasts acumulados para la banca.
   */
  private static emitPendingBroadcasts(state: BancaWarmupState): void {
    if (!state.pendingBroadcasts || state.pendingBroadcasts.length === 0) {
      return;
    }

    const broadcastsToEmit = [...state.pendingBroadcasts];
    state.pendingBroadcasts = [];

    for (const { payload } of broadcastsToEmit) {
      try {
        SocketService.notifySorteoEvaluated(payload);
        SocketService.notifyDashboardUpdated({ bancaId: payload.bancaId });
      } catch (wsErr: any) {
        logger.warn({
          layer: "coordinator",
          action: "WARMUP_SOCKET_EMIT_WARN",
          payload: {
            sorteoId: payload?.sorteoId,
            error: wsErr?.message || String(wsErr),
          },
        });
      }
    }
  }

  /**
   * Procesa los sorteos pendientes acumulados para la banca de forma coalescida
   */
  private static async processNext(bancaKey: string, cooldownAppliedMs: number = 0) {
    const state = this.getState(bancaKey);
    if (state.isRunning || state.pendingSorteos.size === 0) {
      return;
    }

    const pendingList = Array.from(state.pendingSorteos);
    state.pendingSorteos.clear();

    const targetSorteoId = pendingList[pendingList.length - 1];

    logger.info({
      layer: "coordinator",
      action: "WARMUP_COALESCED_EXECUTION_START",
      payload: {
        targetSorteoId,
        bancaId: bancaKey,
        allCoalescedSorteos: pendingList,
        cooldownAppliedMs,
        message: `Ejecutando warmup coalescido para ${pendingList.length} sorteos acumulados (${pendingList.join(", ")}).`,
      },
    });

    try {
      const res = await this.runWarmupCycle(targetSorteoId, bancaKey, cooldownAppliedMs);
      res.coalescedSorteoIds = pendingList;
    } catch (_err) {
      // Si falló runWarmupCycle y aún quedaron waiters sin resolver, rechazarlos
      const leftoverWaiters = [...state.deferredWaiters];
      state.deferredWaiters = [];
      for (const waiter of leftoverWaiters) {
        waiter.reject(_err);
      }
    }
  }
}
