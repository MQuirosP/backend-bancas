/**
 * Monthly Closing Balance Job
 *
 * Automatically calculates and saves monthly closing balances for:
 * - Vendedores (vendors)
 * - Ventanas (windows)
 * - Bancas (banks)
 *
 * Schedule: Runs on the 1st day of each month at 2:00 AM CR (8:00 AM UTC)
 * This ensures the previous month is fully closed before the new month starts
 *
 * Safety:
 * - Only processes the previous month (not current month)
 * - Uses real data from tickets and payments (source of truth)
 * - Logs all operations for audit
 * - Can be executed manually at any time
 */

import prisma from '../core/prismaClient';
import {
    processMonthlyClosingForVendedores,
    calculateRealMonthBalance,
    saveMonthlyClosingBalance,
} from '../api/v1/services/accounts/monthlyClosing.service';
import logger from '../core/logger';
import { crDateService } from '../utils/crDateService';

let monthlyClosingTimer: NodeJS.Timeout | null = null;

/**
 * Calculate milliseconds until next 1st of month at 2:00 AM CR (8:00 AM UTC)
 */
function getMillisecondsUntilNextClosing(): number {
    const now = new Date();
    
    // Get current date string in CR timezone (YYYY-MM-DD)
    const nowCRStr = crDateService.dateUTCToCRString(now);
    const [currentYear, currentMonth, currentDay] = nowCRStr.split('-').map(Number);
    
    // Get current hour in CR timezone
    // CR is UTC-6, so we need to subtract 6 hours from UTC to get CR time
    const nowUTC = new Date(now);
    const nowCRHour = (nowUTC.getUTCHours() - 6 + 24) % 24; // Adjust for CR timezone
    
    // Calculate next closing date (1st of next month at 2:00 AM CR)
    // CR is UTC-6, so 2:00 AM CR = 8:00 AM UTC
    let nextClosingYear = currentYear;
    let nextClosingMonth = currentMonth;
    
    if (currentDay === 1 && nowCRHour < 2) {
        // We're on the 1st but before 2:00 AM, use today
        const firstOfCurrentMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1, 8, 0, 0, 0));
        return firstOfCurrentMonth.getTime() - now.getTime();
    }
    
    // Calculate next month
    nextClosingMonth++;
    if (nextClosingMonth > 12) {
        nextClosingMonth = 1;
        nextClosingYear++;
    }
    
    // Create date for 1st of next month at 2:00 AM CR (8:00 AM UTC)
    const nextClosingCR = new Date(Date.UTC(nextClosingYear, nextClosingMonth - 1, 1, 8, 0, 0, 0));
    
    return nextClosingCR.getTime() - now.getTime();
}

/**
 * Process monthly closing for all dimensions
 */
