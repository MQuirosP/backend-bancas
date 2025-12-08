import http from 'http'
import app from './app'
import logger from '../core/logger'
import { config } from '../config'
import prisma from '../core/prismaClient'
import { startSorteosAutoJobs, stopSorteosAutoJobs } from '../jobs/sorteosAuto.job'
import { startAccountStatementSettlementJob, stopAccountStatementSettlementJob } from '../jobs/accountStatementSettlement.job'
import { initRedisClient, closeRedisClient } from '../core/redisClient'

const server = http.createServer(app)

server.listen(config.port, async () => {
  logger.info({
    layer: 'server',
    action: 'SERVER_LISTEN',
    requestId: null,
    payload: { port: config.port },
  })

  // ✅ OPTIMIZACIÓN: Inicializar Redis (opcional, no bloquea el servidor)
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
})

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info({ layer: 'server', action: 'SHUTDOWN_INITIATED', payload: { signal } })

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

  // ✅ OPTIMIZACIÓN: Cerrar conexión Redis
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
