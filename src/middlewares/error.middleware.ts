import { NextFunction, Request, Response } from 'express';
import { AppError } from '../core/errors';
import logger from '../core/logger';
import { error as errorResponse } from '../utils/responses';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as any)?.requestId ?? null;
  const userId = (req as any)?.user?.id ?? null;

  // App-specific operational errors
  if (err instanceof AppError) {
    logger.warn({
      layer: 'middleware',
      action: 'OPERATIONAL_ERROR',
      userId,
      requestId,
      payload: { message: err.message },
      meta: err.meta ?? null,
    });
    return errorResponse(res, err.message, err.statusCode, err.meta ?? undefined);
  }

  // PrismaClientKnownRequestError (has code property)
  if (err?.code) {
    switch (err.code) {
      case 'P2002':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2002',
          requestId,
          meta: err.meta ?? null,
        });
        return errorResponse(res, 'Unique constraint failed', 409, err.meta ?? undefined);

      case 'P2003':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2003',
          requestId,
          meta: err.meta ?? null,
        });
        return errorResponse(res, 'Foreign key constraint failed', 400, err.meta ?? undefined);

      case 'P2025':
        logger.warn({
          layer: 'middleware',
          action: 'PRISMA_P2025',
          requestId,
          meta: err.meta ?? null,
        });
        return errorResponse(res, 'Record not found', 404, err.meta ?? undefined);

      default:
        logger.error({
          layer: 'middleware',
          action: 'PRISMA_UNKNOWN_ERROR',
          requestId,
          meta: err.meta ?? null,
        });
        return errorResponse(res, 'Database error', 500, err.meta ?? undefined);
    }
  }

  // fallback - unexpected errors
  logger.error({
    layer: 'middleware',
    action: 'UNHANDLED_ERROR',
    userId,
    requestId,
    meta: { message: (err as Error)?.message ?? String(err), stack: (err as Error)?.stack ?? null },
  });

  return errorResponse(res, 'Internal server error', 500, {
    message: (err as Error)?.message ?? String(err),
  });
};
