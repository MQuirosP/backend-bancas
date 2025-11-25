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
        // Importar ioredis dinámicamente (solo si está instalado)
        // Usar require dinámico para evitar error de compilación si no está instalado
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

        // Crear cliente Redis
        const url = new URL(process.env.REDIS_URL);
        redisClient = new Redis({
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            password: process.env.REDIS_TOKEN,
            tls: url.protocol === 'rediss:' ? {} : undefined,
            retryStrategy: (times: number) => {
                if (times > 3) {
                    logger.warn({ layer: 'redis', action: 'MAX_RETRIES', payload: { attempts: times } });
                    return null; // Stop retrying
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
