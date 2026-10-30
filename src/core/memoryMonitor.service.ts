import v8 from "v8";
import logger from "./logger";

type WorkersSnapshotProvider = () => Promise<Array<Record<string, unknown>>>;

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 30_000;
const INITIAL_SNAPSHOT_DELAY_MS = 30_000;

const toMiB = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

/**
 * Monitor de memoria OPT-IN (ENABLE_MEMORY_MONITOR=true) para diagnóstico.
 *
 * Emite un `MEMORY_SNAPSHOT` cada MEMORY_MONITOR_INTERVAL_MS (default 5 min, mínimo 30s)
 * con el desglose del proceso principal (rss, heap, new/old space, external, arrayBuffers)
 * y de cada worker thread. Está pensado para uso temporal: permite decidir con datos si hay
 * que ajustar --max-semi-space-size o fijar resourceLimits en los workers.
 *
 * Volumen: ~1 línea cada 5 min (~290/día), muy por debajo de la cuota de Better Stack.
 */
export class MemoryMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private running = false;

  start(workersProvider?: WorkersSnapshotProvider): void {
    if (this.timer) return;

    const requested = Number(process.env.MEMORY_MONITOR_INTERVAL_MS);
    const intervalMs =
      Number.isFinite(requested) && requested > 0
        ? Math.max(requested, MIN_INTERVAL_MS)
        : DEFAULT_INTERVAL_MS;

    const tick = () => {
      this.emitSnapshot(workersProvider).catch(() => {
        // Observabilidad: nunca lanzar errores
      });
    };

    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();

    // Primera lectura tras el warmup de workers para ver la línea base real
    this.initialTimer = setTimeout(tick, INITIAL_SNAPSHOT_DELAY_MS);
    this.initialTimer.unref();

    logger.info({
      layer: "monitor",
      action: "MEMORY_MONITOR_STARTED",
      payload: { intervalMs },
    });
  }

  private async emitSnapshot(workersProvider?: WorkersSnapshotProvider): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const mem = process.memoryUsage();
      const heap = v8.getHeapStatistics();
      const spaces = v8.getHeapSpaceStatistics();
      const space = (name: string) => spaces.find((s) => s.space_name === name);
      const newSpace = space("new_space");
      const oldSpace = space("old_space");

      const containerLimit: number | undefined =
        typeof (process as any).constrainedMemory === "function"
          ? (process as any).constrainedMemory()
          : undefined;

      const main = {
        rssMiB: toMiB(mem.rss),
        heapUsedMiB: toMiB(mem.heapUsed),
        heapTotalMiB: toMiB(mem.heapTotal),
        heapLimitMiB: toMiB(heap.heap_size_limit),
        externalMiB: toMiB(mem.external),
        arrayBuffersMiB: toMiB(mem.arrayBuffers),
        newSpaceMiB: newSpace ? toMiB(newSpace.space_size) : null,
        newSpaceUsedMiB: newSpace ? toMiB(newSpace.space_used_size) : null,
        oldSpaceMiB: oldSpace ? toMiB(oldSpace.space_size) : null,
        oldSpaceUsedMiB: oldSpace ? toMiB(oldSpace.space_used_size) : null,
      };

      let workers: Array<Record<string, unknown>> = [];
      if (workersProvider) {
        try {
          workers = await workersProvider();
        } catch {
          workers = [];
        }
      }

      logger.info({
        layer: "monitor",
        action: "MEMORY_SNAPSHOT",
        payload: {
          uptimeSec: Math.round(process.uptime()),
          containerLimitMiB:
            containerLimit && Number.isFinite(containerLimit) && containerLimit < Number.MAX_SAFE_INTEGER
              ? toMiB(containerLimit)
              : null,
          main,
          workers,
        },
      });
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }
}

export const memoryMonitorService = new MemoryMonitorService();
export default memoryMonitorService;