export async function executeMonthlyClosing(userId?: string, specificMonth?: string): Promise<{
    success: boolean;
    closingMonth: string;
    vendedores: { success: number; errors: number };
    ventanas: { success: number; errors: number };
    bancas: { success: number; errors: number };
    executedAt: Date;
}> {
    try {
        // Calculate previous month (the month to close) or use specific month
        let closingMonth: string;

        if (specificMonth) {
            // Validate specific month format (YYYY-MM)
            if (!/^\d{4}-\d{2}$/.test(specificMonth)) {
                throw new Error(`Invalid month format: ${specificMonth}. Expected YYYY-MM`);
            }
            closingMonth = specificMonth;
        } else {
            const now = new Date();
            const nowCRStr = crDateService.dateUTCToCRString(now);
            const [currentYear, currentMonth] = nowCRStr.split('-').map(Number);

            // Calculate previous month
            let previousYear = currentYear;
            let previousMonth = currentMonth - 1;

            if (previousMonth < 1) {
                previousMonth = 12;
                previousYear--;
            }

            closingMonth = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
        }
        
        logger.info({
            layer: 'job',
            action: 'MONTHLY_CLOSING_START',
            payload: {
                closingMonth,
                executedBy: userId || 'SYSTEM',
            },
        });

        // 1. Process vendedores
        const vendedoresResult = await processMonthlyClosingForVendedores(closingMonth);

        // 2. Process ventanas
        let ventanasSuccess = 0;
        let ventanasErrors = 0;
        
        try {
            const ventanas = await prisma.ventana.findMany({
                where: {
                    isActive: true,
                },
                select: {
                    id: true,
                    bancaId: true,
                },
            });

            logger.info({
                layer: 'job',
                action: 'MONTHLY_CLOSING_START_VENTANAS',
                payload: {
                    closingMonth,
                    totalVentanas: ventanas.length,
                },
            });

            for (const ventana of ventanas) {
                try {
                    const balance = await calculateRealMonthBalance(
                        closingMonth,
                        'ventana',
                        ventana.id,
                        undefined,
                        ventana.bancaId || undefined
                    );

                    await saveMonthlyClosingBalance(
                        closingMonth,
                        'ventana',
                        balance,
                        ventana.id,
                        undefined,
                        ventana.bancaId || undefined
                    );

                    ventanasSuccess++;
                } catch (error: any) {
                    ventanasErrors++;
                    logger.error({
                        layer: 'job',
                        action: 'MONTHLY_CLOSING_VENTANA_ERROR',
                        payload: {
                            closingMonth,
                            ventanaId: ventana.id,
                            error: error.message,
                        },
                    });
                }
            }

            logger.info({
                layer: 'job',
                action: 'MONTHLY_CLOSING_COMPLETE_VENTANAS',
                payload: {
                    closingMonth,
                    success: ventanasSuccess,
                    errors: ventanasErrors,
                },
            });
        } catch (error: any) {
            logger.error({
                layer: 'job',
                action: 'MONTHLY_CLOSING_PROCESS_VENTANAS_ERROR',
                payload: {
                    closingMonth,
                    error: error.message,
                },
            });
            ventanasErrors++;
        }

        // 3. Process bancas
        let bancasSuccess = 0;
        let bancasErrors = 0;
        
        try {
            const bancas = await prisma.banca.findMany({
                where: {
                    isActive: true,
                },
                select: {
                    id: true,
                },
            });

            logger.info({
                layer: 'job',
                action: 'MONTHLY_CLOSING_START_BANCAS',
                payload: {
                    closingMonth,
                    totalBancas: bancas.length,
                },
            });

            for (const banca of bancas) {
                try {
                    const balance = await calculateRealMonthBalance(
                        closingMonth,
                        'banca',
                        undefined,
                        undefined,
                        banca.id
                    );

                    await saveMonthlyClosingBalance(
                        closingMonth,
                        'banca',
                        balance,
                        undefined,
                        undefined,
                        banca.id
                    );

                    bancasSuccess++;
                } catch (error: any) {
                    bancasErrors++;
                    logger.error({
                        layer: 'job',
                        action: 'MONTHLY_CLOSING_BANCA_ERROR',
                        payload: {
                            closingMonth,
                            bancaId: banca.id,
                            error: error.message,
                        },
                    });
                }
            }

            logger.info({
                layer: 'job',
                action: 'MONTHLY_CLOSING_COMPLETE_BANCAS',
                payload: {
                    closingMonth,
                    success: bancasSuccess,
                    errors: bancasErrors,
                },
            });
        } catch (error: any) {
            logger.error({
                layer: 'job',
                action: 'MONTHLY_CLOSING_PROCESS_BANCAS_ERROR',
                payload: {
                    closingMonth,
                    error: error.message,
                },
            });
            bancasErrors++;
        }

        const totalSuccess = vendedoresResult.success + ventanasSuccess + bancasSuccess;
        const totalErrors = vendedoresResult.errors + ventanasErrors + bancasErrors;

        logger.info({
            layer: 'job',
            action: 'MONTHLY_CLOSING_COMPLETE',
            payload: {
                closingMonth,
                totalSuccess,
                totalErrors,
                vendedores: vendedoresResult,
                ventanas: { success: ventanasSuccess, errors: ventanasErrors },
                bancas: { success: bancasSuccess, errors: bancasErrors },
                executedBy: userId || 'SYSTEM',
            },
        });

        return {
            success: totalErrors === 0,
            closingMonth,
            vendedores: vendedoresResult,
            ventanas: { success: ventanasSuccess, errors: ventanasErrors },
            bancas: { success: bancasSuccess, errors: bancasErrors },
            executedAt: new Date(),
        };
    } catch (error: any) {
        logger.error({
            layer: 'job',
            action: 'MONTHLY_CLOSING_JOB_ERROR',
            payload: {
                error: error.message,
                stack: error.stack,
            },
        });

        throw error;
    }
}

