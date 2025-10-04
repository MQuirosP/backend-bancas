// src/config/env.schema.ts
import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});
