import { NextFunction, Request, Response } from 'express';
import * as Sentry from "@sentry/node";
import { AppError } from '../core/errors';
import logger from '../core/logger';
import { error as errorResponse } from '../utils/responses';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return _next(err);

  const requestId = (req as any)?.requestId ?? null;
  const userId = (req as any)?.user?.id ?? null;

  // Enriquecer Sentry con el contexto del usuario si está disponible
  if (userId) {
    Sentry.setUser({ id: userId });
  }

  // App-specific operational errors
  if (err instanceof AppError) {
    // Errores esperados (403 Forbidden, 404 Not Found) no generan warnings
    // Solo se registran como info para auditoría, pero no como warnings
    const isExpectedError = err.statusCode === 403 || err.statusCode === 404;
    
    if (isExpectedError) {
      // Errores esperados: loguear como info (opcional, para auditoría)
      // Puedes comentar esto si no quieres loguear estos errores en absoluto
      logger.info({
        layer: 'middleware',
        action: 'OPERATIONAL_ERROR',
        userId,
        requestId,
        payload: { message: err.message, statusCode: err.statusCode },
        meta: err.meta ?? null,
      });
    } else {
      // Errores inesperados: loguear como warning
      logger.warn({
        layer: 'middleware',
        action: 'OPERATIONAL_ERROR',
        userId,
        requestId,
        payload: { message: err.message, statusCode: err.statusCode },
        meta: err.meta ?? null,
      });
    }
    
    return errorResponse(res, err.message, err.statusCode, err.meta ?? undefined);
  }

  // PrismaClientInitializationError — no tiene .code, se detecta por nombre o errorCode
  const isInitError = err?.constructor?.name === 'PrismaClientInitializationError'
    || err?.errorCode?.startsWith('P1')
    || (typeof err?.message === 'string' && err.message.includes("Can't reach database server"));

  if (isInitError) {
    logger.error({
      layer: 'middleware',
      action: 'PRISMA_CONNECTION_ERROR',
      userId,
      requestId,
      meta: { message: err.message, errorCode: err.errorCode ?? null, database_location: err.message?.match(/at `(.+)`/)?.[1] ?? null },
    });
    return errorResponse(res, 'Servicio de base de datos temporalmente no disponible', 503);
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
  Sentry.captureException(err); // Captura manual para mayor seguridad en el fallback

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
