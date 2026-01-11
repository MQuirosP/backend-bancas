import logger from '../core/logger';

export interface PerformanceSnapshot {
  timestamp: number;
  label: string;
  memory: {
    rss: number;           // Resident Set Size (memoria física total usada)
    heapTotal: number;     // Heap total asignado
    heapUsed: number;      // Heap realmente usado
    external: number;      // Memoria C++ (Buffers)
    arrayBuffers: number;  // ArrayBuffers asignados
  };
  memoryMB: {
    rss: number;
    heapUsed: number;
    external: number;
  };
  deltaFromStart?: {
    timeMs: number;
    rssMB: number;
    heapUsedMB: number;
  };
}

export class PerformanceMonitor {
  private startSnapshot: PerformanceSnapshot | null = null;
  private snapshots: PerformanceSnapshot[] = [];
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Inicia el monitoreo y captura snapshot inicial
   */
  start(label: string = 'START'): PerformanceSnapshot {
    const snapshot = this.captureSnapshot(label);
    this.startSnapshot = snapshot;
    this.snapshots.push(snapshot);

    logger.info({
      layer: 'performance',
      action: 'MONITOR_START',
      meta: {
        context: this.context,
        label,
        memory: snapshot.memoryMB,
      },
    });

    return snapshot;
  }

  /**
   * Captura un checkpoint durante la ejecución
   */
  checkpoint(label: string): PerformanceSnapshot {
    if (!this.startSnapshot) {
      throw new Error('PerformanceMonitor: must call start() before checkpoint()');
    }

    const snapshot = this.captureSnapshot(label);
    const delta = this.calculateDelta(snapshot);
    snapshot.deltaFromStart = delta;
    this.snapshots.push(snapshot);

    // Log CRÍTICO: Si heap crece >100MB desde el inicio, alertar
    const isMemorySpike = delta.heapUsedMB > 100;
    const logLevel = isMemorySpike ? 'warn' : 'info';

    logger[logLevel]({
      layer: 'performance',
      action: 'MONITOR_CHECKPOINT',
      meta: {
        context: this.context,
        label,
        memory: snapshot.memoryMB,
        delta: {
          timeMs: delta.timeMs,
          rssMB: parseFloat(delta.rssMB.toFixed(2)),
          heapUsedMB: parseFloat(delta.heapUsedMB.toFixed(2)),
        },
        alert: isMemorySpike ? 'MEMORY_SPIKE_DETECTED' : undefined,
      },
    });

    return snapshot;
  }

  /**
   * Finaliza el monitoreo y retorna resumen
   */
  end(label: string = 'END'): PerformanceMonitor.Summary {
    if (!this.startSnapshot) {
      throw new Error('PerformanceMonitor: must call start() before end()');
    }

    const endSnapshot = this.captureSnapshot(label);
    const delta = this.calculateDelta(endSnapshot);
    endSnapshot.deltaFromStart = delta;
    this.snapshots.push(endSnapshot);

    const summary = this.generateSummary();

    // Log CRÍTICO: Resumen final con alertas
    const isPeakExceeded = summary.peakHeapUsedMB > 400; // Umbral crítico
    const isSlowRequest = summary.totalTimeMs > 5000; // >5s es lento

    logger[isPeakExceeded || isSlowRequest ? 'warn' : 'info']({
      layer: 'performance',
      action: 'MONITOR_END',
      meta: {
        context: this.context,
        label,
        summary: {
          totalTimeMs: summary.totalTimeMs,
          peakRssMB: parseFloat(summary.peakRssMB.toFixed(2)),
          peakHeapUsedMB: parseFloat(summary.peakHeapUsedMB.toFixed(2)),
          heapGrowthMB: parseFloat(summary.heapGrowthMB.toFixed(2)),
          checkpointsCount: summary.checkpointsCount,
          slowestCheckpoint: summary.slowestCheckpoint,
        },
        alerts: [
          isPeakExceeded && 'PEAK_HEAP_EXCEEDED_400MB',
          isSlowRequest && 'SLOW_REQUEST_OVER_5S',
        ].filter(Boolean),
      },
    });

    return summary;
  }

