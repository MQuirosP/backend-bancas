/**
 * Account Statement Settlement Job
 *
 * Automatically settles account statements that meet criteria:
 * - Older than SETTLEMENT_AGE_DAYS (default: 7 days, configurable)
 * - remainingBalance ≈ 0
 * - Has tickets (ticketCount > 0)
 * - Not already settled (isSettled = false)
 *
 * Schedule: Runs daily at 3:00 AM UTC (configurable via cronSchedule)
 *
 * Safety:
 * - Only settles days older than settlementAgeDays
 * - Validates remainingBalance before settling
 * - Logs all settlements for audit
 * - Can be disabled via configuration
 */

import prisma from '../core/prismaClient';
import { AccountStatementRepository } from '../repositories/accountStatement.repository';
import { calculateIsSettled } from '../api/v1/services/accounts/accounts.commissions';
import logger from '../core/logger';

let settlementTimer: NodeJS.Timeout | null = null;

/**
 * Calculate milliseconds until next scheduled run
 * Defaults to 3 AM UTC if no cronSchedule is configured
 */
async function getMillisecondsUntilNextSettlement(): Promise<number> {
  const config = await prisma.accountStatementSettlementConfig.findFirst();
  
  // Si hay cronSchedule configurado, usar node-cron para calcular el próximo run
  // Por ahora, usar horario fijo de 3 AM UTC como default
  const now = new Date();
  const next = new Date(now);

  // Set to 3 AM UTC (after activity log cleanup at 2 AM)
  next.setUTCHours(3, 0, 0, 0);

  // If 3 AM has already passed today, schedule for tomorrow
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * Execute the settlement job
 */
export async function executeSettlement(userId?: string): Promise<{
  success: boolean;
  settledCount: number;
  skippedCount: number;
  errorCount: number;
  executedAt: Date;
  errors?: Array<{ statementId: string; error: string }>;
}> {
  try {
    // ✅ Leer configuración desde BD
    let config = await prisma.accountStatementSettlementConfig.findFirst();
    
    if (!config) {
      // Crear configuración por defecto si no existe
      config = await prisma.accountStatementSettlementConfig.create({
        data: {
          enabled: false,
          settlementAgeDays: 7,
          batchSize: 1000,
        },
      });
    }

    if (!config.enabled) {
      logger.info({
        layer: 'job',
        action: 'SETTLEMENT_SKIPPED',
        payload: { message: 'Auto-settlement is disabled' }
      });
      return {
        success: true,
        settledCount: 0,
        skippedCount: 0,
        errorCount: 0,
        executedAt: new Date(),
      };
    }

    // Calcular fecha límite (días atrás desde hoy)
    const today = new Date();
    const cutoffDate = new Date(today);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - config.settlementAgeDays);
    cutoffDate.setUTCHours(0, 0, 0, 0);

    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_START',
      payload: {
        cutoffDate: cutoffDate.toISOString(),
        settlementAgeDays: config.settlementAgeDays,
        batchSize: config.batchSize
      }
    });

    // Buscar statements no asentados anteriores a la fecha límite
    const statementsToSettle = await prisma.accountStatement.findMany({
      where: {
        isSettled: false,
        date: {
          lt: cutoffDate
        },
        ticketCount: {
          gt: 0
        }
      },
      include: {
        payments: {
          where: {
            isReversed: false
          }
        }
      },
      take: config.batchSize // Procesar en lotes
    });

    let settledCount = 0;
    let skippedCount = 0;
    const errors: Array<{ statementId: string; error: string }> = [];

    for (const statement of statementsToSettle) {
      try {
        // ✅ CRÍTICO: Recalcular totalPaid y totalCollected desde movimientos activos
        const totalPaid = statement.payments
          .filter(p => p.type === 'payment' && !p.isReversed)
          .reduce((sum, p) => sum + p.amount, 0);
        
        const totalCollected = statement.payments
          .filter(p => p.type === 'collection' && !p.isReversed)
          .reduce((sum, p) => sum + p.amount, 0);

        // Calcular remainingBalance
        const remainingBalance = statement.balance - totalCollected + totalPaid;

        // Verificar si debe asentarse
        const shouldSettle = calculateIsSettled(
          statement.ticketCount,
          remainingBalance,
          totalPaid,
          totalCollected
        );

        if (shouldSettle) {
          // Actualizar statement como asentado
          await AccountStatementRepository.update(statement.id, {
            isSettled: true,
            canEdit: false,
            totalPaid,
            totalCollected,
            remainingBalance,
            settledAt: new Date(),
            settledBy: userId || null, // null para automático, userId para manual
          });

          settledCount++;

          logger.info({
            layer: 'job',
            action: 'STATEMENT_SETTLED',
            payload: {
              statementId: statement.id,
              date: statement.date.toISOString(),
              ventanaId: statement.ventanaId,
              vendedorId: statement.vendedorId,
              remainingBalance,
              settledBy: userId || 'SYSTEM'
            }
          });
        } else {
          skippedCount++;

          logger.debug({
            layer: 'job',
            action: 'STATEMENT_SKIPPED',
            payload: {
              statementId: statement.id,
              date: statement.date.toISOString(),
              reason: 'Does not meet settlement criteria',
              remainingBalance,
              ticketCount: statement.ticketCount
            }
          });
        }
      } catch (error) {
        errors.push({
          statementId: statement.id,
          error: (error as Error).message
        });

        logger.error({
          layer: 'job',
          action: 'SETTLEMENT_ERROR',
          payload: {
            statementId: statement.id,
            error: (error as Error).message
          }
        });
      }
    }

    // Actualizar estadísticas de última ejecución
    await prisma.accountStatementSettlementConfig.update({
      where: { id: config.id },
      data: {
        lastExecution: new Date(),
        lastSettledCount: settledCount,
        lastSkippedCount: skippedCount,
        lastErrorCount: errors.length,
        lastErrorMessage: errors.length > 0 ? errors[0].error : null
      }
    });

    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_COMPLETE',
      payload: {
        totalProcessed: statementsToSettle.length,
        settledCount,
        skippedCount,
        errorCount: errors.length,
        errors: errors.length > 0 ? errors : undefined
      }
    });

    return {
      success: true,
      settledCount,
      skippedCount,
      errorCount: errors.length,
      executedAt: new Date(),
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    logger.error({
      layer: 'job',
      action: 'SETTLEMENT_JOB_ERROR',
      payload: {
        error: (error as Error).message,
        stack: (error as Error).stack
      }
    });

    return {
      success: false,
      settledCount: 0,
      skippedCount: 0,
      errorCount: 1,
      executedAt: new Date(),
      errors: [{ statementId: 'JOB_ERROR', error: (error as Error).message }]
    };
  }
}

