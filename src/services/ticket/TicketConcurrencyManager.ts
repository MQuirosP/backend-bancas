import { v4 as uuidv4 } from "uuid";
import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { AppError } from "../../core/errors";
import { isRedisAvailable } from "../../core/redisClient";
import { acquireLock, releaseLock } from "../../repositories/helpers/ticket-restriction.helper";
import { buildRulesCacheKey, getCachedRestrictionRules } from "../../repositories/ticket.repository";
import { CreateTicketOptions, TicketLockHandle } from "./ticket.types";

export class TicketConcurrencyManager {
  /**
   * Adquiere un lock distribuido en Redis por banca, ventana o vendedor según el alcance real de las reglas.
   */
  static async acquire(
    sorteoId: string,
    ventanaId: string,
    userId: string,
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

      // Evaluar dinámicamente si existe alguna regla activa de Monto Compartido a nivel de Ventana o Banca (appliesToVendedor = false)
      let hasSharedVentanaLimit = false;
      try {
        const rulesCacheKey = buildRulesCacheKey({ userId, ventanaId, bancaId: targetBancaId });
        const candidateRules = await getCachedRestrictionRules<any>(rulesCacheKey);

        if (Array.isArray(candidateRules) && candidateRules.length > 0) {
          hasSharedVentanaLimit = candidateRules.some((rule: any) => {
            if (!rule || rule.isActive === false) return false;
            const isAmountRule =
              rule.maxTotal !== null ||
              rule.maxAmount !== null ||
              rule.baseAmount !== null ||
              rule.salesPercentage !== null;
            const isSharedVentana =
              rule.ventanaId !== null &&
              rule.userId === null &&
              rule.appliesToVendedor !== true;
            const isSharedBanca =
              rule.bancaId !== null &&
              rule.ventanaId === null &&
              rule.userId === null &&
              rule.appliesToVendedor !== true;

            return isAmountRule && (isSharedVentana || isSharedBanca);
          });
        }
      } catch (err: any) {
        // Fallback seguro: ante cualquier error al consultar reglas, activar Lock por Ventana por seguridad
        hasSharedVentanaLimit = true;
        logger.warn({
          layer: 'repository',
          action: 'LOCK_SCOPE_FALLBACK_VENTANA',
          payload: { error: err.message, sorteoId, ventanaId, userId },
        });
      }

      if (ventanaId || userId) {
        lockKey = hasSharedVentanaLimit
          ? `lock:ticket-create:sorteo:${sorteoId}:ventana:${ventanaId}`
          : `lock:ticket-create:sorteo:${sorteoId}:vendedor:${userId}`;

        let attempts = 0;
        const maxAttempts = 50;
        const startTime = Date.now();
        while (attempts < maxAttempts) {
          lockAcquired = await acquireLock(lockKey, lockValue, 10);
          if (lockAcquired) break;
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20));
        }

        const waitDurationMs = Date.now() - startTime;
        if (attempts > 0 && lockAcquired) {
          logger.info({
            layer: 'repository',
            action: 'TICKET_CREATE_LOCK_WAIT',
            payload: {
              lockKey,
              attempts,
              waitDurationMs,
              sorteoId,
              ventanaId,
              userId,
              hasSharedVentanaLimit,
              bancaId: targetBancaId,
            },
          });
        }

        if (!lockAcquired) {
          logger.warn({
            layer: 'repository',
            action: 'TICKET_CREATE_LOCK_TIMEOUT',
            payload: { lockKey, attempts, waitDurationMs },
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
