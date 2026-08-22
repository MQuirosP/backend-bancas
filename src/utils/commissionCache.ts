// src/utils/commissionCache.ts
import { CommissionPolicy } from '../services/commission/types/CommissionTypes';
import { parseCommissionPolicy } from '../services/commission/utils/PolicyParser';
import logger from '../core/logger';
import { getRedisClient, isRedisAvailable } from '../core/redisClient';

export type CommissionEntityType = 'USER' | 'VENTANA' | 'BANCA';

const COMMISSION_CACHE_TTL_SECONDS = 5 * 60; // 5 minutos (300s)

/**
 * Genera la clave de Redis para una política de comisiones
 */
export function generateCommissionCacheKey(
  entityType: CommissionEntityType,
  entityId: string
): string {
  return `commissions:policy:${entityType}:${entityId}`;
}

/**
 * Obtiene una política de comisión desde Redis o la parsea y cachea (Cache-Aside)
 * Resiliente: si Redis falla o no está disponible, parsea y retorna sin romper la solicitud.
 */
export async function getCachedCommissionPolicy(
  entityType: CommissionEntityType,
  entityId: string,
  policyJson: unknown
): Promise<CommissionPolicy | null> {
  const cacheKey = generateCommissionCacheKey(entityType, entityId);

  // 1. Intentar leer desde Redis si está disponible
  if (isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as CommissionPolicy;
          return parsed;
        }
      }
    } catch (error) {
      logger.warn({
        layer: 'cache',
        action: 'COMMISSION_CACHE_GET_FALLBACK',
        payload: {
          cacheKey,
          error: error instanceof Error ? error.message : String(error),
          fallback: 'Parseando política directamente de DB',
        },
      });
    }
  }

  // 2. Cache miss o Redis no disponible: Parsear política directamente
  const policy = parseCommissionPolicy(policyJson, entityType);

  // 3. Si hay política parseada y Redis disponible, guardar en Redis de forma asíncrona y segura
  if (policy && isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      if (redis) {
        await redis.set(
          cacheKey,
          JSON.stringify(policy),
          'EX',
          COMMISSION_CACHE_TTL_SECONDS
        );
      }
    } catch (error) {
      logger.warn({
        layer: 'cache',
        action: 'COMMISSION_CACHE_SET_ERROR',
        payload: {
          cacheKey,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return policy;
}

/**
 * Invalida el caché de comisiones en Redis
 * Si se especifican entityType y entityId, elimina la clave puntual.
 * Si no se especifican parámetros, elimina todas las políticas cacheadas.
 */
export async function clearCommissionCache(
  entityType?: CommissionEntityType,
  entityId?: string
): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }

  try {
    const redis = getRedisClient();
    if (!redis) return;

    if (entityType && entityId) {
      const cacheKey = generateCommissionCacheKey(entityType, entityId);
      const deleted = await redis.del(cacheKey);

      if (deleted > 0) {
        logger.info({
          layer: 'cache',
          action: 'COMMISSION_CACHE_CLEARED_SINGLE',
          payload: { entityType, entityId, cacheKey },
        });
      }
    } else {
      const searchPattern = '*commissions:policy:*';
      const allKeys: string[] = [];
      let cursor = '0';

      do {
        const [newCursor, keys] = await redis.scan(
          cursor,
          'MATCH',
          searchPattern,
          'COUNT',
          100
        );
        cursor = newCursor;
        allKeys.push(...keys);
      } while (cursor !== '0');

      if (allKeys.length > 0) {
        const prefix = (redis as any).options?.keyPrefix || '';
        const cleanKeys = allKeys.map((k) =>
          prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k
        );

        const BATCH_SIZE = 100;
        for (let i = 0; i < cleanKeys.length; i += BATCH_SIZE) {
          const batch = cleanKeys.slice(i, i + BATCH_SIZE);
          await redis.del(...batch);
        }

        logger.info({
          layer: 'cache',
          action: 'COMMISSION_CACHE_CLEARED_ALL',
          payload: { cleared: cleanKeys.length },
        });
      }
    }
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'COMMISSION_CACHE_CLEAR_ERROR',
      payload: {
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Obtiene el estado del caché de comisiones
 */
export function getCommissionCacheStats(): {
  isRedisAvailable: boolean;
  ttlSeconds: number;
} {
  return {
    isRedisAvailable: isRedisAvailable(),
    ttlSeconds: COMMISSION_CACHE_TTL_SECONDS,
  };
}

/**
 * Stubs no-op para mantener retrocompatibilidad sin timers en memoria
 */
export function startCommissionCacheCleanup(): void {
  // No-op: Redis gestiona la expiración automáticamente
}

export function stopCommissionCacheCleanup(): void {
  // No-op: No hay timers activos que detener
}
