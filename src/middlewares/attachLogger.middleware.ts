import { Request, Response, NextFunction } from 'express';
import logger from '../core/logger';
import type pino from 'pino';

/**
 * Attach a pino child logger to req.logger with requestId binding.
 * Uses logger.raw (pino.Logger) to create the child so handlers can call req.logger.info({...}).
 */
export const attachRequestLogger = (req: Request & { requestId?: string; logger?: pino.Logger }, _res: Response, next: NextFunction) => {
  // prefer req.requestId (set by requestId.middleware), fall back to header
  const ridHeader = Array.isArray(req.headers['x-request-id']) ? req.headers['x-request-id'][0] : req.headers['x-request-id'];
  const requestId = req.requestId ?? (typeof ridHeader === 'string' ? ridHeader : null);

  // logger.raw is the underlying pino instance (see src/core/logger.ts)
  // if for some reason logger.raw is missing, fallback to the exported logger wrapper
  const pinoInstance: pino.Logger = (logger as any).raw ?? (logger as unknown as pino.Logger);

  // create a child logger bound to this requestId
  req.logger = pinoInstance.child({ requestId: requestId ?? null });

  next();
};
