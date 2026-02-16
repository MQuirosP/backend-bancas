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
import { startSorteoCacheCleanup, stopSorteoCacheCleanup } from '../utils/sorteoCache'
import { startCommissionCacheCleanup, stopCommissionCacheCleanup } from '../utils/commissionCache'
import { restrictionCacheV2 } from '../utils/restrictionCacheV2'
import { activeOperationsService } from '../core/activeOperations.service'

const server = http.createServer(app)

server.listen(config.port, async () => {
  logger.info({
    layer: 'server',
    action: 'SERVER_LISTEN',
    requestId: null,
    payload: { port: config.port },
  })

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

  // ✅ CRÍTICO: Marcar que el servidor está cerrando para rechazar nuevas operaciones
  activeOperationsService.markShuttingDown()

  // ✅ OPTIMIZACIÓN: Esperar a que terminen las operaciones activas (máximo 30 segundos)
  const allCompleted = await activeOperationsService.waitForCompletion(30000)
  if (!allCompleted) {
    logger.warn({
      layer: 'server',
      action: 'SHUTDOWN_FORCED',
      payload: {
        message: 'Some operations did not complete within timeout, forcing shutdown',
        remainingOperations: activeOperationsService.getActiveCount()
      }
    })
  }

  // Detener jobs de automatización
  try {
    stopSorteosAutoJobs()
    logger.info({ layer: 'server', action: 'SORTEOS_AUTO_JOBS_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'SORTEOS_AUTO_JOBS_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Detener job de asentamiento automático
  try {
    stopAccountStatementSettlementJob()
    logger.info({ layer: 'server', action: 'ACCOUNT_STATEMENT_SETTLEMENT_JOB_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'ACCOUNT_STATEMENT_SETTLEMENT_JOB_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Detener job de cierre mensual automático
  try {
    stopMonthlyClosingJob()
    logger.info({ layer: 'server', action: 'MONTHLY_CLOSING_JOB_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'MONTHLY_CLOSING_JOB_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Detener cleanup de sorteo cache
  try {
    stopSorteoCacheCleanup()
    logger.info({ layer: 'server', action: 'SORTEO_CACHE_CLEANUP_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'SORTEO_CACHE_CLEANUP_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Detener cleanup de commission cache
  try {
    stopCommissionCacheCleanup()
    logger.info({ layer: 'server', action: 'COMMISSION_CACHE_CLEANUP_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'COMMISSION_CACHE_CLEANUP_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  // Detener warming process de restriction cache V2
  try {
    restrictionCacheV2.stopWarmingProcess()
    logger.info({ layer: 'server', action: 'RESTRICTION_CACHE_V2_WARMING_STOPPED' })
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'RESTRICTION_CACHE_V2_WARMING_STOP_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  //  OPTIMIZACIÓN: Cerrar conexión Redis
  try {
    await closeRedisClient()
  } catch (error: any) {
    logger.warn({
      layer: 'server',
      action: 'REDIS_CLOSE_ERROR',
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }

  server.close(async (err) => {
    if (err) {
      logger.error({
        layer: 'server',
        action: 'SERVER_CLOSE_ERROR',
        meta: { error: (err as Error).message },
      })
      process.exit(1)
    }

    try {
      // Desconectar prismaDirect si fue inicializado (lazy load)
      if ((global as any).__prismaDirect) {
        await getPrismaDirect().$disconnect()
        logger.info({ layer: 'server', action: 'PRISMA_DIRECT_DISCONNECTED' })
      }
    } catch (e) {
      logger.warn({
        layer: 'server',
        action: 'PRISMA_DIRECT_DISCONNECT_ERROR',
        meta: { error: (e as Error).message },
      })
    }

    try {
      await prisma.$disconnect()
      logger.info({ layer: 'server', action: 'PRISMA_DISCONNECTED' })
      process.exit(0)
    } catch (e) {
      logger.error({
        layer: 'server',
        action: 'PRISMA_DISCONNECT_ERROR',
        meta: { error: (e as Error).message },
      })
      process.exit(1)
    }
  })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
