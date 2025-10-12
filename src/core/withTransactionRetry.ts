// src/core/withTransactionRetry.ts
import { Prisma } from "@prisma/client";
import { config } from "../config";
import prisma from "./prismaClient";
import logger from "./logger";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Backoff exponencial acotado:
 * ceil = min( backoffMaxMs, backoffMinMs * 2^(attempt-1) )
 * delay = random[ backoffMinMs .. ceil ]
 */
function nextDelayMs(attempt: number) {
  const { backoffMinMs, backoffMaxMs } = config.tx;
  const ceil = Math.min(backoffMaxMs, backoffMinMs * (1 << (attempt - 1)));
  const range = Math.max(ceil - backoffMinMs, 0);
  return backoffMinMs + Math.floor(Math.random() * (range + 1));
}

export async function withTransactionRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const { maxRetries, isolationLevel } = config.tx;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel, // Serializable
        // si quieres timeout, agrégalo aparte con otra var de env
      });
    } catch (error: any) {
      const msg = String(error?.message ?? "");
      const code = error?.code as string | undefined;

      const retryable =
        code === "P2034" || // deadlock / write-conflict
        code === "P2028" || // no se pudo iniciar la tx a tiempo
        /write conflict/i.test(msg) ||
        /could not serialize access due to concurrent update/i.test(msg) ||
        /deadlock/i.test(msg) ||
        /Transaction already closed/i.test(msg);

      if (retryable && attempt < maxRetries) {
        const backoff = nextDelayMs(attempt);
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
