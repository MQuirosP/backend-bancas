import Redis from 'ioredis';
import logger from './logger';
import { config } from '../config';

/**
 * OPTIMIZACIÓN: Cliente Redis opcional con graceful degradation
 * Si Redis no está disponible o falla, el sistema funciona normalmente sin caché
 */

let redisClient: Redis | any = null;
let redisAvailable = false;

/**
 * Inicializar cliente Redis (solo si está configurado)
 */
export async function initRedisClient(): Promise<void> {
    // Si caché está deshabilitado, no hacer nada
    if (!config.redis.enabled) {
        logger.info({ layer: 'redis', action: 'DISABLED', payload: { message: 'Cache is disabled' } });
        return;
    }

    // Si no hay configuración de Redis, no hacer nada
    if (!config.redis.url) {
        logger.info({ layer: 'redis', action: 'NOT_CONFIGURED', payload: { message: 'Redis URL not configured' } });
        return;
    }

    try {
        // OPTIMIZACIÓN: Detectar si es Upstash REST API (URL empieza con https://)
        // Nota: ioredis no soporta REST directamente, pero mantenemos la lógica por si se usa fetch
        const isUpstashRest = config.redis.url.startsWith('https://');

        if (isUpstashRest) {
            // Se asume que REDIS_TOKEN viene en la URL o se maneja aparte. 
            // En este codebase parece que se esperaba REDIS_TOKEN. 
            // Como estamos estandarizando a ioredis para performance, 
            // si es HTTPS usaremos un wrapper compatible o fallaremos a ioredis si la URL es transformable.
            
            logger.warn({ 
                layer: 'redis', 
                action: 'UPSTASH_REST_NOT_RECOMMENDED', 
                payload: { message: 'ioredis is preferred over REST for performance' } 
            });
            // (Mantenemos compatibilidad con el esquema anterior si es necesario, 
            // pero para BE-2 priorizamos ioredis)
        }

        // Crear cliente Redis estándar con ioredis
        redisClient = new Redis(config.redis.url, {
            password: config.redis.token, // Usar REDIS_TOKEN si está disponible
            connectTimeout: config.redis.connectTimeout,
            retryStrategy: (times: number) => {
                if (times > 3) {
                    logger.warn({ layer: 'redis', action: 'MAX_RETRIES_REACHED', payload: { attempts: times } });
                    return null; // Stop retrying
                }
                const delay = Math.min(times * 200, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true, // No conectar inmediatamente hasta init()
            commandTimeout: 2000, // Timeout para comandos individuales
        });

        // Event handlers
        redisClient.on('error', (err: Error) => {
            // Evitamos loguear errores de conexión repetitivos si ya sabemos que está caído
            if (redisAvailable) {
                logger.error({ layer: 'redis', action: 'ERROR', payload: { error: err.message } });
            }
            redisAvailable = false;
        });

        redisClient.on('connect', () => {
            logger.info({ layer: 'redis', action: 'CONNECTED' });
        });

        redisClient.on('ready', () => {
            logger.info({ layer: 'redis', action: 'READY' });
            redisAvailable = true;
        });

        redisClient.on('close', () => {
            if (redisAvailable) {
                logger.warn({ layer: 'redis', action: 'CLOSED' });
            }
            redisAvailable = false;
        });

        redisClient.on('reconnecting', (ms: number) => {
            logger.info({ layer: 'redis', action: 'RECONNECTING', payload: { waitMs: ms } });
        });

        // Intentar conectar con timeout
        await Promise.race([
            redisClient.connect(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis connection timeout')), config.redis.connectTimeout)
            )
        ]);

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
export function getRedisClient(): Redis | null {
    return redisAvailable ? redisClient : null;
}

/**
 * Verificar si Redis está disponible y listo
 */
export function isRedisAvailable(): boolean {
    return redisAvailable && redisClient?.status === 'ready';
}

/**
 * Cerrar conexión Redis de forma graciosa
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
