import http from 'http'
import app from './app'
import logger from '../core/logger'
import { config } from '../config'
import prisma from '../core/prismaClient'
import { getPrismaDirect } from '../core/prismaClientDirect'
import { startSorteosAutoJobs, stopSorteosAutoJobs } from '../jobs/sorteosAuto.job'
import { startAccountStatementSettlementJob, stopAccountStatementSettlementJob } from '../jobs/accountStatementSettlement.job'
import { startMonthlyClosingJob, stopMonthlyClosingJob } from '../jobs/monthlyClosing.job'
import { initRedisClient, closeRedisClient } from '../core/redisClient'
import { initCacheSubscriber } from '../core/cache.service'
import { startSorteoCacheCleanup, stopSorteoCacheCleanup } from '../utils/sorteoCache'
import { startCommissionCacheCleanup, stopCommissionCacheCleanup } from '../utils/commissionCache'
import { restrictionCacheV2 } from '../utils/restrictionCacheV2'
import { activeOperationsService } from '../core/activeOperations.service'
import { isExclusionListEmpty } from '../core/exclusionListCache'
import { warmupConnection } from '../core/connectionWarmup'

const server = http.createServer(app)

// Configuración de sockets TCP optimizada para Reverse Proxy (Render / Cloudflare)
server.keepAliveTimeout = 65000 // 65s (mayor a los 60s del proxy de Render para evitar race conditions)
server.headersTimeout = 66000   // 66s (debe ser mayor que keepAliveTimeout)
server.maxConnections = 1000    // Límite de sockets TCP concurrentes

// Backlog de 511 conexiones para absorber ráfagas simultáneas sin descartar sockets
server.listen(config.port, 511, async () => {
  logger.info({
    layer: 'server',
    action: 'SERVER_LISTEN',
    requestId: null,
    payload: { port: config.port, keepAliveTimeout: server.keepAliveTimeout, backlog: 511 },
  })

  // Esperar conexión a DB antes de iniciar jobs y caches que la requieren
  await warmupConnection({ context: 'server.startup', maxAttempts: 5, baseDelayMs: 2000 });

  //  OPTIMIZACIÓN: Inicializar Redis (opcional, no bloquea el servidor)
  try {
    await initRedisClient()
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

  // Iniciar cleanup de sorteo cache
  try {
    startSorteoCacheCleanup()
    logger.info({
      layer: 'server',
      action: 'SORTEO_CACHE_CLEANUP_STARTED',
      requestId: null,
      payload: { message: 'Cleanup de sorteo cache iniciado' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'SORTEO_CACHE_CLEANUP_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Iniciar cleanup de commission cache
  try {
    startCommissionCacheCleanup()
    logger.info({
      layer: 'server',
      action: 'COMMISSION_CACHE_CLEANUP_STARTED',
      requestId: null,
      payload: { message: 'Cleanup de commission cache iniciado' },
    })
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'COMMISSION_CACHE_CLEANUP_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Pre-cargar cache de lista de exclusión (evita scans en caliente)
  try {
    await isExclusionListEmpty()
    logger.info({
      layer: 'server',
      action: 'EXCLUSION_LIST_CACHE_WARMED',
      requestId: null,
      payload: { message: 'Cache de lista de exclusión inicializado' },
    })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'EXCLUSION_LIST_CACHE_WARM_ERROR',
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
  } catch (error: any) {
    logger.error({
      layer: 'server',
      action: 'RESTRICTION_CACHE_V2_WARMING_START_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
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
  try { stopSorteoCacheCleanup(); } catch (e) {}
  try { stopCommissionCacheCleanup(); } catch (e) {}
  try { restrictionCacheV2.stopWarmingProcess(); } catch (e) {}
  try { closeRedisClient(); } catch (e) {}

  try {
    // 2. Paso 1: server.close() para dejar de aceptar nuevo tráfico HTTP de inmediato
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => {
        if (err) return reject(err)
        resolve()
      })
    })
    logger.info({ layer: 'server', action: 'SERVER_CLOSED' })

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
