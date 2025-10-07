import { Prisma } from "@prisma/client";
import prisma from "../core/prismaClient";
import logger from "../core/logger";

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
        timeout: 20000, // ⏱️ aumentamos el límite para operaciones concurrentes
        isolationLevel: "Serializable",
      });
    } catch (error: any) {
      const isRetryable =
        error.code === "P2034" || // Deadlock detected
        /Transaction failed due to a write conflict/i.test(error.message) ||
        /Transaction already closed/i.test(error.message);

      if (isRetryable && attempt < retries) {
        logger.warn({
          layer: "transaction",
          action: "RETRY",
          payload: {
            attempt,
            message: error.message,
          },
        });

        await new Promise((r) => setTimeout(r, 300 * attempt)); // backoff progresivo
        continue;
      }

      logger.error({
        layer: "transaction",
        action: "FAIL",
        payload: {
          attempt,
          error: error.message,
        },
      });

      throw error;
    }
  }

  throw new Error("Transaction retry limit exceeded");
}
