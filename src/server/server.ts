import http from 'http';
import app from './app';
import logger from '../core/logger';
import { config } from '../config';
import prisma from '../core/prismaClient';

const server = http.createServer(app);

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'Server listening');
});

// graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error closing server');
      process.exit(1);
    }
    try {
      await prisma.$disconnect();
      logger.info('Prisma disconnected');
      process.exit(0);
    } catch (e) {
      logger.error({ e }, 'Error during prisma disconnect');
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
