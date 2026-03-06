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
}
