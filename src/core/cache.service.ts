import { getRedisClient, isRedisAvailable } from './redisClient';
import logger from './logger';

/**
 * ✅ OPTIMIZACIÓN: Servicio de caché genérico con graceful degradation
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
     * @param pattern Patrón de claves (ej: "cutoff:*")
     */
    static async delPattern(pattern: string): Promise<void> {
        if (!isRedisAvailable()) {
            return;
        }

        const redis = getRedisClient();
        if (!redis) {
            return;
        }

        try {
            const keys = await redis.keys(pattern);
            if (keys.length > 0) {
                await redis.del(...keys);
            }
        } catch (error) {
            logger.warn({
                layer: 'cache',
                action: 'DEL_PATTERN_ERROR',
                payload: { pattern, error: (error as Error).message }
            });
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
