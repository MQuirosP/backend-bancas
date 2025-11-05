import 'dotenv/config'
import dotenvSafe from 'dotenv-safe'
import path from 'path'
import { EnvSchema } from './env.schema'
import { parseCorsOrigins } from '../utils/cors'

dotenvSafe.config({
  example: path.resolve(process.cwd(), '.env.example'),
  allowEmptyValues: false,
})

const parsed = EnvSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.issues)
  process.exit(1)
}

const { allowAll, list } = parseCorsOrigins(parsed.data.CORS_ORIGIN)

export const config = {
  nodeEnv: parsed.data.NODE_ENV,
  port: parsed.data.PORT ? Number(parsed.data.PORT) : 4000,
  databaseUrl: parsed.data.DATABASE_URL,
  jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
  jwtAccessExpires: parsed.data.JWT_ACCESS_EXPIRES_IN,
  jwtRefreshExpires: parsed.data.JWT_REFRESH_EXPIRES_IN,

  // En vez de "*" guardamos la decisión ya procesada
  cors: {
    allowAll,
    origins: list, // array normalizado sin slash final
  },

  logLevel: parsed.data.LOG_LEVEL ?? 'info',
  tx: {
    // Si en tu EnvSchema son strings, conviértelas a number aquí:
    maxRetries: Number(parsed.data.TX_MAX_RETRIES),
    backoffMinMs: Number(parsed.data.TX_BACKOFF_MIN_MS),
    backoffMaxMs: Number(parsed.data.TX_BACKOFF_MAX_MS),
    isolationLevel: 'Serializable' as const,
  },
  trustProxy: parsed.data.TRUST_PROXY ?? 1, // Por defecto: 1 proxy (Render, Heroku, etc.)
}
