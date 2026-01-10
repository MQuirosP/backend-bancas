/**
 * Active Operations Tracking Service
 *
 * ✅ OPTIMIZACIÓN: Trackea operaciones activas para graceful shutdown
 * - Permite esperar a que terminen operaciones críticas antes de cerrar el servidor
 * - Evita cortar operaciones en progreso (jobs, requests largos, etc.)
 * - Implementa timeout para evitar esperar indefinidamente
 */

import logger from './logger';

interface ActiveOperation {
    id: string;
    type: 'job' | 'request' | 'other';
    description: string;
    startTime: number;
}

class ActiveOperationsService {
    private operations = new Map<string, ActiveOperation>();
    private isShuttingDown = false;

    /**
     * Registra una operación activa
     */
    register(id: string, type: ActiveOperation['type'], description: string): void {
        if (this.isShuttingDown) {
            logger.warn({
                layer: 'server',
                action: 'OPERATION_REJECTED_SHUTDOWN',
                payload: {
                    operationId: id,
                    type,
                    description,
                    message: 'Server is shutting down, operation rejected'
                }
            });
            throw new Error('Server is shutting down, cannot start new operations');
        }

        this.operations.set(id, {
            id,
            type,
            description,
            startTime: Date.now()
        });

        logger.debug({
            layer: 'server',
            action: 'OPERATION_REGISTERED',
            payload: {
                operationId: id,
                type,
                description,
                activeCount: this.operations.size
            }
        });
    }

    /**
     * Desregistra una operación activa
     */
    unregister(id: string): void {
        const operation = this.operations.get(id);
        if (operation) {
            const duration = Date.now() - operation.startTime;
            this.operations.delete(id);

            logger.debug({
                layer: 'server',
                action: 'OPERATION_COMPLETED',
                payload: {
                    operationId: id,
                    type: operation.type,
                    description: operation.description,
                    durationMs: duration,
                    activeCount: this.operations.size
                }
            });
        }
    }

    /**
     * Marca que el servidor está en proceso de shutdown
     */
    markShuttingDown(): void {
        this.isShuttingDown = true;
        logger.info({
            layer: 'server',
            action: 'SHUTDOWN_MARKED',
            payload: {
                activeOperations: this.operations.size,
                operations: Array.from(this.operations.values()).map(op => ({
                    id: op.id,
                    type: op.type,
                    description: op.description,
                    durationMs: Date.now() - op.startTime
                }))
            }
        });
    }

    /**
     * Espera a que todas las operaciones activas terminen
     * @param timeoutMs Timeout en milisegundos (default: 30 segundos)
     * @returns true si todas terminaron, false si se agotó el timeout
     */
    async waitForCompletion(timeoutMs: number = 30000): Promise<boolean> {
        const startTime = Date.now();

        while (this.operations.size > 0) {
            const elapsed = Date.now() - startTime;

            if (elapsed >= timeoutMs) {
                logger.warn({
                    layer: 'server',
                    action: 'SHUTDOWN_TIMEOUT',
                    payload: {
                        timeoutMs,
                        remainingOperations: this.operations.size,
                        operations: Array.from(this.operations.values()).map(op => ({
                            id: op.id,
                            type: op.type,
                            description: op.description,
                            durationMs: Date.now() - op.startTime
                        }))
                    }
                });
                return false;
            }

            logger.info({
                layer: 'server',
                action: 'SHUTDOWN_WAITING',
                payload: {
                    remainingOperations: this.operations.size,
                    elapsedMs: elapsed,
                    timeoutMs
                }
            });

            // Esperar 1 segundo antes de volver a verificar
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        logger.info({
            layer: 'server',
            action: 'SHUTDOWN_ALL_OPERATIONS_COMPLETED',
            payload: {
                elapsedMs: Date.now() - startTime
            }
        });

        return true;
    }

    /**
     * Obtiene el número de operaciones activas
     */
    getActiveCount(): number {
        return this.operations.size;
    }

    /**
     * Verifica si el servidor está en proceso de shutdown
     */
    isServerShuttingDown(): boolean {
        return this.isShuttingDown;
    }
}

// Exportar singleton
export const activeOperationsService = new ActiveOperationsService();
