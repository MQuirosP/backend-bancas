import Redis from 'ioredis';
import logger from './logger';
import { config } from '../config';

/**
 * OPTIMIZACIÓN: Cliente Redis opcional con graceful degradation
 * Si Redis no está disponible o falla, el sistema funciona normalmente sin caché
 */

let redisSalesClient: Redis | null = null;
let redisGeneralClient: Redis | null = null;
export let redisSubscriber: Redis | any = null;
let redisSalesAvailable = false;
let redisGeneralAvailable = false;

// ── CIRCUIT BREAKERS AISLADOS (SALES vs GENERAL) ─────────────────────────────
// Detectan ráfagas de error (cuota Upstash 429/ECONNREFUSED) y abren el circuito
// durante 10 segundos de forma independiente para que fallos de warmup o background
// NUNCA degraden el fast-path de ventas a PostgreSQL.

const CBSales = {
  failureCount: 0,
  THRESHOLD:    5,          // Errores consecutivos para abrir el circuito
  OPEN_DURATION: 10_000,   // Tiempo abierto en ms (10 segundos)
  openUntil:    0,         // Timestamp absoluto hasta el que el circuito está abierto
};

const CBGeneral = {
  failureCount: 0,
  THRESHOLD:    5,
  OPEN_DURATION: 10_000,
  openUntil:    0,
};

/**
 * Reporta un error a Redis al circuit breaker exclusivo de ventas.
 */
export function markSalesRedisError(context?: string): void {
  CBSales.failureCount++;
  if (CBSales.failureCount >= CBSales.THRESHOLD && Date.now() > CBSales.openUntil) {
    CBSales.openUntil = Date.now() + CBSales.OPEN_DURATION;
    logger.warn({
      layer: 'redis-sales',
      action: 'CIRCUIT_BREAKER_OPENED',
      payload: {
        context,
        failureCount: CBSales.failureCount,
        openDurationMs: CBSales.OPEN_DURATION,
        openUntil: new Date(CBSales.openUntil).toISOString(),
        fallback: 'Omitiendo Redis de Ventas durante 10s — sistema usará DB directamente',
      },
    });
  }
}

/**
 * Reporta un error a Redis al circuit breaker general (warmup/reportes/background).
 */
export function markGeneralRedisError(context?: string): void {
  CBGeneral.failureCount++;
  if (CBGeneral.failureCount >= CBGeneral.THRESHOLD && Date.now() > CBGeneral.openUntil) {
    CBGeneral.openUntil = Date.now() + CBGeneral.OPEN_DURATION;
    logger.warn({
      layer: 'redis-general',
      action: 'CIRCUIT_BREAKER_OPENED',
      payload: {
        context,
        failureCount: CBGeneral.failureCount,
        openDurationMs: CBGeneral.OPEN_DURATION,
        openUntil: new Date(CBGeneral.openUntil).toISOString(),
        fallback: 'Omitiendo Redis General durante 10s',
      },
    });
  }
}

/**
 * Reporta un error al circuit breaker correspondiente según contexto (retrocompatible).
 */
export function markRedisError(context?: string): void {
  if (context && (context.includes('sales') || context.includes('ticket') || context.includes('credit'))) {
    markSalesRedisError(context);
  } else {
    markGeneralRedisError(context);
  }
}

/** Resetea el contador de errores de ventas cuando redisSalesClient se recupera */
function resetSalesCircuitBreaker(): void {
  if (CBSales.failureCount > 0) {
    CBSales.failureCount = 0;
    logger.info({ layer: 'redis-sales', action: 'CIRCUIT_BREAKER_RESET' });
  }
}

