import logger from "../core/logger";

/**
 * ConcurrencyManager - Gestor de hilos de ejecución local por request
 */
export class ConcurrencyManager {
  /**
   * Ejecuta una lista de tareas asíncronas con un límite de concurrencia.
   * Utiliza un patrón de Worker Pool para evitar saturar el pool de conexiones.
   */
  static async runLimited<T>(
    tasks: (() => Promise<T>)[],
    options: { limit: number; label?: string }
  ): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    const queue = tasks.map((task, index) => ({ task, index }));
    const limit = Math.min(options.limit, tasks.length);

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        try {
          results[item.index] = await item.task();
        } catch (error) {
          // Mantener el índice para no romper el orden del array de resultados
          throw error;
        }
      }
    };

    // Lanzar hilos (workers) en paralelo
    const workers = Array.from({ length: limit }, () => worker());
    await Promise.all(workers);
    
    return results;
  }

  /**
   * Ejecuta una lista de tareas asíncronas con un límite de concurrencia y retorna los resultados liquidados.
   * Equivalente a Promise.allSettled pero con límite de hilos paralelos.
   */
  static async runLimitedSettled<T>(
    tasks: (() => Promise<T>)[],
    options: { limit: number; label?: string }
  ): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    const queue = tasks.map((task, index) => ({ task, index }));
    const limit = Math.min(options.limit, tasks.length);

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        try {
          const value = await item.task();
          results[item.index] = { status: "fulfilled", value };
        } catch (error) {
          results[item.index] = { status: "rejected", reason: error };
        }
      }
    };

    const workers = Array.from({ length: limit }, () => worker());
    await Promise.all(workers);

    return results;
  }
}

/**
 * SharedWarmupPool - Pool singleton de concurrencia compartida para warmups.
 * Garantiza que sin importar cuántos sorteos se evalúen simultáneamente, el número de tareas
 * de precalentamiento concurrentes contra PostgreSQL nunca exceda MAX_CONCURRENCY (6).
 */
export class SharedWarmupPool {
  private static readonly MAX_CONCURRENCY = 6;
  private static activeWorkers = 0;
  private static queue: (() => void)[] = [];

  /**
   * Ejecuta una tarea individual dentro del pool compartido con límite estricto de concurrencia.
   * Incluye pausas cooperativas para evitar saturar el Event Loop en contenedores de 0.5 vCPU.
   */
  static async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeWorkers >= this.MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeWorkers++;

    // Pausa cooperativa mínima para dar prioridad al Event Loop y peticiones HTTP entrantes (OPTIONS, health, queries)
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      return await task();
    } finally {
      this.activeWorkers--;
      const next = this.queue.shift();
      if (next) {
        // Despachar el siguiente worker en el próximo tick del Event Loop
        setImmediate(next);
      }
    }
  }

  /**
   * Encola un conjunto de tareas y retorna una promesa que se resuelve cuando todas terminen (allSettled).
   */
  static async runAllSettled<T>(tasks: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
    return Promise.allSettled(tasks.map((task) => this.run(task)));
  }

  static get activeCount(): number {
    return this.activeWorkers;
  }

  static get pendingCount(): number {
    return this.queue.length;
  }
}

/**
 * SingleFlight - Supresión de llamadas duplicadas concurrentes (Promise Deduplication).
 * Si múltiples peticiones concurrentes solicitan el mismo recurso que no está en caché,
 * solo la primera ejecuta la operación costosa y todas las demás resuelven con el
 * resultado de la misma Promesa sin saturar la base de datos.
 */
export class SingleFlight {
  private static inFlight = new Map<string, Promise<any>>();

  /**
   * Ejecuta fn o acopla la llamada a la Promesa en vuelo si ya existe una para `key`.
   */
  static async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  static get inFlightCount(): number {
    return this.inFlight.size;
  }
}

/**
 * Detecta si el error se originó estrictamente durante la espera o adquisición de conexión del pool.
 * En este caso, ninguna sentencia SQL llegó a enviarse al servidor PostgreSQL, por lo que es seguro
 * reintentar la operación sin riesgo alguno de ejecutar incrementos o escrituras duplicadas.
 */
export function isPoolAcquisitionTimeout(error: any): boolean {
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("timed out waiting for a connection") ||
    msg.includes("connection pool") ||
    msg.includes("remaining connection slots are reserved") ||
    error?.code === "P1002"
  );
}

/**
 * BackgroundTaskQueue - Cola acotada para tareas asíncronas post-venta.
 * - Limita la concurrencia a MAX_CONCURRENCY (3 tareas en vuelo) para proteger el pool general.
 * - Acota el backlog a MAX_QUEUE_SIZE (50 tareas). Si se satura bajo ráfaga extrema, descarta con log para proteger la memoria.
 * - Reintenta con backoff exponencial ÚNICAMENTE si la falla fue por timeout de conexión al pool (sin duplicidad de queries).
 */
export class BackgroundTaskQueue {
  private static readonly MAX_CONCURRENCY = 3;
  private static readonly MAX_QUEUE_SIZE = 50;
  private static activeWorkers = 0;
  private static queue: Array<() => Promise<void>> = [];

  static enqueue(label: string, task: () => Promise<void>, maxRetries = 2): void {
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      logger.warn({
        layer: "background-queue",
        action: "TASK_DROPPED_QUEUE_OVERFLOW",
        payload: { label, queueSize: this.queue.length },
      });
      return;
    }

    const runner = async () => {
      let attempts = 0;
      while (attempts <= maxRetries) {
        try {
          await task();
          return;
        } catch (err: any) {
          attempts++;
          if (isPoolAcquisitionTimeout(err) && attempts <= maxRetries) {
            const backoffMs = 1000 * attempts + Math.floor(Math.random() * 500);
            logger.warn({
              layer: "background-queue",
              action: "POOL_TIMEOUT_RETRY",
              payload: { label, attempt: attempts, backoffMs, error: err?.message || String(err) },
            });
            await new Promise((r) => setTimeout(r, backoffMs));
          } else {
            logger.error({
              layer: "background-queue",
              action: "TASK_FAILED",
              payload: {
                label,
                attempts,
                isPoolTimeout: isPoolAcquisitionTimeout(err),
                error: err?.message || String(err),
              },
            });
            return;
          }
        }
      }
    };

    this.queue.push(runner);
    this.processNext();
  }

  private static processNext(): void {
    if (this.activeWorkers >= this.MAX_CONCURRENCY || this.queue.length === 0) {
      return;
    }

    const nextTask = this.queue.shift();
    if (!nextTask) return;

    this.activeWorkers++;
    setImmediate(async () => {
      try {
        await nextTask();
      } finally {
        this.activeWorkers--;
        this.processNext();
      }
    });
  }

  static get queueSize(): number {
    return this.queue.length;
  }

  static get runningCount(): number {
    return this.activeWorkers;
  }
}
