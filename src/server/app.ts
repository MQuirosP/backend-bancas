// src/server/app.ts
import express from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from '../config';
import logger from '../core/logger';
import { requestIdMiddleware } from '../middlewares/requestId.middleware';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware';
import { errorHandler } from '../middlewares/error.middleware';
import { corsMiddleware } from '../middlewares/cors.middleware';
import { attachRequestLogger } from '../middlewares/attachLogger.middleware';
import { apiV1Router } from '../api/v1/routes';
import { requireJson } from '../middlewares/contentTypeJson.middleware';

const app = express();

// middlewares (order matters)
app.use(requestIdMiddleware);      // sets req.requestId
app.use(attachRequestLogger);      // sets req.logger child bound to requestId
app.use(helmet());
app.use(corsMiddleware);
app.use(express.json({ limit: '200kb' }));
app.use(requireJson);
app.use(express.urlencoded({ extended: true }));
app.use(rateLimitMiddleware);

// dev logging
if (config.nodeEnv !== 'production') {
  app.use(morgan('dev'));
}

// routes
app.use('/api/v1', apiV1Router);

// health
app.get('/api/v1/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

// global error handler (last)
app.use(errorHandler);

// process-level handlers (structured logs)
process.on('uncaughtException', (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error({
    layer: 'process',
    action: 'UNCAUGHT_EXCEPTION',
    meta: { message, stack },
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error({
    layer: 'process',
    action: 'UNHANDLED_REJECTION',
    meta: { message, stack },
  });
});

export default app;
