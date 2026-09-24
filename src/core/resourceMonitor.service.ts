import { monitorEventLoopDelay, IntervalHistogram } from "perf_hooks";
import { salesPool, generalPool } from "./prismaClient";
import logger from "./logger";

export class ResourceMonitorService {
  private histogram: IntervalHistogram | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;

  private maxSalesWaiting = 0;
  private maxGeneralWaiting = 0;

  /**
   * Inicia el monitoreo de retraso del event loop y estadísticas de conexión de pools.
   */
  start(): void {
    if (this.histogram) return;

    // 1. Inicializar y habilitar monitor de event loop (resolución de 20ms)
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();

    // Inicializar contadores de la primera ventana
    this.maxSalesWaiting = salesPool.waitingCount;
    this.maxGeneralWaiting = generalPool.waitingCount;

    // 2. Muestrear cada 1s waitingCount de ambos pools
    this.sampleTimer = setInterval(() => {
      try {
        const salesWaiting = salesPool.waitingCount;
        const generalWaiting = generalPool.waitingCount;
        if (salesWaiting > this.maxSalesWaiting) this.maxSalesWaiting = salesWaiting;
        if (generalWaiting > this.maxGeneralWaiting) this.maxGeneralWaiting = generalWaiting;
      } catch {
        // Observabilidad: nunca lanzar errores
      }
    }, 1000);
    this.sampleTimer.unref();

    // 3. Emitir métricas cada 20s (info SIEMPRE, warn si p99 > 30ms)
    this.logTimer = setInterval(() => {
      try {
        this.emitReport();
      } catch {
        // Observabilidad: nunca lanzar errores
      }
    }, 20000);
    this.logTimer.unref();

    logger.info({
      layer: "monitor",
      action: "RESOURCE_MONITOR_STARTED",
      payload: { windowMs: 20000, sampleRateMs: 1000, resolutionMs: 20 },
    });
  }

  private emitReport(): void {
    if (!this.histogram) return;

    // Lectura de percentil 99 y max en ms
    const p99_ns = this.histogram.percentile(99);
    const max_ns = this.histogram.max;
    const p99_ms = Math.round((p99_ns / 1e6) * 100) / 100;
    const max_ms = Math.round((max_ns / 1e6) * 100) / 100;

    // Llamar a .reset() tras leer
    this.histogram.reset();

    const pool_stats = {
      sales_max_waiting: this.maxSalesWaiting,
      sales_waiting: salesPool.waitingCount,
      sales_total: salesPool.totalCount,
      sales_idle: salesPool.idleCount,
      general_max_waiting: this.maxGeneralWaiting,
      general_waiting: generalPool.waitingCount,
      general_total: generalPool.totalCount,
      general_idle: generalPool.idleCount,
    };

    // Resetear máximos para la siguiente ventana de 20s
    this.maxSalesWaiting = salesPool.waitingCount;
    this.maxGeneralWaiting = generalPool.waitingCount;

    const payload = {
      p99_ms,
      max_ms,
      pool_stats,
    };

    if (p99_ms > 30) {
      logger.warn({
        layer: "monitor",
        action: "event_loop_lag",
        payload,
      });
    } else {
      logger.info({
        layer: "monitor",
        action: "event_loop_lag",
        payload,
      });
    }
  }

  /**
   * Detiene los temporizadores y deshabilita el monitor en el shutdown.
   */
  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }
  }
}

export const resourceMonitorService = new ResourceMonitorService();
export default resourceMonitorService;
