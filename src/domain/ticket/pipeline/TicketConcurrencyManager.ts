import { v4 as uuidv4 } from "uuid";
import { salesPrisma } from "../../../core/prismaClient";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { isRedisSalesAvailable } from "../../../core/redisClient";
import {
  acquireLock,
  releaseLock,
  acquireMultiLock,
  releaseMultiLock,
} from "../../../repositories/helpers/ticket-restriction.helper";
import { buildRulesCacheKey, getCachedRestrictionRules } from "../../../repositories/ticket.repository";
import { CreateTicketOptions, TicketLockHandle } from "./ticket.types";
import { TicketPrefetchService } from "./TicketPrefetchService";

export class TicketConcurrencyManager {
  /**
   * Adquiere un lock distribuido en Redis granular por número (cuando hay reglas compartidas de banca/ventana)
   * o por vendedor cuando no existen límites compartidos.
   */
  static async acquire(
    sorteoId: string,
    ventanaId: string,
    userId: string,
    options?: CreateTicketOptions,
    jugadasNumbers?: string[]
  ): Promise<TicketLockHandle | null> {
    const lockValue = uuidv4();
    let lockKey = "";
    let lockKeys: string[] = [];
    let lockAcquired = false;

    if (isRedisSalesAvailable()) {
      let targetBancaId = options?.preFetched?.ventana?.bancaId;
      if (!targetBancaId) {
        const vent = await TicketPrefetchService.fetchVentanaWithBanca(ventanaId);
        targetBancaId = vent?.bancaId;
        if (vent && options) {
          if (!options.preFetched) options.preFetched = {};
          options.preFetched.ventana = vent;
        }
      }

      // Evaluar dinámicamente si existe alguna regla activa de Monto Compartido a nivel de Ventana o Banca (appliesToVendedor = false)
      let hasSharedVentanaLimit = false;
      let hasSharedBancaLimit = false;
      try {
        let candidateRules: any[] | null | undefined = options?.preFetched?.rules;
        if (!candidateRules) {
          const rulesCacheKey = buildRulesCacheKey({ userId, ventanaId, bancaId: targetBancaId });
          candidateRules = await getCachedRestrictionRules<any>(rulesCacheKey);
          if (candidateRules && options) {
            if (!options.preFetched) options.preFetched = {};
            options.preFetched.rules = candidateRules;
          }
        }

        if (Array.isArray(candidateRules) && candidateRules.length > 0) {
          for (const rule of candidateRules) {
            if (!rule || rule.isActive === false) continue;
            const isAmountRule =
              rule.maxTotal !== null ||
              rule.maxAmount !== null ||
              rule.baseAmount !== null ||
              rule.salesPercentage !== null;
            if (!isAmountRule) continue;

            if (
              rule.ventanaId !== null &&
              rule.userId === null &&
              rule.appliesToVendedor !== true
            ) {
              hasSharedVentanaLimit = true;
            }
            if (
              rule.bancaId !== null &&
              rule.ventanaId === null &&
              rule.userId === null &&
              rule.appliesToVendedor !== true
            ) {
              hasSharedBancaLimit = true;
            }
          }
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
        const uniqueSortedNumbers = Array.from(new Set(jugadasNumbers || [])).sort();
        if (hasSharedBancaLimit && targetBancaId && uniqueSortedNumbers.length > 0) {
          lockKeys = uniqueSortedNumbers.map(
            (num) => `lock:ticket-num:${sorteoId}:banca:${targetBancaId}:${num}`
          );
          lockKey = `${lockKeys[0]}${lockKeys.length > 1 ? `(+${lockKeys.length - 1})` : ''}`;
        } else if (hasSharedVentanaLimit && uniqueSortedNumbers.length > 0) {
          lockKeys = uniqueSortedNumbers.map(
            (num) => `lock:ticket-num:${sorteoId}:ventana:${ventanaId}:${num}`
          );
          lockKey = `${lockKeys[0]}${lockKeys.length > 1 ? `(+${lockKeys.length - 1})` : ''}`;
        } else if (hasSharedVentanaLimit || hasSharedBancaLimit) {
          lockKey = `lock:ticket-create:sorteo:${sorteoId}:ventana:${ventanaId}`;
          lockKeys = [lockKey];
        } else {
          lockKey = `lock:ticket-create:sorteo:${sorteoId}:vendedor:${userId}`;
          lockKeys = [lockKey];
        }

        let attempts = 0;
        const maxAttempts = 50;
        const startTime = Date.now();
        while (attempts < maxAttempts) {
          lockAcquired =
            lockKeys.length > 1
              ? await acquireMultiLock(lockKeys, lockValue, 10)
              : await acquireLock(lockKeys[0], lockValue, 10);
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
              lockKeysCount: lockKeys.length,
              attempts,
              waitDurationMs,
              sorteoId,
              ventanaId,
              userId,
              hasSharedVentanaLimit,
              hasSharedBancaLimit,
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

        return { lockKey, lockKeys, lockValue, lockAcquired: true, waitDurationMs, attempts };
      }
    }

    return null;
  }

  /**
   * Libera el lock distribuido en Redis si fue adquirido.
   */
  static async release(lock: TicketLockHandle | null): Promise<void> {
    if (!lock || !lock.lockAcquired) return;
    if (lock.lockKeys && lock.lockKeys.length > 1) {
      await releaseMultiLock(lock.lockKeys, lock.lockValue);
    } else if (lock.lockKey) {
      await releaseLock(lock.lockKey, lock.lockValue);
    }
  }
}
