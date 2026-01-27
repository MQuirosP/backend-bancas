import logger from "./logger";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type ConnectionRetryOptions = {
  /** Reintentos máximos (por defecto: 3, en jobMode: 5) */
  maxRetries?: number;
  /** Backoff mínimo entre reintentos en ms (por defecto: 500ms, en jobMode: 2000ms) */
  backoffMinMs?: number;
  /** Backoff máximo entre reintentos en ms (por defecto: 5000ms, en jobMode: 30000ms) */
  backoffMaxMs?: number;
  /** Contexto para logging (opcional) */
  context?: string;
  /**
   * Modo job: usa timeouts más largos y más reintentos.
   * Recomendado para cron jobs y operaciones programadas que
   * pueden encontrar el pooler de Supabase en estado "frío".
   */
  jobMode?: boolean;
};

/**
 * Backoff exponencial acotado:
 * ceil = min( backoffMaxMs, backoffMinMs * 2^(attempt-1) )
 * delay = random[ backoffMinMs .. ceil ]
 */
function nextDelayMs(
  attempt: number,
  backoffMinMs: number,
  backoffMaxMs: number
) {
  const ceil = Math.min(backoffMaxMs, backoffMinMs * (1 << (attempt - 1)));
  const range = Math.max(ceil - backoffMinMs, 0);
  return backoffMinMs + Math.floor(Math.random() * (range + 1));
}

/**
 * Verifica si un error es un error de conexión que puede ser reintentado
 */
function isConnectionError(error: any): boolean {
  const code = error?.code as string | undefined;
  const msg = String(error?.message ?? "").toLowerCase();

  // Códigos de error de Prisma para problemas de conexión
  const connectionErrorCodes = [
    "P1001", // Can't reach database server
    "P1017", // Server has closed the connection
    "P1000", // Authentication failed (a veces puede ser temporal)
    "P1002", // Database server timed out
    "P1008", // Operations timed out
    "P1011", // Error opening a TLS connection
    "P1012", // Schema validation error (puede ser temporal en cold start)
  ];

  // Mensajes comunes de errores de conexión
  const connectionErrorMessages = [
    "can't reach database server",
    "server has closed the connection",
    "connection refused",
    "connection reset",
    "connection timed out",
    "timeout",
    "econnrefused",
    "econnreset",
    "enotfound",
    "etimedout",
    "pooler",
    "connection pool",
    "socket hang up",
    "network error",
  ];

  return (
    connectionErrorCodes.includes(code || "") ||
    connectionErrorMessages.some((pattern) => msg.includes(pattern))
  );
}

/**
 * Ejecuta una función con reintentos automáticos ante errores de conexión a la base de datos.
 * Útil para jobs y operaciones que pueden fallar por problemas temporales de red con Supabase.
 *
 * @example
 * ```ts
 * // Uso normal (requests web)
 * const result = await withConnectionRetry(
 *   () => prisma.user.findFirst(),
 *   { context: 'getUser' }
 * );
 *
 * // Uso en jobs (más tolerante)
 * const config = await withConnectionRetry(
 *   () => prisma.sorteosAutoConfig.findFirst(),
 *   { jobMode: true, context: 'autoCloseJob' }
 * );
 * ```
 */
export async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  opts: ConnectionRetryOptions = {}
): Promise<T> {
  const isJob = opts.jobMode ?? false;

  // Defaults más agresivos para jobs
  const maxRetries = opts.maxRetries ?? (isJob ? 5 : 3);
  const backoffMinMs = opts.backoffMinMs ?? (isJob ? 2000 : 500);
  const backoffMaxMs = opts.backoffMaxMs ?? (isJob ? 30000 : 5000);
  const context = opts.context ?? "connection";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isConnectionErr = isConnectionError(error);
      const msg = String(error?.message ?? "");
      const code = error?.code as string | undefined;

      // Solo reintentar si es un error de conexión y no hemos alcanzado el límite
      if (isConnectionErr && attempt < maxRetries) {
        const backoff = nextDelayMs(attempt, backoffMinMs, backoffMaxMs);
        logger.warn({
          layer: "connection",
          action: "RETRY",
          payload: {
            attempt,
            maxRetries,
            backoffMs: backoff,
            code,
            context,
            jobMode: isJob,
            // Truncar mensaje largo para no saturar logs
            message:
              msg.length > 150 ? msg.substring(0, 150) + "..." : msg,
          },
        });
        await sleep(backoff);
        continue;
      }

      // Si no es un error de conexión o ya agotamos los reintentos, lanzar el error
      if (isConnectionErr) {
        logger.error({
          layer: "connection",
          action: "FAIL_AFTER_RETRIES",
          payload: {
            attempt,
            maxRetries,
            code,
            context,
            jobMode: isJob,
            message:
              msg.length > 200 ? msg.substring(0, 200) + "..." : msg,
          },
        });
      }

      throw error;
    }
  }

  throw new Error(
    `Connection retry limit exceeded after ${maxRetries} attempts`
  );
}
