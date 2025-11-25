import { Request, Response, NextFunction } from 'express';
import { normalizeDateCR } from '../utils/datetime';
import logger from '../core/logger';

/**
 * Middleware que normaliza automáticamente campos de fecha en body/query.
 * Debe ejecutarse DESPUÉS de validate.middleware.
 * 
 * @param dateFields - Array de nombres de campos que contienen fechas
 * @returns Express middleware function
 */
export function normalizeDates(dateFields: string[]) {
    return (req: Request, _res: Response, next: NextFunction) => {
        try {
            // Normalizar en body
            if (req.body) {
                for (const field of dateFields) {
                    if (req.body[field] !== undefined && req.body[field] !== null) {
                        try {
                            req.body[field] = normalizeDateCR(req.body[field], field);
                        } catch (err: any) {
                            logger.warn({
                                layer: 'middleware',
                                action: 'DATE_NORMALIZATION_FAILED',
                                payload: {
                                    field,
                                    value: req.body[field],
                                    type: typeof req.body[field],
                                    error: err.message,
                                },
                            });
                            // No lanzar error aquí, dejar que el validador lo maneje
                        }
                    }
                }
            }

            // Normalizar en query
            if (req.query) {
                for (const field of dateFields) {
                    if (req.query[field] !== undefined && req.query[field] !== null) {
                        try {
                            // TypeScript: req.query espera strings, pero necesitamos pasar Date a validators
                            // Usamos 'any' para permitir la asignación
                            (req.query as any)[field] = normalizeDateCR(req.query[field] as string, field);
                        } catch (err: any) {
                            logger.warn({
                                layer: 'middleware',
                                action: 'DATE_NORMALIZATION_FAILED',
                                payload: {
                                    field,
                                    value: req.query[field],
                                    type: typeof req.query[field],
                                    error: err.message,
                                },
                            });
                        }
                    }
                }
            }

            next();
        } catch (err) {
            next(err);
        }
    };
}
