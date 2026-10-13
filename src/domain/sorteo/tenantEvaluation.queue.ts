import logger from "../../core/logger";

interface QueueEntry {
  tail: Promise<any>;
  pendingCount: number;
}

export class TenantEvaluationQueue {
  private static queues = new Map<string, QueueEntry>();
  private static readonly QUEUE_TIMEOUT_MS = 10000; // 10 segundos de guardia

  /**
   * Encola la ejecución de una evaluación garantizando serialización estricta por banca
   * y concurrencia completa entre bancas distintas.
   */
  static async enqueue<T>(
    bancaId: string | null | undefined,
    sorteoId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const bancaKey = bancaId || "global";
    let entry = this.queues.get(bancaKey);

    if (!entry) {
      entry = { tail: Promise.resolve(), pendingCount: 0 };
      this.queues.set(bancaKey, entry);
    }

    entry.pendingCount++;

    const executeWithTimeout = async (): Promise<T> => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          logger.error({
            layer: "coordinator",
            action: "TENANT_EVALUATION_QUEUE_TIMEOUT",
            payload: {
              bancaId: bancaKey,
              sorteoId,
              timeoutMs: TenantEvaluationQueue.QUEUE_TIMEOUT_MS,
              message: `Evaluación del sorteo ${sorteoId} excedió el timeout de ${TenantEvaluationQueue.QUEUE_TIMEOUT_MS}ms en la cola de la banca ${bancaKey}.`,
            },
          });
          reject(new Error(`Evaluación excedió el timeout de ${TenantEvaluationQueue.QUEUE_TIMEOUT_MS}ms`));
        }, TenantEvaluationQueue.QUEUE_TIMEOUT_MS);
      });

      try {
        return await Promise.race([operation(), timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    };

    // Encadenamiento FIFO en la cola de la banca
    const currentTask = entry.tail
      .catch(() => {}) // Ignorar fallo del sorteo previo para no detener la cola
      .then(executeWithTimeout);

    entry.tail = currentTask.catch(() => {});

    try {
      return await currentTask;
    } finally {
      entry.pendingCount--;
      // Cero memory leaks: purgar la clave si no hay sorteos en espera para esta banca
      if (entry.pendingCount <= 0) {
        this.queues.delete(bancaKey);
      }
    }
  }
}
