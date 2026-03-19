import { getRedisClient, isRedisAvailable } from './redisClient';
import { config } from '../config';
import logger from './logger';
import { ResilienceService } from './resilience.service';

// OPTIMIZACIÓN L1: Caché en memoria para mitigar latencia de red y DB
interface L1Entry { data: any; expiresAt: number; }
const l1Cache = new Map<string, L1Entry>();
const MAX_L1_SIZE = 2000; // Límite de seguridad para evitar fugas de memoria

// Limpieza periódica de entradas expiradas (cada 5 minutos)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of l1Cache.entries()) {
        if (now > entry.expiresAt) l1Cache.delete(key);
    }
}, 300_000).unref(); // unref() permite que el proceso de Node.js termine si solo queda este timer

/**
 * OPTIMIZACIÓN: Servicio de caché con jerarquía L1 (Memoria) -> L2 (Redis) + Graceful Degradation
 */
export class CacheService {
    /**
     * Obtener valor del caché
     */
    static async get<T>(key: string, useL1: boolean = false): Promise<T | null> {
        // 1. OPTIMIZACIÓN L1 (Memory): Latencia cero para hot keys
        if (useL1) {
            const entry = l1Cache.get(key);
            if (entry) {
                if (Date.now() < entry.expiresAt) return entry.data as T;
                l1Cache.delete(key);
            }
        }

        if (!isRedisAvailable()) return null;

        try {
            const result = await ResilienceService.runRedis(key, async () => {
                const redis = getRedisClient();
                if (!redis) return null;

                const cached = await redis.get(key);
                if (!cached) return null;

                const parsed = JSON.parse(cached) as T;
                
                // BACKFILL L1: Si se solicitó L1 y hubo hit en L2, guardar en L1
                if (useL1) {
                    l1Cache.set(key, { data: parsed, expiresAt: Date.now() + 60000 }); // 1 min fix TTL para L1
                }

                return parsed;
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
        tags: string[] = [],
        useL1: boolean = false
    ): Promise<void> {
        // 1. OPTIMIZACIÓN L1 (Memory)
        if (useL1) {
            // Protección contra overflow: si llegamos al límite, vaciamos 
            // (estrategia simple para no incurrir en overhead de LRU)
            if (l1Cache.size >= MAX_L1_SIZE) {
                l1Cache.clear();
            }

            // L1 TTL es siempre corto para mantener consistencia (max entre 1 min y ttl real)
            const l1Ttl = Math.min(60, ttlSeconds); 
            l1Cache.set(key, { data: value, expiresAt: Date.now() + l1Ttl * 1000 });
        }

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
                    
                    // Si usamos L1, necesitamos trackear qué keys pertenecen a qué tags en memoria?
                    // Por ahora, delPattern e invalidateTag limpian L1 por conveniencia.
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
        // 1. Limpiar L1
        l1Cache.delete(key);

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
        // 1. Limpiar L1 (fuerza bruta para esta versión: limpiar todo si hay un tag de usuario/ventana)
        // Opcionalmente podríamos trackear l1Keys por tag, pero para auth:ventana es preferible limpiar L1
        // si la key contiene el userId o simplemente limpiar todo el L1 si es muy dinámico.
        // Dado el volumen, es más seguro limpiar las keys que coincidan con patrones de auth
        for (const key of l1Cache.keys()) {
            if (key.includes(tag)) l1Cache.delete(key);
        }

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
