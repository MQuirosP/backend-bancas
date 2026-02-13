import prisma from "./prismaClient";
import { getPrismaDirect } from "./prismaClientDirect";
import logger from "./logger";

export interface WarmupOptions {
  /** Usar conexión directa (DIRECT_URL) en lugar del pooler transaccional */
  useDirect?: boolean;
  /** Máximo de intentos de conexión */
  maxAttempts?: number;
  /** Delay base en ms entre intentos (se multiplica por intento) */
  baseDelayMs?: number;
  /** Contexto para logging */
  context?: string;
}

/**
 * "Calienta" la conexión a la base de datos antes de ejecutar operaciones.
 *
 * Útil para jobs programados que hacen conexiones "frías" al pooler de Supabase.
 * Ejecuta un SELECT 1 para forzar el establecimiento de conexión.
 *
 * @returns true si la conexión se estableció correctamente, false si falló
 *
 * @example
 * ```ts
 * // En un job, antes de ejecutar operaciones:
 * const isConnected = await warmupConnection({ useDirect: true, context: 'autoCloseJob' });
 * if (!isConnected) {
 *   logger.error({ layer: 'job', action: 'SKIP', payload: { reason: 'warmup failed' } });
 *   return;
 * }
 * // Proceder con operaciones...
 * ```
 */
export async function warmupConnection(
  options: WarmupOptions = {}
): Promise<boolean> {
  const {
    useDirect = false,
    maxAttempts = 5,
    baseDelayMs = 2000,
    context = "warmup",
  } = options;

  const client = useDirect ? getPrismaDirect() : prisma;
  const clientType = useDirect ? "direct" : "pooler";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Query simple para verificar conexión
      await client.$queryRaw`SELECT 1 as ping`;

      logger.info({
        layer: "connection",
        action: "WARMUP_SUCCESS",
        payload: {
          attempt,
          maxAttempts,
          clientType,
          context,
        },
      });

      return true;
    } catch (error: any) {
      const errorCode = error?.code as string | undefined;
      const errorMessage = error?.message ?? String(error);

      logger.warn({
        layer: "connection",
        action: "WARMUP_RETRY",
        payload: {
          attempt,
          maxAttempts,
          clientType,
          context,
          errorCode,
          errorMessage:
            errorMessage.length > 200
              ? errorMessage.substring(0, 200) + "..."
              : errorMessage,
        },
      });

      if (attempt < maxAttempts) {
        // Backoff lineal: 2s, 4s, 6s, 8s...
        const delay = baseDelayMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error({
    layer: "connection",
    action: "WARMUP_FAILED",
    payload: {
      maxAttempts,
      clientType,
      context,
      message: `Failed to establish database connection after ${maxAttempts} attempts`,
    },
  });

  return false;
}

/**
 * Verifica si la conexión está activa sin reintentos.
 * Útil para health checks rápidos.
 */
export async function isConnectionAlive(useDirect = false): Promise<boolean> {
  const client = useDirect ? getPrismaDirect() : prisma;

  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
