import http from 'http'
import app from './app'
import logger from '../core/logger'
import { config } from '../config'
import prisma from '../core/prismaClient'
import { getPrismaDirect } from '../core/prismaClientDirect'
import { startSorteosAutoJobs, stopSorteosAutoJobs } from '../jobs/sorteosAuto.job'
import { startAccountStatementSettlementJob, stopAccountStatementSettlementJob } from '../jobs/accountStatementSettlement.job'
import { startMonthlyClosingJob, stopMonthlyClosingJob } from '../jobs/monthlyClosing.job'
import { startRefreshTokenCleanupJob, stopRefreshTokenCleanupJob } from '../jobs/refreshTokenCleanup.job'
import { initRedisClient, closeRedisClient } from '../core/redisClient'
import { initCacheSubscriber } from '../core/cache.service'
import { restrictionCacheV2 } from '../utils/restrictionCacheV2'
import { activeOperationsService } from '../core/activeOperations.service'
import { warmupConnection } from '../core/connectionWarmup'
import { SocketService } from '../core/socket.service'
import { resourceMonitorService } from '../core/resourceMonitor.service'
import { memoryMonitorService } from '../core/memoryMonitor.service'
import { WorkerService } from '../api/v1/services/worker.service'
import { ActivityLogBuffer } from '../core/activityLogBuffer'

const server = http.createServer(app)

// Inicializar WebSocket Server
SocketService.init(server)

// Configuración de sockets TCP optimizada para Reverse Proxy (Render / Cloudflare)
server.keepAliveTimeout = 65000 // 65s (mayor a los 60s del proxy de Render para evitar race conditions)
server.headersTimeout = 66000   // 66s (debe ser mayor que keepAliveTimeout)
server.maxConnections = 1000    // Límite de sockets TCP concurrentes

// Acota el tiempo de recepción de la petición completa (headers + body)
// Si un cliente móvil sufre un corte de señal a mitad de transmitir el JSON del ticket,
// Node.js cerrará el socket a los ~12s evitando que Render espere hasta su timeout perimetral (72s).
server.requestTimeout = Math.max((config.hardening.requestTimeoutMs || 10000) + 2000, 10000)

