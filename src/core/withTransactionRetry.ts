import { Prisma } from "@prisma/client";
import { config } from "../config";
import prisma from "./prismaClient";
import logger from "./logger";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type TxRetryOptions = {
  /** Nivel de aislamiento de la transacción (por defecto: config.tx.isolationLevel) */
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Reintentos máximos (por defecto: config.tx.maxRetries) */
  maxRetries?: number;
  /** Espera máxima por un slot de transacción/conn (por defecto: config.tx.maxWaitMs o 10s) */
  maxWaitMs?: number;
  /** Timeout de la transacción (por defecto: config.tx.timeoutMs o 20s) */
  timeoutMs?: number;
  /** Backoff mínimo entre reintentos (por defecto: config.tx.backoffMinMs) */
  backoffMinMs?: number;
  /** Backoff máximo entre reintentos (por defecto: config.tx.backoffMaxMs) */
  backoffMaxMs?: number;
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
 * Errores de conexión del pooler (Supavisor) que merecen reintento completo.
 * La transacción nunca se ejecutó, por lo que reintentar es idempotente.
 */
function isPoolerConnectionError(code: string | undefined, msg: string): boolean {
  return (
    code === "P1001" || // Can't reach database server
    code === "P1008" || // Operations timed out
    code === "P2024" || // Timed out fetching a new connection from the pool
    /can't reach database/i.test(msg) ||
    /connection pool timeout/i.test(msg)
  );
}

/** Backoff lineal fijo para errores de conexión: 500ms, 1000ms, 1500ms */
function connectionBackoffMs(attempt: number): number {
  return Math.min(attempt * 500, 1500);
}

/**
 * Ejecuta una función dentro de una *transacción interactiva* de Prisma con reintentos
 * ante conflictos de escritura, deadlocks o cierres prematuros de la transacción.
 * También reintenta ante rechazos temporales del pooler (P1001, P1008, P2024).
 */
export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  opts: TxRetryOptions = {}
): Promise<T> {
  const {
    isolationLevel = (config.tx.isolationLevel as Prisma.TransactionIsolationLevel) ??
      Prisma.TransactionIsolationLevel.ReadCommitted,
    maxRetries = config.tx.maxRetries ?? 3,
    maxWaitMs = (config as any).tx?.maxWaitMs ?? 10_000,
    timeoutMs = (config as any).tx?.timeoutMs ?? 20_000,
    backoffMinMs = config.tx.backoffMinMs ?? 150,
    backoffMaxMs = config.tx.backoffMaxMs ?? 2_000,
  } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel,
        maxWait: maxWaitMs,
        timeout: timeoutMs,
      });
    } catch (error: any) {
      const msg = String(error?.message ?? "");
      const code = error?.code as string | undefined;

      // Errores de conexión/pooler: backoff lineal más largo
      if (isPoolerConnectionError(code, msg)) {
        if (attempt < maxRetries) {
          const backoff = connectionBackoffMs(attempt);
          logger.warn({
            layer: "transaction",
            action: "RETRY_CONNECTION",
            payload: { attempt, backoffMs: backoff, code,
              message: msg.length > 150 ? msg.substring(0, 150) + "..." : msg },
          });
          await sleep(backoff);
          continue;
        }
        logger.error({
          layer: "transaction",
          action: "FAIL_CONNECTION",
          payload: { attempt, code, error: msg.length > 200 ? msg.substring(0, 200) + "..." : msg },
        });
        throw error;
      }

      // Errores de serialización/deadlock: backoff exponencial corto (comportamiento previo)
      const retryable =
        code === "P2034" || // deadlock / write-conflict (pg "could not serialize")
        code === "P2028" || // error de API de transacción (iniciar/recuperar tx)
        code === "P2002" || // unique constraint violation (puede ser por ticketNumber en concurrencia)
        /write conflict/i.test(msg) ||
        /could not serialize access due to concurrent update/i.test(msg) ||
        /deadlock/i.test(msg) ||
        /Transaction already closed/i.test(msg) ||
        /Transaction not found/i.test(msg) ||
        /Unique constraint failed/i.test(msg);

      if (retryable && attempt < maxRetries) {
        const backoff = nextDelayMs(attempt, backoffMinMs, backoffMaxMs);
        logger.warn({
          layer: "transaction",
          action: "RETRY",
          payload: { attempt, backoffMs: backoff, message: msg, code },
        });
        await sleep(backoff);
        continue;
      }

      logger.error({
        layer: "transaction",
        action: "FAIL",
        payload: { attempt, code, error: msg },
      });
      throw error;
    }
  }

  throw new Error("Transaction retry limit exceeded");
}
