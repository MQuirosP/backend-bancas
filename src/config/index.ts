import 'dotenv/config';
import { parse } from 'path';
import { z } from 'zod';

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.string().optional(),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
    CORS_ORIGIN: z.string().optional(),
    LOG_LEVEL: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.issues);
    throw new Error('Invalid environment variables');
}

export const config = {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT || Number(parsed.data.PORT) || 3000,
    databaseUrl: parsed.data.DATABASE_URL,
    jwtSecret: parsed.data.JWT_SECRET,
    corsOrigin: parsed.data.CORS_ORIGIN || '*',
    logLevel: parsed.data.LOG_LEVEL || 'info',
}
