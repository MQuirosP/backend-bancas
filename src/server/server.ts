import http from 'http'
import app from './app'
import logger from '../core/logger'
import { config } from '../config'
import prisma from '../core/prismaClient'

const server = http.createServer(app)

server.listen(config.port, () => {
  logger.info({
    layer: 'server',
    action: 'SERVER_LISTEN',
    requestId: null,
    payload: { port: config.port },
  })
})

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info({ layer: 'server', action: 'SHUTDOWN_INITIATED', payload: { signal } })

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