/**
 * Start the settlement job
 */
export function startAccountStatementSettlementJob(): void {
  if (settlementTimer) {
    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_JOB_ALREADY_RUNNING'
    });
    return;
  }

  // Calcular delay de forma asíncrona pero no bloquear
  getMillisecondsUntilNextSettlement().then((delayMs) => {
    const nextRun = new Date(Date.now() + delayMs);

    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_JOB_SCHEDULED',
      payload: {
        nextRun: nextRun.toISOString(),
        delayMinutes: Math.round(delayMs / 1000 / 60)
      }
    });

    // Schedule first run
    settlementTimer = setTimeout(() => {
      // Execute immediately (sin userId porque es automático)
      executeSettlement().catch((error) => {
        logger.error({
          layer: 'job',
          action: 'SETTLEMENT_JOB_EXECUTION_ERROR',
          payload: { error: (error as Error).message }
        });
      });

      // Schedule to repeat every 24 hours
      settlementTimer = setInterval(() => {
        executeSettlement().catch((error) => {
          logger.error({
            layer: 'job',
            action: 'SETTLEMENT_JOB_EXECUTION_ERROR',
            payload: { error: (error as Error).message }
          });
        });
      }, 24 * 60 * 60 * 1000);
    }, delayMs);
  }).catch((error) => {
    logger.error({
      layer: 'job',
      action: 'SETTLEMENT_JOB_SCHEDULE_ERROR',
      payload: { error: (error as Error).message }
    });
  });
}

/**
 * Stop the settlement job
 */
export function stopAccountStatementSettlementJob(): void {
  if (settlementTimer) {
    clearTimeout(settlementTimer);
    clearInterval(settlementTimer as any);
    settlementTimer = null;
    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_JOB_STOPPED'
    });
  }
}

