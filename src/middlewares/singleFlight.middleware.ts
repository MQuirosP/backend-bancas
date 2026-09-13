// src/middlewares/singleFlight.middleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../core/logger';

interface Waiter {
    req: Request;
    res: Response;
    next: NextFunction;
}

interface InFlightEntry {
    waiters: Waiter[];
    startTime: number;
    timeoutTimer: NodeJS.Timeout;
}

// Mapa en memoria de requests GET en vuelo
const inFlightRequests = new Map<string, InFlightEntry>();

// Headers que no deben ser clonados a los waiters (hop-by-hop o recalculados por Express)
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'trailer',
    'upgrade',
]);

/**
 * Middleware Single-Flight (Coalescing de peticiones GET concurrentes).
 *
 * Si un cliente (o navegador despertando de background como Safari iOS)
 * dispara múltiples peticiones GET idénticas de forma simultánea,
 * este middleware permite que solo la primera ejecute la consulta en la base de datos
 * y coaleszca las respuestas a todas las peticiones en espera.
 *
 * Scoping de seguridad estricto:
 * - Solo aplica a métodos GET idempotentes.
 * - Clave única por: Token de Autorización + X-Active-Banca-Id + URL completa.
 * - Usuarios distintos NUNCA comparten respuesta.
 */
export const singleFlightMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    // 1. Solo aplicar a GET
    if (req.method !== 'GET') {
        return next();
    }

    // 2. Ignorar Server-Sent Events, WebSockets o Health checks
    const acceptHeader = req.headers.accept || '';
    if (acceptHeader.includes('text/event-stream') || req.headers.upgrade) {
        return next();
    }

    if (req.path === '/api/v1/healthz' || req.path === '/metrics') {
        return next();
    }

    // 3. Generar clave única con aislamiento estricto por usuario y tenant
    const authPart = req.headers.authorization || req.ip || 'anon';
    const bancaPart = (req.headers['x-active-banca-id'] as string) || '';
    const key = `${authPart}::${bancaPart}::${req.originalUrl}`;

    // 4. Si ya hay una petición idéntica en vuelo, unirse como waiter
    const existingEntry = inFlightRequests.get(key);
    if (existingEntry) {
        logger.debug({
            layer: 'middleware',
            action: 'SINGLE_FLIGHT_ATTACH_WAITER',
            payload: {
                url: req.originalUrl,
                waitersCount: existingEntry.waiters.length + 1,
            },
        });

        const waiter: Waiter = { req, res, next };
        existingEntry.waiters.push(waiter);

        // Si el cliente en espera aborta la conexión antes de recibir respuesta, limpiarlo
        res.on('close', () => {
            const idx = existingEntry.waiters.indexOf(waiter);
            if (idx !== -1) {
                existingEntry.waiters.splice(idx, 1);
            }
        });

        return;
    }

    // 5. Este request es el Líder (ejecuta normalmente)
    const timeoutTimer = setTimeout(() => {
        cleanup(key);
    }, 30_000);
    timeoutTimer.unref();

    const entry: InFlightEntry = {
        waiters: [],
        startTime: Date.now(),
        timeoutTimer,
    };
    inFlightRequests.set(key, entry);

    let finished = false;

    const cleanup = (k: string) => {
        const item = inFlightRequests.get(k);
        if (item) {
            clearTimeout(item.timeoutTimer);
            inFlightRequests.delete(k);
        }
    };

    const broadcastToWaiters = (body?: any) => {
        if (finished) return;
        finished = true;

        const currentWaiters = [...entry.waiters];
        cleanup(key);

        if (currentWaiters.length === 0) return;

        const statusCode = res.statusCode || 200;
        const headers = res.getHeaders();

        logger.debug({
            layer: 'middleware',
            action: 'SINGLE_FLIGHT_RESOLVE_WAITERS',
            payload: {
                url: req.originalUrl,
                resolvedWaiters: currentWaiters.length,
                durationMs: Date.now() - entry.startTime,
            },
        });

        for (const waiter of currentWaiters) {
            if (!waiter.res.writableEnded && !waiter.res.destroyed) {
                try {
                    for (const [hName, hVal] of Object.entries(headers)) {
                        if (hVal !== undefined && !HOP_BY_HOP_HEADERS.has(hName.toLowerCase())) {
                            waiter.res.setHeader(hName, hVal);
                        }
                    }
                    waiter.res.setHeader('X-Single-Flight', 'coalesced');
                    waiter.res.status(statusCode);

                    if (body !== undefined) {
                        waiter.res.send(body);
                    } else {
                        waiter.res.end();
                    }
                } catch (err) {
                    logger.warn({
                        layer: 'middleware',
                        action: 'SINGLE_FLIGHT_WAITER_ERROR',
                        payload: { error: err instanceof Error ? err.message : String(err) },
                    });
                }
            }
        }
    };

    // Interceptar res.send
    const originalSend = res.send.bind(res);
    res.send = function (body?: any): Response {
        broadcastToWaiters(body);
        return originalSend(body);
    };

    // Interceptar res.end por si se responde con res.end() directo (ej. 204/304)
    const originalEnd = res.end.bind(res);
    res.end = function (chunk?: any, encoding?: any, cb?: any): Response {
        broadcastToWaiters(chunk);
        return originalEnd(chunk, encoding, cb);
    };

    // Si el cliente líder desconecta antes de completar la respuesta
    res.on('close', () => {
        if (!finished) {
            finished = true;
            const orphanedWaiters = [...entry.waiters];
            cleanup(key);

            // Si el líder abortó, dejamos que los waiters ejecuten su propio pipeline en lugar de fallar
            for (const waiter of orphanedWaiters) {
                if (!waiter.res.writableEnded && !waiter.res.destroyed) {
                    waiter.next();
                }
            }
        }
    });

    next();
};
