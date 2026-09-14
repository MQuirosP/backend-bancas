import { Request, Response, NextFunction } from 'express';
import toobusy from 'toobusy-js';
import { config } from '../config';
import { activeOperationsService } from '../core/activeOperations.service';
import { ResilienceService } from '../core/resilience.service';
import logger from '../core/logger';
import { v4 as uuidv4 } from 'uuid';

// Configurar toobusy-js
toobusy.maxLag(config.hardening.eventLoopLagThresholdMs);

/**
 * Middleware de Admission Control Global y Circuit Breakers
 */
export const resilienceMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // 0. Ignorar peticiones OPTIONS y Health checks (no consumen DB ni saturan el event loop)
    if (req.method === 'OPTIONS' || req.path === '/api/v1/healthz' || req.path === '/metrics') {
        return next();
    }

    // 1. Monitoreo de Saturación del Event Loop (toobusy)
    // Se mantiene como observabilidad (warning log) para Better Stack / APM,
    // pero NO se rechaza la petición con 503 para no interrumpir a vendedores por micro-pausas transitorias.
    if (toobusy()) {
        logger.warn({
            layer: 'middleware',
            action: 'EVENT_LOOP_LAG_WARNING',
            payload: { lag: toobusy.lag(), thresholdMs: config.hardening.eventLoopLagThresholdMs }
        });
    }

    // 2. Admission Control (Máximo de requests concurrentes)
    const activeCount = activeOperationsService.getActiveCount();
    if (activeCount >= config.hardening.maxConcurrentRequests) {
        logger.warn({
            layer: 'middleware',
            action: 'REJECT_CONCURRENCY_LIMIT',
            payload: { activeCount, limit: config.hardening.maxConcurrentRequests }
        });
        return res.status(503).json({
            status: 'error',
            message: 'Server is at maximum capacity, please try again later.'
        });
    }

    // 3. Verificar Circuit Breaker de Prisma antes de consumir slot
    if (ResilienceService.isPrismaOpen()) {
        return res.status(503).json({
            status: 'error',
            message: 'Database service is temporarily unavailable.'
        });
    }

    // 4. Registrar operación y configurar Request Timeout
    const requestId = uuidv4();
    activeOperationsService.register(requestId, 'request', `${req.method} ${req.path}`);

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timeout);
        activeOperationsService.unregister(requestId);
    };

    // Per-request timeout para liberar slots colgados
    const timeout = setTimeout(() => {
        if (!res.headersSent && !released) {
            logger.error({
                layer: 'middleware',
                action: 'REQUEST_TIMEOUT_EXCEEDED',
                payload: { path: req.path, timeout: config.hardening.requestTimeoutMs }
            });
            release();
            res.status(503).json({
                status: 'error',
                message: 'Request timed out.'
            });
        }
    }, config.hardening.requestTimeoutMs);

    // Limpiar al terminar
    res.on('finish', release);
    res.on('close', release);

    next();
};
