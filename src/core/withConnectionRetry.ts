import logger from "./logger";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type ConnectionRetryOptions = {
  /** Reintentos máximos (por defecto: 3) */
  maxRetries?: number;
  /** Backoff mínimo entre reintentos en ms (por defecto: 500ms) */
  backoffMinMs?: number;
  /** Backoff máximo entre reintentos en ms (por defecto: 5000ms) */
  backoffMaxMs?: number;
  /** Contexto para logging (opcional) */
  context?: string;
};

/**
 * Backoff exponencial acotado:
 * ceil = min( backoffMaxMs, backoffMinMs * 2^(attempt-1) )
 * delay = random[ backoffMinMs .. ceil ]
 */
function nextDelayMs(attempt: number, backoffMinMs: number, backoffMaxMs: number) {
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
  ];

  // Mensajes comunes de errores de conexión
  const connectionErrorMessages = [
    "can't reach database server",
    "server has closed the connection",
    "connection",
    "timeout",
    "econnrefused",
    "enotfound",
    "pooler",
    "connection pool",
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
 * const result = await withConnectionRetry(
 *   () => prisma.sorteosAutoConfig.findFirst(),
 *   { maxRetries: 3, context: 'getOrCreateConfig' }
 * );
 * ```
 */
export async function withConnectionRetry<T>(
  fn: () => Promise<T>,
  opts: ConnectionRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    backoffMinMs = 500,
    backoffMaxMs = 5000,
    context = "connection",
  } = opts;

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
            message: msg,
            code,
            context,
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
            message: msg,
            code,
            context,
          },
        });
      }

      throw error;
    }
  }

  throw new Error(`Connection retry limit exceeded after ${maxRetries} attempts`);
}
