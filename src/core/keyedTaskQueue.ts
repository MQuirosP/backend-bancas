import logger from "./logger";

type Task<T> = () => Promise<T>;

/**
 * KeyedTaskQueue - Utilidad para serializar la ejecución de tareas asíncronas por clave.
 * 
 * Garantiza que para una misma clave (p. ej., una entidad y una fecha), solo se ejecute
 * una tarea a la vez. Las tareas subsiguientes esperan a que la anterior termine.
 */
export class KeyedTaskQueue {
  private static queues: Map<string, Promise<any>> = new Map();

  /**
   * Ejecuta una tarea asíncrona asegurando que para una misma clave (key),
   * las tareas se ejecuten de forma estrictamente secuencial.
   * 
   * @param key Clave para agrupar tareas (ej: `sync-account-{entityId}-{date}`)
   * @param task Función que devuelve una promesa
   * @returns El resultado de la tarea
   */
  static async enqueue<T>(key: string, task: Task<T>): Promise<T> {
    const previousPromise = this.queues.get(key) || Promise.resolve();

    // Crear una nueva promesa que espere a la anterior antes de ejecutar la actual
    const nextPromise = previousPromise.then(
      async () => {
        try {
          return await task();
        } catch (error) {
          logger.error({
            layer: "core",
            action: "KEYED_TASK_QUEUE_ERROR",
            payload: { key, error: (error as Error).message }
          });
          throw error;
        }
      },
      // Si la tarea anterior falló, igualmente permitimos que la siguiente se ejecute
      async () => {
        try {
          return await task();
        } catch (error) {
           logger.error({
            layer: "core",
            action: "KEYED_TASK_QUEUE_ERROR_RECOVERY",
            payload: { key, error: (error as Error).message }
          });
          throw error;
        }
      }
    );

    // Actualizar el mapa con la promesa de la tarea que acaba de entrar a la cola
    this.queues.set(key, nextPromise);

    // Limpieza: Si al terminar esta promesa, sigue siendo la última en la cola, eliminamos la clave
    nextPromise.finally(() => {
      if (this.queues.get(key) === nextPromise) {
        this.queues.delete(key);
      }
    });

    return nextPromise;
  }
}
