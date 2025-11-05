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
  SALES_DAILY_MAX: z.string().optional(),

  // Control de reintentos de transacciones
  TX_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  TX_BACKOFF_MIN_MS: z.coerce.number().int().min(0).default(250),
  TX_BACKOFF_MAX_MS: z.coerce.number().int().min(0).default(600),

  // Trust proxy: número de proxies confiables (0 = deshabilitado, 1 = un proxy, etc.)
  // Para Render/Heroku: 1, para nginx + load balancer: 2
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).optional(),
});
