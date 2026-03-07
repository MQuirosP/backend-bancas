import { getRedisClient, isRedisAvailable } from './redisClient';
import { config } from '../config';
import logger from './logger';
import { ResilienceService } from './resilience.service';

/**
 * OPTIMIZACIÓN: Servicio de caché genérico con graceful degradation
 */
export class CacheService {
    /**
     * Obtener valor del caché
     */
    static async get<T>(key: string): Promise<T | null> {
        if (!isRedisAvailable()) return null;

        try {
            const result = await ResilienceService.runRedis(key, async () => {
                const redis = getRedisClient();
                if (!redis) return null;

                const cached = await redis.get(key);
                if (!cached) return null;

                return JSON.parse(cached) as T;
            });
            return result ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Guardar valor en caché con TTL y opcionalmente asociarlo a tags
     */
    static async set(
        key: string, 
        value: any, 
        ttlSeconds: number = config.redis.ttlCutoff, 
        tags: string[] = []
    ): Promise<void> {
        if (!isRedisAvailable()) return;

        try {
            await ResilienceService.runRedis(key, async () => {
                const redis = getRedisClient();
                if (!redis) return;

                const pipeline = redis.pipeline();
                pipeline.setex(key, ttlSeconds, JSON.stringify(value));

                // Asociar clave a tags para invalidación masiva
                for (const tag of tags) {
                    const tagKey = `tag:${tag}`;
                    pipeline.sadd(tagKey, key);
                    pipeline.expire(tagKey, 86400); // Max 24h para el set de tags
                }

                await pipeline.exec();
            });
        } catch (error) {
            // Ya logueado por el breaker
        }
    }

    /**
     * Eliminar valor del caché
     */
    static async del(key: string): Promise<void> {
        if (!isRedisAvailable()) return;
        const redis = getRedisClient();
        if (!redis) return;

        try {
            await redis.del(key);
        } catch (error) {
            logger.warn({ layer: 'cache', action: 'DEL_ERROR', payload: { key, error: (error as Error).message } });
        }
    }

    /**
     * Invalidar todas las claves asociadas a un tag
     */
    static async invalidateTag(tag: string): Promise<void> {
        if (!isRedisAvailable()) return;
        const redis = getRedisClient();
        if (!redis) return;

        try {
            const tagKey = `tag:${tag}`;
            const keys = await redis.smembers(tagKey);
            
            if (keys.length > 0) {
                const pipeline = redis.pipeline();
                pipeline.del(...keys);
                pipeline.del(tagKey);
                await pipeline.exec();
                
                logger.info({
                    layer: 'cache',
                    action: 'INVALIDATE_TAG',
                    payload: { tag, keysCount: keys.length }
                });
            }
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'INVALIDATE_TAG_ERROR',
                payload: { tag, error: (error as Error).message }
            });
        }
    }

    /**
     * Wrapper para Cache-Aside con Coalescing (evita Cache Stampede)
     */
    static async wrap<T>(
        key: string,
        fetcher: () => Promise<T>,
        ttlSeconds: number = config.redis.ttlCutoff,
        tags: string[] = []
    ): Promise<T> {
        // 1. Intentar obtener de caché (protegido por runRedis internamente en get)
        const cached = await this.get<T>(key);
        if (cached !== null) return cached;

        // 2. Si no hay caché, el fetcher se ejecuta fuera del breaker de Redis
        // para no contaminar métricas si falla la lógica de negocio.
        const result = await fetcher();

        // 3. Guardar en caché asíncronamente (protegido por runRedis internamente en set)
        this.set(key, result, ttlSeconds, tags).catch(() => {});

        return result;
    }

    /**
     * Eliminar múltiples claves por patrón (usando SCAN)
     */
    static async delPattern(pattern: string): Promise<string[] | null> {
        if (!isRedisAvailable()) return null;
        const redis = getRedisClient();
        if (!redis) return null;

        try {
            const allKeys: string[] = [];
            let cursor = '0';

            do {
                const [newCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = newCursor;
                allKeys.push(...keys);
            } while (cursor !== '0');

            if (allKeys.length > 0) {
                const BATCH_SIZE = 100;
                for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
                    const batch = allKeys.slice(i, i + BATCH_SIZE);
                    await redis.del(...batch);
                }
                return allKeys;
            }
            return [];
        } catch (error) {
            logger.warn({ layer: 'cache', action: 'DEL_PATTERN_ERROR', payload: { pattern, error: (error as Error).message } });
            return null;
        }
    }
}
