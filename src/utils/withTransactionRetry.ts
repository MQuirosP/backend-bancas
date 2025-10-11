import { Prisma } from "@prisma/client";
import prisma from "../core/prismaClient";
import logger from "../core/logger";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ejecuta una función dentro de una transacción Prisma con reintentos automáticos
 * en caso de deadlocks o write conflicts.
 */
export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  retries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        timeout: 20000,
        isolationLevel: "Serializable", // estricto para evitar fantasmas en concurrencia
      });
    } catch (error: any) {
      const msg = String(error?.message ?? "");
      const code = (error as any)?.code;

      const isRetryable =
        code === "P2034" || // Deadlock detected
        /write conflict/i.test(msg) ||
        /could not serialize access due to concurrent update/i.test(msg) ||
        /Transaction already closed/i.test(msg);

      if (isRetryable && attempt < retries) {
        const backoff = 250 * attempt + Math.floor(Math.random() * 120); // jitter
        logger.warn({
          layer: "transaction",
          action: "RETRY",
          payload: { attempt, backoffMs: backoff, message: msg },
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
