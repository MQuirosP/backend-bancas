import { NextFunction, Request, Response } from 'express';
import { AppError } from '../core/errors';
import logger from '../core/logger';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  // PrismaClientKnownRequestError has 'code' prop
  if (err instanceof AppError) {
    logger.warn({ err }, 'Operational error');
    return res.status(err.statusCode).json({ status: 'fail', message: err.message, meta: err.meta ?? null });
  }

  if (err?.code) {
    switch (err.code) {
      case 'P2002':
        return res.status(409).json({ status: 'fail', message: 'Unique constraint failed', meta: err.meta ?? null });
      case 'P2003':
        return res.status(400).json({ status: 'fail', message: 'Foreign key constraint failed', meta: err.meta ?? null });
      case 'P2025':
        return res.status(404).json({ status: 'fail', message: 'Record not found', meta: err.meta ?? null });
      default:
        logger.error({ err }, 'Database error');
        return res.status(500).json({ status: 'error', message: 'Database error', meta: err.meta ?? null });
    }
  }

  // fallback
  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({ status: 'error', message: 'Internal server error' });
};
