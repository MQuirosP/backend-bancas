import { v4 as uuidv4 } from "uuid";
import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { AppError } from "../../core/errors";
import { isRedisAvailable } from "../../core/redisClient";
import { acquireLock, releaseLock } from "../../repositories/helpers/ticket-restriction.helper";
import { CreateTicketOptions, TicketLockHandle } from "./ticket.types";

export class TicketConcurrencyManager {
  /**
   * Adquiere un lock distribuido en Redis por banca y sorteo.
   */
  static async acquire(
    sorteoId: string,
    ventanaId: string,
    options?: CreateTicketOptions
  ): Promise<TicketLockHandle | null> {
    const lockValue = uuidv4();
    let lockKey = "";
    let lockAcquired = false;

    if (isRedisAvailable()) {
      let targetBancaId = options?.preFetched?.ventana?.bancaId;
      if (!targetBancaId) {
        const vent = await prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: { bancaId: true },
        });
        targetBancaId = vent?.bancaId;
      }

      if (targetBancaId) {
        lockKey = `lock:ticket-create:sorteo:${sorteoId}:banca:${targetBancaId}`;
        let attempts = 0;
        const maxAttempts = 50;
        while (attempts < maxAttempts) {
          lockAcquired = await acquireLock(lockKey, lockValue, 10);
          if (lockAcquired) break;
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
        }

        if (!lockAcquired) {
          logger.warn({
            layer: 'repository',
            action: 'TICKET_CREATE_LOCK_TIMEOUT',
            payload: { lockKey, attempts },
          });
          throw new AppError(
            'El sistema está procesando demasiadas solicitudes concurrentes para esta banca. Por favor, reintente en unos segundos.',
            429,
            'CONCURRENT_REQUEST_LIMIT'
          );
        }

        return { lockKey, lockValue, lockAcquired: true };
      }
    }

    return null;
  }

  /**
   * Libera el lock distribuido en Redis si fue adquirido.
   */
  static async release(lock: TicketLockHandle | null): Promise<void> {
    if (lock && lock.lockAcquired && lock.lockKey) {
      await releaseLock(lock.lockKey, lock.lockValue);
    }
  }
}
