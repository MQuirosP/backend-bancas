import { getRedisClient } from '../core/redisClient';
import logger from '../core/logger';
import prisma from '../core/prismaClient';

const L1_CACHE = new Map<string, { data: any; expiresAt: number }>();
const L1_TTL_MS = 30 * 1000; // 30 seconds
const L2_TTL_SECONDS = 300; // 5 minutes

export const exclusionCacheService = {
  /**
   * Obtiene las exclusiones para un sorteo, usando L1 -> L2 -> DB
   */
  async getExclusions(sorteoId: string): Promise<any[]> {
    const cacheKey = `exclusions:${sorteoId}`;
    const now = Date.now();

    // 1. L1 Cache (Memory)
    const l1Entry = L1_CACHE.get(cacheKey);
    if (l1Entry && l1Entry.expiresAt > now) {
      return l1Entry.data;
    }

    // 2. L2 Cache (Redis)
    const redis = getRedisClient();
    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const data = JSON.parse(cached);
          // Set to L1
          L1_CACHE.set(cacheKey, { data, expiresAt: now + L1_TTL_MS });
          return data;
        }
      } catch (err) {
        logger.warn({ layer: 'cache', action: 'REDIS_GET_ERROR', payload: { cacheKey, error: (err as Error).message } });
      }
    }

    // 3. DB (Prisma)
    const exclusions = await prisma.sorteoListaExclusion.findMany({
      where: { sorteoId },
      select: {
        ventanaId: true,
        vendedorId: true,
        multiplierId: true,
      },
    });

    // 4. Update Caches
    L1_CACHE.set(cacheKey, { data: exclusions, expiresAt: now + L1_TTL_MS });
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(exclusions), 'EX', L2_TTL_SECONDS);
      } catch (err) {
        logger.warn({ layer: 'cache', action: 'REDIS_SET_ERROR', payload: { cacheKey, error: (err as Error).message } });
      }
    }

    return exclusions;
  },

  /**
   * Invalida el caché de exclusiones para un sorteo
   */
  async invalidateCache(sorteoId: string): Promise<void> {
    const cacheKey = `exclusions:${sorteoId}`;
    L1_CACHE.delete(cacheKey);
    const redis = getRedisClient();
    if (redis) {
      try {
        await redis.del(cacheKey);
      } catch (err) {
        logger.warn({ layer: 'cache', action: 'REDIS_DEL_ERROR', payload: { cacheKey, error: (err as Error).message } });
      }
    }
  }
};