// Backlog de 511 conexiones para absorber ráfagas simultáneas sin descartar sockets
server.listen(config.port, 511, async () => {
  logger.info({
    layer: 'server',
    action: 'SERVER_LISTEN',
    requestId: null,
    payload: {
      port: config.port,
      keepAliveTimeout: server.keepAliveTimeout,
      requestTimeout: server.requestTimeout,
      backlog: 511,
    },
  })

  // Esperar conexión a DB antes de iniciar jobs y caches que la requieren
  await warmupConnection({ context: 'server.startup', maxAttempts: 5, baseDelayMs: 2000 });

  // Iniciar monitor de event loop y pools (desactivado por default para evitar ruido)
  if (process.env.ENABLE_RESOURCE_MONITOR === 'true') {
    resourceMonitorService.start();
  }

  // Monitor de memoria opt-in (RSS, heap, new/old space y workers) para diagnóstico en producción
  if (process.env.ENABLE_MEMORY_MONITOR === 'true') {
    memoryMonitorService.start(WorkerService.getWorkersMemorySnapshot);
  }

  //  OPTIMIZACIÓN: Inicializar Redis (opcional, no bloquea el servidor)
  try {
    await initRedisClient()
    initCacheSubscriber()

    if (config.creditLimit.enabled) {
      import('../domain/credit/vendorCredit.service')
        .then(({ VendorCreditService }) => VendorCreditService.warmupCaches())
        .catch((e) => {
          logger.warn({
            layer: 'server',
            action: 'CREDIT_WARMUP_INIT_ERROR',
            meta: { error: e?.message || String(e) },
          });
        });
    }
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'REDIS_INIT_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar jobs de automatización de sorteos
  try {
    startSorteosAutoJobs()
    logger.info({
      layer: 'server',
      action: 'SORTEOS_AUTO_JOBS_STARTED',
      requestId: null,
      payload: { message: 'Jobs de automatización de sorteos iniciados' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'SORTEOS_AUTO_JOBS_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar job de asentamiento automático de account statements
  try {
    startAccountStatementSettlementJob()
    logger.info({
      layer: 'server',
      action: 'ACCOUNT_STATEMENT_SETTLEMENT_JOB_STARTED',
      requestId: null,
      payload: { message: 'Job de asentamiento automático iniciado' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'ACCOUNT_STATEMENT_SETTLEMENT_JOB_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar job de cierre mensual automático
  try {
    startMonthlyClosingJob()
    logger.info({
      layer: 'server',
      action: 'MONTHLY_CLOSING_JOB_STARTED',
      requestId: null,
      payload: { message: 'Job de cierre mensual automático iniciado' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'MONTHLY_CLOSING_JOB_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar job de limpieza de tokens revocados/expirados
  try {
    startRefreshTokenCleanupJob()
    logger.info({
      layer: 'server',
      action: 'REFRESH_TOKEN_CLEANUP_JOB_STARTED',
      requestId: null,
      payload: { message: 'Job de limpieza de tokens iniciado' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'REFRESH_TOKEN_CLEANUP_JOB_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar warming process de restriction cache V2
  try {
    restrictionCacheV2.startWarmingProcess()
    logger.info({
      layer: 'server',
      action: 'RESTRICTION_CACHE_V2_WARMING_STARTED',
      requestId: null,
      payload: { message: 'Warming process de restriction cache V2 iniciado' },
    })
  } catch (error: unknown) {
    logger.error({
      layer: 'server',
      action: 'RESTRICTION_CACHE_V2_WARMING_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Precalentar workers de renderizado térmico en segundo plano
  WorkerService.warmupWorkers().catch((error: unknown) => {
    logger.warn({
      layer: 'server',
      action: 'WORKER_WARMUP_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  });
})

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info({ layer: 'server', action: 'SHUTDOWN_INITIATED', payload: { signal } })

  // 3. Mecanismo de seguridad: 10 segundos máximo
  setTimeout(() => {
    logger.error({
      layer: 'server',
      action: 'SHUTDOWN_TIMEOUT_EXCEEDED',
      payload: { message: 'Force closing after 10s timeout' }
    })
    process.exit(1)
  }, 10000).unref()

  // ✅ Marcar que el servidor está cerrando para rechazar nuevas operaciones
  activeOperationsService.markShuttingDown()

  // Detener jobs de automatización
  try { stopSorteosAutoJobs(); } catch (e) {}
  try { stopAccountStatementSettlementJob(); } catch (e) {}
  try { stopMonthlyClosingJob(); } catch (e) {}
  try { stopRefreshTokenCleanupJob(); } catch (e) {}
  try { restrictionCacheV2.stopWarmingProcess(); } catch (e) {}
  try { resourceMonitorService.stop(); } catch (e) {}
  try { memoryMonitorService.stop(); } catch (e) {}
  try { await SocketService.close(); } catch (e) {}
  try { closeRedisClient(); } catch (e) {}

  try {
    // 2. Paso 1: server.close() para dejar de aceptar nuevo tráfico HTTP de inmediato
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) return reject(err)
        resolve()
      })
    })
    // Drenar buffer de logs de auditoría pendientes antes de desconectar Prisma
    try {
      await ActivityLogBuffer.flush()
      logger.info({ layer: 'server', action: 'ACTIVITY_LOG_BUFFER_FLUSHED' })
    } catch (e) {}

    // 2. Paso 2: prisma.$disconnect() para cerrar el pool hacia Supabase
    if ((global as any).__prismaDirect) {
      await getPrismaDirect().$disconnect()
    }
    await prisma.$disconnect()
    logger.info({ layer: 'server', action: 'PRISMA_DISCONNECTED' })

    // 2. Paso 3: process.exit(0) para salir limpiamente
    process.exit(0)
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'SHUTDOWN_ERROR',
      meta: { error: error.message },
    })
    process.exit(1)
  }
}

// 1. Agrega listeners para atrapar las señales de apagado del sistema operativo: SIGTERM y SIGINT.
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
