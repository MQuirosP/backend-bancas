// src/middlewares/error.middleware.ts
import { NextFunction, Request, Response } from 'express';
import { AppError } from '../core/errors';
import logger from '../core/logger';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  // App-specific operational errors
  if (err instanceof AppError) {
    logger.warn({
      layer: 'middleware',
      action: 'OPERATIONAL_ERROR',
      userId: (req as any)?.user?.id ?? null,
      requestId: (req as any)?.requestId ?? null,
      payload: { message: err.message },
      meta: err.meta ?? null,
    });
    return res.status(err.statusCode).json({ status: 'fail', message: err.message, meta: err.meta ?? null });
  }

  // PrismaClientKnownRequestError (has code property)
  if (err?.code) {
    switch (err.code) {
      case 'P2002':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2002',
          meta: err.meta ?? null,
          requestId: (req as any)?.requestId ?? null,
        });
        return res.status(409).json({ status: 'fail', message: 'Unique constraint failed', meta: err.meta ?? null });
      case 'P2003':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2003',
          meta: err.meta ?? null,
          requestId: (req as any)?.requestId ?? null,
        });
        return res.status(400).json({ status: 'fail', message: 'Foreign key constraint failed', meta: err.meta ?? null });
      case 'P2025':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2025',
          meta: err.meta ?? null,
          requestId: (req as any)?.requestId ?? null,
        });
        return res.status(404).json({ status: 'fail', message: 'Record not found', meta: err.meta ?? null });
      default:
        logger.error({
          layer: 'middleware',
          action: 'PRISMA_UNKNOWN_ERROR',
          meta: err.meta ?? null,
          requestId: (req as any)?.requestId ?? null,
        });
        return res.status(500).json({ status: 'error', message: 'Database error', meta: err.meta ?? null });
    }
  }

  // fallback - unexpected errors
  logger.error({
    layer: 'middleware',
    action: 'UNHANDLED_ERROR',
    userId: (req as any)?.user?.id ?? null,
    requestId: (req as any)?.requestId ?? null,
    meta: { message: (err as Error)?.message ?? String(err), stack: (err as Error)?.stack ?? null },
  });

  return res.status(500).json({ status: 'error', message: 'Internal server error' });
};