/**
 * Start the monthly closing job
 */
export function startMonthlyClosingJob(): void {
    if (monthlyClosingTimer) {
        logger.info({
            layer: 'job',
            action: 'MONTHLY_CLOSING_JOB_ALREADY_RUNNING',
        });
        return;
    }

    const delayMs = getMillisecondsUntilNextClosing();
    const nextRun = new Date(Date.now() + delayMs);

    logger.info({
        layer: 'job',
        action: 'MONTHLY_CLOSING_JOB_SCHEDULED',
        payload: {
            nextRun: nextRun.toISOString(),
            delayMinutes: Math.round(delayMs / 1000 / 60),
            delayHours: Math.round(delayMs / 1000 / 60 / 60),
        },
    });

    // Schedule first run
    // ✅ CRÍTICO: Limitar delay a máximo 32 bits (2147483647 ms = ~24.8 días)
    // Si el delay es mayor, usar el máximo y recalcular después
    const maxDelay = 2147483647; // Máximo para setTimeout (32 bits signed)
    const actualDelay = Math.min(delayMs, maxDelay);
    
    monthlyClosingTimer = setTimeout(() => {
        // Execute immediately
        executeMonthlyClosing().catch((error) => {
            logger.error({
                layer: 'job',
                action: 'MONTHLY_CLOSING_JOB_EXECUTION_ERROR',
                payload: { error: (error as Error).message },
            });
        });

        // Reschedule for next month after execution
        scheduleNextMonthlyClosing();
    }, actualDelay);
}

/**
 * Schedule next monthly closing execution
 */
function scheduleNextMonthlyClosing(): void {
    const delayMs = getMillisecondsUntilNextClosing();
    const maxDelay = 2147483647; // Máximo para setTimeout (32 bits signed)
    const actualDelay = Math.min(delayMs, maxDelay);
    const nextRun = new Date(Date.now() + actualDelay);

    logger.info({
        layer: 'job',
        action: 'MONTHLY_CLOSING_JOB_RESCHEDULED',
        payload: {
            nextRun: nextRun.toISOString(),
            delayMinutes: Math.round(actualDelay / 1000 / 60),
            delayHours: Math.round(actualDelay / 1000 / 60 / 60),
        },
    });

    monthlyClosingTimer = setTimeout(() => {
        executeMonthlyClosing()
            .then(() => {
                // Reschedule for next month after successful execution
                scheduleNextMonthlyClosing();
            })
            .catch((error) => {
                logger.error({
                    layer: 'job',
                    action: 'MONTHLY_CLOSING_JOB_EXECUTION_ERROR',
                    payload: { error: (error as Error).message },
                });
                // Reschedule anyway to retry next month
                scheduleNextMonthlyClosing();
            });
    }, actualDelay);
}

/**
 * Stop the monthly closing job
 */
export function stopMonthlyClosingJob(): void {
    if (monthlyClosingTimer) {
        clearTimeout(monthlyClosingTimer);
        monthlyClosingTimer = null;
        logger.info({
            layer: 'job',
            action: 'MONTHLY_CLOSING_JOB_STOPPED',
        });
    }
}
