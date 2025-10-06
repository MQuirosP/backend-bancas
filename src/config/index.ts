// src/config/index.ts
import 'dotenv/config';
import dotenvSafe from 'dotenv-safe';
import path from 'path';
import { EnvSchema } from './env.schema';

dotenvSafe.config({
  example: path.resolve(process.cwd(), '.env.example'),
  allowEmptyValues: false,
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // usa .issues de Zod en lugar de .format()
  console.error('Invalid environment variables:', parsed.error.issues);
  process.exit(1);
}

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT ? Number(parsed.data.PORT) : 4000,
  databaseUrl: parsed.data.DATABASE_URL,
  jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
  jwtAccessExpires: parsed.data.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpires: parsed.data.JWT_REFRESH_EXPIRES_IN,
  corsOrigin: parsed.data.CORS_ORIGIN ?? '*',
  logLevel: parsed.data.LOG_LEVEL ?? 'info',
};
