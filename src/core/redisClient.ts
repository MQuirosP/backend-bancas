import logger from './logger';

// ✅ OPTIMIZACIÓN: Cliente Redis opcional con graceful degradation
// Si Redis no está disponible o falla, el sistema funciona normalmente sin caché

let redisClient: any = null;
let redisAvailable = false;

/**
 * Inicializar cliente Redis (solo si está configurado)
 */
export async function initRedisClient(): Promise<void> {
    // Si caché está deshabilitado, no hacer nada
    if (process.env.CACHE_ENABLED !== 'true') {
        logger.info({ layer: 'redis', action: 'DISABLED', payload: { message: 'Cache is disabled' } });
        return;
    }

    // Si no hay configuración de Redis, no hacer nada
    if (!process.env.REDIS_URL || !process.env.REDIS_TOKEN) {
        logger.info({ layer: 'redis', action: 'NOT_CONFIGURED', payload: { message: 'Redis not configured' } });
        return;
    }

    try {
        // ✅ OPTIMIZACIÓN: Detectar si es Upstash REST API (URL empieza con https://)
        const isUpstashRest = process.env.REDIS_URL?.startsWith('https://');

        if (isUpstashRest) {
            // Para Upstash REST API, crear un cliente simple basado en fetch
            logger.info({ layer: 'redis', action: 'UPSTASH_REST_MODE', payload: { message: 'Using Upstash REST API' } });

            redisClient = {
                // Implementación simple de comandos Redis sobre REST API de Upstash
                async get(key: string) {
                    const response = await fetch(`${process.env.REDIS_URL}/get/${encodeURIComponent(key)}`, {
                        headers: { 'Authorization': `Bearer ${process.env.REDIS_TOKEN}` }
                    });
                    const data = await response.json();
                    return data.result;
                },
                async setex(key: string, seconds: number, value: string) {
                    await fetch(`${process.env.REDIS_URL}/setex/${encodeURIComponent(key)}/${seconds}`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${process.env.REDIS_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(value)
                    });
                },
                async del(...keys: string[]) {
                    for (const key of keys) {
                        await fetch(`${process.env.REDIS_URL}/del/${encodeURIComponent(key)}`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${process.env.REDIS_TOKEN}` }
                        });
                    }
                },
                async keys(pattern: string) {
                    const response = await fetch(`${process.env.REDIS_URL}/keys/${encodeURIComponent(pattern)}`, {
                        headers: { 'Authorization': `Bearer ${process.env.REDIS_TOKEN}` }
                    });
                    const data = await response.json();
                    return data.result || [];
                },
                async exists(key: string) {
                    const response = await fetch(`${process.env.REDIS_URL}/exists/${encodeURIComponent(key)}`, {
                        headers: { 'Authorization': `Bearer ${process.env.REDIS_TOKEN}` }
                    });
                    const data = await response.json();
                    return data.result;
                },
                async quit() {
                    // No-op para REST API
                }
            };

            redisAvailable = true;
            logger.info({ layer: 'redis', action: 'READY' });
            return;
        }

        // Para Redis estándar (no-Upstash), usar ioredis
        let Redis: any = null;
        try {
            Redis = require('ioredis');
        } catch {
            logger.warn({ layer: 'redis', action: 'NOT_INSTALLED', payload: { message: 'ioredis not installed, cache disabled' } });
            return;
        }

        if (!Redis) {
            return;
        }

        // Crear cliente Redis estándar
        const url = new URL(process.env.REDIS_URL);
        redisClient = new Redis({
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            password: process.env.REDIS_TOKEN,
            tls: url.protocol === 'rediss:' ? {} : undefined,
            retryStrategy: (times: number) => {
                if (times > 3) {
                    logger.warn({ layer: 'redis', action: 'MAX_RETRIES', payload: { attempts: times } });
                    return null;
                }
                return Math.min(times * 100, 2000);
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true,
        });

        // Event handlers
        redisClient.on('error', (err: Error) => {
            logger.error({ layer: 'redis', action: 'ERROR', payload: { error: err.message } });
            redisAvailable = false;
        });

        redisClient.on('connect', () => {
            logger.info({ layer: 'redis', action: 'CONNECTED' });
            redisAvailable = true;
        });

        redisClient.on('ready', () => {
            logger.info({ layer: 'redis', action: 'READY' });
            redisAvailable = true;
        });

        redisClient.on('close', () => {
            logger.warn({ layer: 'redis', action: 'CLOSED' });
            redisAvailable = false;
        });

        // Conectar
        await redisClient.connect();

    } catch (error) {
        logger.error({
            layer: 'redis',
            action: 'INIT_ERROR',
            payload: { error: (error as Error).message }
        });
        redisClient = null;
        redisAvailable = false;
    }
}

/**
 * Obtener cliente Redis (puede ser null si no está disponible)
 */
export function getRedisClient(): any | null {
    return redisAvailable ? redisClient : null;
}

/**
 * Verificar si Redis está disponible
 */
export function isRedisAvailable(): boolean {
    return redisAvailable;
}

/**
 * Cerrar conexión Redis
 */
export async function closeRedisClient(): Promise<void> {
    if (redisClient) {
        try {
            await redisClient.quit();
            logger.info({ layer: 'redis', action: 'DISCONNECTED' });
        } catch (error) {
            logger.error({
                layer: 'redis',
                action: 'DISCONNECT_ERROR',
                payload: { error: (error as Error).message }
            });
        } finally {
            redisClient = null;
            redisAvailable = false;
        }
    }
}
