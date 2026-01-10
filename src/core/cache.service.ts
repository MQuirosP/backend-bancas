import { getRedisClient, isRedisAvailable } from './redisClient';
import logger from './logger';

/**
 *  OPTIMIZACIÓN: Servicio de caché genérico con graceful degradation
 * 
 * - Si Redis no está disponible → retorna null (sin caché)
 * - Si Redis falla → retorna null (sin caché)
 * - El sistema funciona normalmente sin Redis
 */
export class CacheService {
    /**
     * Obtener valor del caché
     * @returns Valor cacheado o null si no existe o Redis no disponible
     */
    static async get<T>(key: string): Promise<T | null> {
        if (!isRedisAvailable()) {
            return null;
        }

        const redis = getRedisClient();
        if (!redis) {
            return null;
        }

        try {
            const cached = await redis.get(key);
            if (!cached) {
                return null;
            }

            return JSON.parse(cached) as T;
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'GET_ERROR',
                payload: { key, error: (error as Error).message }
            });
            return null;
        }
    }

    /**
     * Guardar valor en caché con TTL
     * @param key Clave del caché
     * @param value Valor a cachear
     * @param ttlSeconds TTL en segundos (default: 300 = 5 minutos)
     */
    static async set(key: string, value: any, ttlSeconds: number = 300): Promise<void> {
        if (!isRedisAvailable()) {
            return;
        }

        const redis = getRedisClient();
        if (!redis) {
            return;
        }

        try {
            await redis.setex(key, ttlSeconds, JSON.stringify(value));
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'SET_ERROR',
                payload: { key, error: (error as Error).message }
            });
        }
    }

    /**
     * Eliminar valor del caché
     */
    static async del(key: string): Promise<void> {
        if (!isRedisAvailable()) {
            return;
        }

        const redis = getRedisClient();
        if (!redis) {
            return;
        }

        try {
            await redis.del(key);
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'DEL_ERROR',
                payload: { key, error: (error as Error).message }
            });
        }
    }

    /**
     * Eliminar múltiples claves por patrón
     * ✅ OPTIMIZACIÓN: Usa SCAN en lugar de KEYS para no bloquear el event loop
     * @param pattern Patrón de claves (ej: "cutoff:*")
     * @returns Array de claves eliminadas (para logging)
     */
    static async delPattern(pattern: string): Promise<string[] | null> {
        if (!isRedisAvailable()) {
            return null;
        }

        const redis = getRedisClient();
        if (!redis) {
            return null;
        }

        try {
            const allKeys: string[] = [];
            let cursor = '0';

            // ✅ CRÍTICO: Usar SCAN en lugar de KEYS para evitar bloquear el event loop
            // SCAN es iterativo y no bloquea, mientras que KEYS bloquea hasta terminar
            do {
                // SCAN retorna [cursor, keys[]]
                const [newCursor, keys] = await redis.scan(
                    cursor,
                    'MATCH',
                    pattern,
                    'COUNT',
                    100 // Procesar 100 claves por iteración
                );

                cursor = newCursor;
                allKeys.push(...keys);

            } while (cursor !== '0');

            // Eliminar las claves encontradas
            if (allKeys.length > 0) {
                // ✅ OPTIMIZACIÓN: Eliminar en batches de 100 para evitar sobrecargar Redis
                const BATCH_SIZE = 100;
                for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
                    const batch = allKeys.slice(i, i + BATCH_SIZE);
                    await redis.del(...batch);
                }

                logger.debug({
                    layer: 'cache',
                    action: 'DEL_PATTERN_SUCCESS',
                    payload: {
                        pattern,
                        deletedCount: allKeys.length,
                        batches: Math.ceil(allKeys.length / BATCH_SIZE)
                    }
                });

                return allKeys;
            }

            return [];
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'DEL_PATTERN_ERROR',
                payload: { pattern, error: (error as Error).message }
            });
            return null;
        }
    }

    /**
     * Verificar si una clave existe
     */
    static async exists(key: string): Promise<boolean> {
        if (!isRedisAvailable()) {
            return false;
        }

        const redis = getRedisClient();
        if (!redis) {
            return false;
        }

        try {
            const result = await redis.exists(key);
            return result === 1;
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'EXISTS_ERROR',
                payload: { key, error: (error as Error).message }
            });
            return false;
        }
    }
}
