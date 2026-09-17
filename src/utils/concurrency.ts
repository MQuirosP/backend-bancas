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
 * de precalentamiento concurrentes contra PostgreSQL nunca exceda MAX_CONCURRENCY (5).
 */
export class SharedWarmupPool {
  private static readonly MAX_CONCURRENCY = 5;
  private static activeWorkers = 0;
  private static queue: (() => void)[] = [];

  /**
   * Ejecuta una tarea individual dentro del pool compartido con límite estricto de concurrencia.
   */
  static async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeWorkers >= this.MAX_CONCURRENCY) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeWorkers++;
    try {
      return await task();
    } finally {
      this.activeWorkers--;
      const next = this.queue.shift();
      if (next) next();
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
