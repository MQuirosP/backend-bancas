import { z } from 'zod';

const parseBooleanWithDefault = (fallback: boolean) =>
  z.preprocess((val) => {
    if (val === undefined || val === '') return fallback;
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
  }, z.boolean());

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // REDIS / CACHE
  REDIS_URL: z.url().optional(),
  CACHE_ENABLED: parseBooleanWithDefault(false),
  REDIS_CONNECT_TIMEOUT: z.coerce.number().int().default(2000),
  REDIS_TOKEN: z.string().optional(),
  CACHE_TTL_CUTOFF: z.coerce.number().int().default(300),
  CACHE_TTL_RESTRICTIONS: z.coerce.number().int().default(300),
  IDEMPOTENCY_STRICT_MODE: parseBooleanWithDefault(true),

  // RESILIENCIA / CIRCUIT BREAKERS
  RESILIENCE_ENABLED: parseBooleanWithDefault(true),
  CB_ERROR_THRESHOLD_PERCENTAGE: z.coerce.number().int().min(1).max(100).default(50),
  CB_RESET_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  // TRANSACCIONES & RETRIES
  TX_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  TX_BACKOFF_MIN_MS: z.coerce.number().int().min(0).default(200),
  TX_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(600),

  // TRUST PROXY
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),

  // MONITOREO
  SENTRY_DSN: z.preprocess((val) => (val === '' ? undefined : val), z.url().optional()),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.02),

  // HARDENING
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().default(200),
  EVENT_LOOP_LAG_THRESHOLD_MS: z.coerce.number().int().default(150),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().default(8000),
  PRISMA_CB_RESET_MS: z.coerce.number().int().default(15000),
  REDIS_CB_RESET_MS: z.coerce.number().int().default(10000),

  // POOL SEGREGATION
  SALES_POOL_MAX: z.coerce.number().int().min(1).default(8),
  GENERAL_POOL_MAX: z.coerce.number().int().min(1).default(17),
});