  /**
   * Captura snapshot de memoria actual
   */
  private captureSnapshot(label: string): PerformanceSnapshot {
    const memUsage = process.memoryUsage();

    return {
      timestamp: Date.now(),
      label,
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },
      memoryMB: {
        rss: memUsage.rss / 1024 / 1024,
        heapUsed: memUsage.heapUsed / 1024 / 1024,
        external: memUsage.external / 1024 / 1024,
      },
    };
  }

  /**
   * Calcula delta desde el snapshot inicial
   */
  private calculateDelta(current: PerformanceSnapshot): {
    timeMs: number;
    rssMB: number;
    heapUsedMB: number;
  } {
    if (!this.startSnapshot) {
      return { timeMs: 0, rssMB: 0, heapUsedMB: 0 };
    }

    return {
      timeMs: current.timestamp - this.startSnapshot.timestamp,
      rssMB: current.memoryMB.rss - this.startSnapshot.memoryMB.rss,
      heapUsedMB: current.memoryMB.heapUsed - this.startSnapshot.memoryMB.heapUsed,
    };
  }

  /**
   * Genera resumen final de la ejecución
   */
  private generateSummary(): PerformanceMonitor.Summary {
    if (!this.startSnapshot) {
      throw new Error('No start snapshot');
    }

    const endSnapshot = this.snapshots[this.snapshots.length - 1];
    const peakRss = Math.max(...this.snapshots.map(s => s.memoryMB.rss));
    const peakHeapUsed = Math.max(...this.snapshots.map(s => s.memoryMB.heapUsed));

    // Identificar checkpoint más lento
    let slowestCheckpoint: { label: string; durationMs: number } | undefined;
    let maxDuration = 0;
    for (let i = 1; i < this.snapshots.length; i++) {
      const duration = this.snapshots[i].timestamp - this.snapshots[i - 1].timestamp;
      if (duration > maxDuration) {
        maxDuration = duration;
        slowestCheckpoint = {
          label: this.snapshots[i].label,
          durationMs: duration,
        };
      }
    }

    return {
      totalTimeMs: endSnapshot.timestamp - this.startSnapshot.timestamp,
      startRssMB: this.startSnapshot.memoryMB.rss,
      startHeapUsedMB: this.startSnapshot.memoryMB.heapUsed,
      endRssMB: endSnapshot.memoryMB.rss,
      endHeapUsedMB: endSnapshot.memoryMB.heapUsed,
      peakRssMB: peakRss,
      peakHeapUsedMB: peakHeapUsed,
      heapGrowthMB: endSnapshot.memoryMB.heapUsed - this.startSnapshot.memoryMB.heapUsed,
      checkpointsCount: this.snapshots.length,
      slowestCheckpoint,
    };
  }

  /**
   * Obtiene todos los snapshots capturados (para análisis detallado)
   */
  getSnapshots(): PerformanceSnapshot[] {
    return [...this.snapshots];
  }
}

export namespace PerformanceMonitor {
  export interface Summary {
    totalTimeMs: number;
    startRssMB: number;
    startHeapUsedMB: number;
    endRssMB: number;
    endHeapUsedMB: number;
    peakRssMB: number;
    peakHeapUsedMB: number;
    heapGrowthMB: number;
    checkpointsCount: number;
    slowestCheckpoint?: {
      label: string;
      durationMs: number;
    };
  }
}

/**
 * Helper para medir una función async y retornar resultado + métricas
 */
export async function measureAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number; memoryDeltaMB: number }> {
  const startMem = process.memoryUsage().heapUsed;
  const startTime = Date.now();

  const result = await fn();

  const endTime = Date.now();
  const endMem = process.memoryUsage().heapUsed;

  return {
    result,
    durationMs: endTime - startTime,
    memoryDeltaMB: (endMem - startMem) / 1024 / 1024,
  };
}
