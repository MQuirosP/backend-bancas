import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import logger from '../core/logger';

/**
 * Configuración base para Rate Limiters
 */
const createLimiter = (options: {
  windowMs: number;
  max: number;
  prefix: string;
  message: string;
  keyGenerator?: (req: any) => string;
}) => {
  const store = isRedisAvailable()
    ? new RedisStore({
        // @ts-ignore - ioredis es compatible
        sendCommand: (...args: string[]) => getRedisClient()?.call(...args),
        prefix: `rl:${options.prefix}:`,
      })
    : undefined;

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: options.keyGenerator,
    // CAMBIO AQUÍ: Usamos un booleano simple o deshabilitamos la validación que da problemas
    validate: { ip: false }, 
    handler: (req, res, _next, limiterOptions) => {
      logger.warn({
        layer: 'middleware',
        action: 'RATE_LIMIT_HIT',
        payload: {
          ip: req.ip,
          path: req.path,
          userId: (req as any).user?.id,
          type: options.prefix 
        }
      });

      res.status(429).json({
        status: 'error',
        statusCode: 429,
        message: options.message,
        retryAfter: Math.ceil(limiterOptions.windowMs / 1000)
      });
    }
  });
};

/**
 * 1. Límite Global: 100 peticiones / minuto por IP
 */
export const globalRateLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 100,
  prefix: 'global',
  message: 'Demasiadas peticiones. Por favor, intenta de nuevo en un minuto.'
});

/**
 * 2. Auth (Login): 5 intentos / minuto por IP
 */
export const authRateLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 5,
  prefix: 'auth',
  message: 'Demasiados intentos de inicio de sesión. Por favor, intenta de nuevo en un minuto.'
});

/**
 * 3. Ventas (Tickets): 20 tickets / minuto por UserID (o IP si no hay user)
 */
export const salesRateLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 20,
  prefix: 'sales',
  message: 'Límite de ventas por minuto alcanzado. Por favor, espera un momento.',
  keyGenerator: (req) => (req as any).user?.id || ipKeyGenerator(req) || 'unknown'
});