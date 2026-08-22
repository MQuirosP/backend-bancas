import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import logger from '../core/logger';
import prisma from '../core/prismaClient';

export interface SorteoExclusionItem {
  ventanaId: string;
  vendedorId: string | null;
  multiplierId: string | null;
}

const EXCLUSION_CACHE_TTL_SECONDS = 300; // 5 minutos
const SENTINEL_EMPTY = '__EMPTY__';

/**
 * Genera la clave de Redis para el set de exclusiones de un sorteo
 */
function getExclusionSetKey(sorteoId: string): string {
  return `exclusions:set:${sorteoId}`;
}

export const exclusionCacheService = {
  /**
   * Obtiene las exclusiones para un sorteo usando Redis Set (Cache-Aside)
   * Si no está en caché o Redis falla, consulta directamente la base de datos de forma resiliente.
   */
  async getExclusions(sorteoId: string): Promise<SorteoExclusionItem[]> {
    const cacheKey = getExclusionSetKey(sorteoId);

    // 1. Intentar obtener desde Redis Set si está disponible
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const members = await redis.smembers(cacheKey);
          if (members && members.length > 0) {
            // Si contiene el centinela de set vacío, retornar array vacío
            if (members.length === 1 && members[0] === SENTINEL_EMPTY) {
              return [];
            }
            const data: SorteoExclusionItem[] = [];
            for (const item of members) {
              if (item !== SENTINEL_EMPTY) {
                try {
                  data.push(JSON.parse(item) as SorteoExclusionItem);
                } catch {
                  // Omitir miembro corrupto si existiera
                }
              }
            }
            return data;
          }
        }
      } catch (err) {
        logger.warn({
          layer: 'cache',
          action: 'EXCLUSION_CACHE_REDIS_GET_ERROR',
          payload: {
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
            fallback: 'Consultando exclusiones directamente en DB',
          },
        });
      }
    }

    // 2. Cache miss o Redis no disponible: Consultar DB vía Prisma
    const exclusions: SorteoExclusionItem[] = await prisma.sorteoListaExclusion.findMany({
      where: { sorteoId },
      select: {
        ventanaId: true,
        vendedorId: true,
        multiplierId: true,
      },
    });

    // 3. Poblar Redis Set con TTL explícito
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const pipeline = redis.pipeline();
          pipeline.del(cacheKey);
          if (exclusions.length === 0) {
            pipeline.sadd(cacheKey, SENTINEL_EMPTY);
          } else {
            const members = exclusions.map((e) => JSON.stringify(e));
            pipeline.sadd(cacheKey, ...members);
          }
          pipeline.expire(cacheKey, EXCLUSION_CACHE_TTL_SECONDS);
          await pipeline.exec();
        }
      } catch (err) {
        logger.warn({
          layer: 'cache',
          action: 'EXCLUSION_CACHE_REDIS_SET_ERROR',
          payload: {
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    return exclusions;
  },

  /**
   * Valida si una exclusión puntual existe en el set de Redis para el sorteo O(1)
   */
  async isExcluded(sorteoId: string, item: SorteoExclusionItem): Promise<boolean> {
    const cacheKey = getExclusionSetKey(sorteoId);

    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          const exists = await redis.sismember(cacheKey, JSON.stringify(item));
          return exists === 1;
        }
      } catch (err) {
        logger.warn({
          layer: 'cache',
          action: 'EXCLUSION_CACHE_SISMEMBER_ERROR',
          payload: {
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // Fallback: consultar listado completo
    const list = await this.getExclusions(sorteoId);
    return list.some(
      (e) =>
        e.ventanaId === item.ventanaId &&
        e.vendedorId === item.vendedorId &&
        e.multiplierId === item.multiplierId
    );
  },

  /**
   * Invalida el caché de exclusiones para un sorteo en Redis
   */
  async invalidateCache(sorteoId: string): Promise<void> {
    const cacheKey = getExclusionSetKey(sorteoId);
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          await redis.del(cacheKey);
        }
      } catch (err) {
        logger.warn({
          layer: 'cache',
          action: 'EXCLUSION_CACHE_REDIS_DEL_ERROR',
          payload: {
            cacheKey,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  },
};