/** Resetea el contador de errores general cuando redisGeneralClient se recupera */
function resetGeneralCircuitBreaker(): void {
  if (CBGeneral.failureCount > 0) {
    CBGeneral.failureCount = 0;
    logger.info({ layer: 'redis-general', action: 'CIRCUIT_BREAKER_RESET' });
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicializar clientes Redis segregados (solo si está configurado)
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
        const isUpstashRest = config.redis.url.startsWith('https://');

        if (isUpstashRest) {
            logger.warn({ 
                layer: 'redis', 
                action: 'UPSTASH_REST_NOT_RECOMMENDED', 
                payload: { message: 'ioredis is preferred over REST for performance' } 
            });
        }

        const baseRedisOptions = {
            password: config.redis.token || undefined,
            keyPrefix: process.env.REDIS_PREFIX ?? (process.env.NODE_ENV === 'production' ? 'prod:' : 'local:'),
            connectTimeout: config.redis.connectTimeout,
            enableReadyCheck: true,
            lazyConnect: true,
        };

        const retryStrategy = (times: number) => {
            if (times === 4 || times % 15 === 0) {
                logger.warn({ layer: 'redis', action: 'RECONNECT_RETRYING', payload: { attempts: times } });
            }
            // Nunca retornar null: retornar null aborta permanentemente la reconexión de ioredis
            return Math.min(times * 200, 3000);
        };

        // 1. Cliente Fast-Path exclusivo de Ventas y /status/me en caliente
        redisSalesClient = new Redis(config.redis.url, {
            ...baseRedisOptions,
            retryStrategy,
            maxRetriesPerRequest: 1,
            commandTimeout: 1500,    // 1500ms: tolera pausas de CPU/Event-Loop lag sin degradar en falso
            enableOfflineQueue: false,
        });

        // 2. Cliente General para Warmup, reportes, cierres, background e invalidaciones
        redisGeneralClient = new Redis(config.redis.url, {
            ...baseRedisOptions,
            retryStrategy,
            maxRetriesPerRequest: 2,
            commandTimeout: 3000,    // 3000ms: tolera transferencias y pipelines masivos
            enableOfflineQueue: true,
        });

        // 3. Cliente duplicado exclusivo para Pub/Sub
        redisSubscriber = redisGeneralClient.duplicate({
            enableOfflineQueue: true,
        });
        redisSubscriber.on('error', (err: any) => {
            logger.warn({ layer: 'redis', action: 'SUBSCRIBER_ERROR', payload: { error: err.message } });
        });

        // Event handlers Sales Client
        redisSalesClient.on('error', (err: Error) => {
            if (redisSalesAvailable) {
                logger.error({ layer: 'redis-sales', action: 'ERROR', payload: { error: err.message } });
            }
            redisSalesAvailable = false;
            markSalesRedisError('redisSalesClient.on(error)');
        });

        redisSalesClient.on('connect', () => {
            logger.info({ layer: 'redis-sales', action: 'CONNECTED' });
        });

        redisSalesClient.on('ready', () => {
            logger.info({ layer: 'redis-sales', action: 'READY' });
            redisSalesAvailable = true;
            resetSalesCircuitBreaker();
        });

        redisSalesClient.on('close', () => {
            if (redisSalesAvailable) {
                logger.warn({ layer: 'redis-sales', action: 'CLOSED' });
            }
            redisSalesAvailable = false;
        });

        redisSalesClient.on('reconnecting', (ms: number) => {
            logger.info({ layer: 'redis-sales', action: 'RECONNECTING', payload: { waitMs: ms } });
        });

        // Event handlers General Client
        redisGeneralClient.on('error', (err: Error) => {
            if (redisGeneralAvailable) {
                logger.error({ layer: 'redis-general', action: 'ERROR', payload: { error: err.message } });
            }
            redisGeneralAvailable = false;
            markGeneralRedisError('redisGeneralClient.on(error)');
        });

        redisGeneralClient.on('connect', () => {
            logger.info({ layer: 'redis-general', action: 'CONNECTED' });
        });

        redisGeneralClient.on('ready', () => {
            logger.info({ layer: 'redis-general', action: 'READY' });
            redisGeneralAvailable = true;
            resetGeneralCircuitBreaker();
        });

        redisGeneralClient.on('close', () => {
            if (redisGeneralAvailable) {
                logger.warn({ layer: 'redis-general', action: 'CLOSED' });
            }
            redisGeneralAvailable = false;
        });

        redisGeneralClient.on('reconnecting', (ms: number) => {
            logger.info({ layer: 'redis-general', action: 'RECONNECTING', payload: { waitMs: ms } });
        });

        // Intentar conectar los clientes concurrentemente con timeout
        await Promise.race([
            Promise.all([
                redisSalesClient.connect(),
                redisGeneralClient.connect(),
                redisSubscriber.connect().catch((err: any) => {
                    logger.warn({ layer: 'redis', action: 'SUBSCRIBER_CONNECT_FAIL', payload: { error: err.message } });
                }),
            ]),
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
        redisSalesClient = null;
        redisGeneralClient = null;
        redisSalesAvailable = false;
        redisGeneralAvailable = false;
    }
}

/**
 * Obtener cliente Redis exclusivo para Fast-Path de ventas
 */
export function getRedisSalesClient(): Redis | null {
    return redisSalesAvailable ? redisSalesClient : null;
}

/**
 * Obtener cliente Redis para reportes, warmup, sync y tareas administrativas
 */
export function getRedisGeneralClient(): Redis | null {
    return redisGeneralAvailable ? redisGeneralClient : null;
}

/**
 * Obtener cliente Redis (alias retrocompatible hacia General Client)
 */
export function getRedisClient(): Redis | null {
    return getRedisGeneralClient();
}

/**
 * Verificar si Redis de Ventas está disponible y listo.
 */
export function isRedisSalesAvailable(): boolean {
  if (CBSales.failureCount >= CBSales.THRESHOLD && Date.now() < CBSales.openUntil) {
    return false; // Circuito de ventas abierto — derivar a DB
  }
  return redisSalesAvailable && redisSalesClient?.status === 'ready';
}

/**
 * Verificar si Redis General está disponible y listo.
 */
export function isRedisAvailable(): boolean {
  if (CBGeneral.failureCount >= CBGeneral.THRESHOLD && Date.now() < CBGeneral.openUntil) {
    return false; // Circuito general abierto
  }
  return redisGeneralAvailable && redisGeneralClient?.status === 'ready';
}

/**
 * Cerrar conexiones Redis de forma graciosa
 */
export async function closeRedisClient(): Promise<void> {
    try {
        if (redisSalesClient) {
            await redisSalesClient.quit();
            redisSalesClient = null;
            redisSalesAvailable = false;
        }
        if (redisGeneralClient) {
            await redisGeneralClient.quit();
            redisGeneralClient = null;
            redisGeneralAvailable = false;
        }
        if (redisSubscriber) {
            await redisSubscriber.quit();
            redisSubscriber = null;
        }
        logger.info({ layer: 'redis', action: 'DISCONNECTED' });
    } catch (error) {
        logger.error({
            layer: 'redis',
            action: 'DISCONNECT_ERROR',
            payload: { error: (error as Error).message }
        });
    }
}
