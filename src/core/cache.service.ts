import { getRedisClient, isRedisAvailable, redisSubscriber } from './redisClient';
import { config } from '../config';
import logger from './logger';
import { ResilienceService } from './resilience.service';
import { EventEmitter } from 'events';

export const CacheEvents = new EventEmitter();
let isSubscribed = false;

export function initCacheSubscriber() {
    if (!redisSubscriber || isSubscribed) return;
    isSubscribed = true;
    
    redisSubscriber.subscribe('cache:invalidate');
    redisSubscriber.on('message', (channel: string, message: string) => {
        if (channel === 'cache:invalidate') {
            l1Cache.delete(message);
            CacheEvents.emit('invalidate', message);
        }
    });
}

// OPTIMIZACIÓN L1: Caché en memoria para mitigar latencia de red y DB
interface L1Entry { data: any; expiresAt: number; }
const l1Cache = new Map<string, L1Entry>();
const MAX_L1_SIZE = 500; // Límite de seguridad para evitar fugas de memoria
const inFlightPromises = new Map<string, Promise<any>>();

// TTLs para L1: restricciones de vendedor 30s, cutoffs 60s
export const L1_TTL_RESTRICTIONS_MS = 30_000;  // 30 segundos — bloqueos de números rápidos
export const L1_TTL_CUTOFF_MS      = 60_000;   // 60 segundos — cutoffs son más estables

/**
 * Desaloja la entrada más antigua del L1 cache (política FIFO).
 * Map preserva orden de inserción en JS/TS, por lo que el primer
 * elemento es siempre el más viejo. Evita el cache stampede que
 * provocaba l1Cache.clear() al borrar todas las hot-keys de golpe.
 */
