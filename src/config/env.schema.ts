// src/config/env.schema.ts
import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  
  // INFRAESTRUCTURA DE REDIS / CACHE
  REDIS_URL: z.string().url().optional(),
  CACHE_ENABLED: z.preprocess(
    (val) => val === 'true' || val === '1', 
    z.boolean()
  ).default(false),
  REDIS_CONNECT_TIMEOUT: z.coerce.number().int().default(5000),
  REDIS_TOKEN: z.string().optional(),
  CACHE_TTL_CUTOFF: z.coerce.number().int().default(300),
  CACHE_TTL_RESTRICTIONS: z.coerce.number().int().default(300),

  // RESILIENCIA / CIRCUIT BREAKERS
  RESILIENCE_ENABLED: z.preprocess(
    (val) => val === 'true' || val === '1',
    z.boolean()
  ).default(true),
  CB_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().int().min(1).max(100).default(50),
  CB_RESET_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),

  // Control de reintentos de transacciones
  TX_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  TX_BACKOFF_MIN_MS: z.coerce.number().int().min(0).default(250),
  TX_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(600),

  // Trust proxy: número de proxies confiables (0 = deshabilitado, 1 = un proxy, etc.)
  // Para Render/Heroku: 1, para nginx + load balancer: 2
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),

  // MONITOREO / OBSERVABILIDAD
  SENTRY_DSN: z.preprocess(
    (val) => (val === '' ? undefined : val),
    z.string().url().optional()
  ),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // HARDENING
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().default(6),
  EVENT_LOOP_LAG_THRESHOLD_MS: z.coerce.number().int().default(70),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(15000),
  PRISMA_CB_RESET_MS: z.coerce.number().int().default(15000),
  REDIS_CB_RESET_MS: z.coerce.number().int().default(10000),
});
