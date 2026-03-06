import 'dotenv/config'
import dotenvSafe from 'dotenv-safe'
import path from 'path'
import { EnvSchema } from './env.schema'
import { parseCorsOrigins } from '../utils/cors'

// dotenv-safe solo aplica en desarrollo/test para detectar variables faltantes en .env
// En producción las variables ya vienen del entorno del servidor (Render, etc.)
if (process.env.NODE_ENV !== 'production') {
  dotenvSafe.config({
    example: path.resolve(process.cwd(), '.env.example'),
    allowEmptyValues: true, // Permite variables opcionales como REDIS_URL, REDIS_TOKEN
  })
}

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
  
  // Redis configuration
  redis: {
    url: parsed.data.REDIS_URL,
    token: parsed.data.REDIS_TOKEN,
    enabled: parsed.data.CACHE_ENABLED,
    connectTimeout: parsed.data.REDIS_CONNECT_TIMEOUT,
    ttlCutoff: parsed.data.CACHE_TTL_CUTOFF,
    ttlRestrictions: parsed.data.CACHE_TTL_RESTRICTIONS,
  },
  resilience: {
    enabled: parsed.data.RESILIENCE_ENABLED,
    errorThresholdPercentage: parsed.data.CB_ERROR_THRESHOLD_PERCENTAGE,
    resetTimeoutMs: parsed.data.CB_RESET_TIMEOUT_MS,
  },
  sentry: {
    dsn: parsed.data.SENTRY_DSN,
    tracesSampleRate: parsed.data.SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: parsed.data.SENTRY_PROFILES_SAMPLE_RATE,
  },
  hardening: {
    maxConcurrentRequests: parsed.data.MAX_CONCURRENT_REQUESTS,
    eventLoopLagThresholdMs: parsed.data.EVENT_LOOP_LAG_THRESHOLD_MS,
    requestTimeoutMs: parsed.data.REQUEST_TIMEOUT_MS,
    prismaCbResetMs: parsed.data.PRISMA_CB_RESET_MS,
    redisCbResetMs: parsed.data.REDIS_CB_RESET_MS,
  },
}