function evictOldestL1Entry(): void {
    const firstKey = l1Cache.keys().next().value;
    if (firstKey !== undefined) l1Cache.delete(firstKey);
}

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
    static async get<T>(key: string, useL1: boolean = false, l1TtlMs: number = L1_TTL_RESTRICTIONS_MS): Promise<T | null> {
        // 1. OPTIMIZACIÓN L1 (Memory): Latencia cero para hot keys
        if (useL1) {
            const entry = l1Cache.get(key);
            if (entry) {
                if (Date.now() < entry.expiresAt) return entry.data as T;
                l1Cache.delete(key);
            }
        }

        if (!isRedisAvailable()) {
            logger.warn({
                layer: 'cache',
                action: 'REDIS_FALLBACK_TRIGGERED',
                payload: { key, reason: 'Redis no disponible en get()', fallback: 'Retornando null — sistema consultará DB' },
            });
            return null;
        }

        try {
            const result = await ResilienceService.runRedis(key, async () => {
                const redis = getRedisClient();
                if (!redis) return null;

                const cached = await redis.get(key);
                if (!cached) {
                    logger.debug({ layer: 'cache', action: 'CACHE_MISS', payload: { key } });
                    return null;
                }

                const parsed = JSON.parse(cached) as T;

                // BACKFILL L1: Si se solicitó L1 y hubo hit en L2, guardar en L1 con el TTL correcto
                if (useL1) {
                    if (l1Cache.size >= MAX_L1_SIZE) evictOldestL1Entry();
                    l1Cache.set(key, { data: parsed, expiresAt: Date.now() + l1TtlMs });
                }

                return parsed;
            });
            return result ?? null;
        } catch {
            logger.warn({
                layer: 'cache',
                action: 'REDIS_FALLBACK_TRIGGERED',
                payload: { key, reason: 'Excepción en get()', fallback: 'Retornando null — sistema consultará DB' },
            });
            return null;
        }
    }

    /**
     * MGET: Obtener múltiples claves en una sola operación Redis.
     * Crítico para consolidar las validaciones de las ~7 jugadas de un ticket.
     * Devuelve un Map con key → valor (o null si no existe en caché).
     */
    static async mget<T>(keys: string[], useL1: boolean = false, l1TtlMs: number = L1_TTL_RESTRICTIONS_MS): Promise<Map<string, T | null>> {
        const result = new Map<string, T | null>();

        if (keys.length === 0) return result;

        // 1. Verificar L1 para todas las claves
        const missingKeys: string[] = [];
        if (useL1) {
            const now = Date.now();
            for (const key of keys) {
                const entry = l1Cache.get(key);
                if (entry && now < entry.expiresAt) {
                    result.set(key, entry.data as T);
                } else {
                    if (entry) l1Cache.delete(key);
                    missingKeys.push(key);
                }
            }
        } else {
            missingKeys.push(...keys);
        }

        if (missingKeys.length === 0) return result;

        // 2. Si Redis no está disponible, log de fallback y retornar nulls para las faltantes
        if (!isRedisAvailable()) {
            logger.warn({
                layer: 'cache',
                action: 'REDIS_FALLBACK_TRIGGERED',
                payload: {
                    keysCount: missingKeys.length,
                    reason: 'Redis no disponible en mget()',
                    fallback: 'Retornando nulls — sistema consultará DB para cada jugada',
                },
            });
            for (const key of missingKeys) result.set(key, null);
            return result;
        }

        try {
            const redis = getRedisClient();
            if (!redis) {
                for (const key of missingKeys) result.set(key, null);
                return result;
            }

            // Una sola operación MGET para todas las jugadas pendientes
            const values = await redis.mget(...missingKeys);

            for (let i = 0; i < missingKeys.length; i++) {
                const key = missingKeys[i];
                const raw = values[i];
                if (raw) {
                    const parsed = JSON.parse(raw) as T;
                    result.set(key, parsed);
                    // Backfill L1
                    if (useL1) {
                        if (l1Cache.size >= MAX_L1_SIZE) evictOldestL1Entry();
                        l1Cache.set(key, { data: parsed, expiresAt: Date.now() + l1TtlMs });
                    }
                } else {
                    result.set(key, null);
                }
            }
        } catch (err: any) {
            logger.warn({
                layer: 'cache',
                action: 'REDIS_FALLBACK_TRIGGERED',
                payload: {
                    keysCount: missingKeys.length,
                    reason: 'Excepción en mget()',
                    error: err.message,
                    fallback: 'Retornando nulls — sistema consultará DB',
                },
            });
            for (const key of missingKeys) result.set(key, null);
        }

        return result;
    }

    /**
     * Guardar valor en caché con TTL y opcionalmente asociarlo a tags
     */
    /**
     * Guardar valor en caché con TTL configurable.
     * @param l1TtlMs TTL en milisegundos para la capa L1 (memoria).
     *   - Restricciones de vendedor: L1_TTL_RESTRICTIONS_MS (30s)
     *   - Cutoffs: L1_TTL_CUTOFF_MS (60s)
     */
    static async set(
        key: string,
        value: any,
        ttlSeconds: number = config.redis.ttlCutoff,
        tags: string[] = [],
        useL1: boolean = false,
        l1TtlMs: number = L1_TTL_RESTRICTIONS_MS,
    ): Promise<void> {
        // 1. OPTIMIZACIÓN L1 (Memory) con TTL explícito por tipo de dato
        if (useL1) {
            if (l1Cache.size >= MAX_L1_SIZE) evictOldestL1Entry();
            l1Cache.set(key, { data: value, expiresAt: Date.now() + l1TtlMs });
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
            redis.publish('cache:invalidate', key);
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
                
                for (const k of keys) {
                    redis.publish('cache:invalidate', k);
                }
                
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
        // 1. Coalescing: Si hay una promesa en vuelo para esta misma clave, reutilizarla
        const existingPromise = inFlightPromises.get(key);
        if (existingPromise) {
            return existingPromise as Promise<T>;
        }

        const promise = (async () => {
            try {
                // 2. Intentar obtener de caché (protegido por runRedis internamente en get)
                const cached = await this.get<T>(key);
                if (cached !== null) return cached;

                // 3. Si no hay caché, ejecutar fetcher
                const result = await fetcher();

                // 4. Guardar en caché y asegurar persistencia en Redis L2
                await this.set(key, result, ttlSeconds, tags).catch((err) => {
                    logger.warn({ layer: 'cache', action: 'WRAP_SET_ERROR', payload: { key, error: err.message } });
                });

                return result;
            } finally {
                // Limpiar de promesas en vuelo al terminar
                inFlightPromises.delete(key);
            }
        })();

        inFlightPromises.set(key, promise);
        return promise;
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
                const prefix = (redis as any).options?.keyPrefix || '';
                const cleanKeys = allKeys.map(k => prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k);

                const BATCH_SIZE = 100;
                for (let i = 0; i < cleanKeys.length; i += BATCH_SIZE) {
                    const batch = cleanKeys.slice(i, i + BATCH_SIZE);
                    await redis.del(...batch);
                }
                return cleanKeys;
            }
            return [];
        } catch (error) {
            logger.warn({ layer: 'cache', action: 'DEL_PATTERN_ERROR', payload: { pattern, error: (error as Error).message } });
            return null;
        }
    }
}
