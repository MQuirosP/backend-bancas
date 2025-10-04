import express from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from '../config';
import logger from '../core/logger';
import { requestIdMiddleware } from '../middlewares/requestId.middleware';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware';
// import apiV1Router from '../api/v1/routes/index';
import { errorHandler } from '../middlewares/error.middleware';
import { corsMiddleware } from '../middlewares/cors.middleware';

const app = express();

// basic middlewares
app.use(requestIdMiddleware);
app.use(helmet());
app.use(corsMiddleware);
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimitMiddleware);

// logging in dev
if (config.nodeEnv !== 'production') {
  app.use(morgan('dev'));
}

// routes
// app.use('/api/v1', apiV1Router);

// health
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

// error handler (last)
app.use(errorHandler);

// global handlers for uncaught
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException - exiting');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

export default app;
