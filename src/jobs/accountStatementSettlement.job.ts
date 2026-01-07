/**
 * Account Statement Settlement Job
 *
 * Automatically settles account statements that meet criteria:
 * - Older than settlementAgeDays (configurable, default: 7 days)
 * - Has activity: ticketCount > 0 OR totalPaid > 0 OR totalCollected > 0
 *   - La tabla es un resumen para optimizar consultas, puede tener tickets, movimientos, o ambos
 * - Not already settled (isSettled = false)
 *
 * ️ CRÍTICO: NO usa remainingBalance ≈ 0 como criterio.
 * Los estados de cuenta siempre tendrán saldo (a favor o en contra).
 *
 * Schedule: Runs daily at 3:00 AM UTC (configurable via cronSchedule)
 *
 * Safety:
 * - Only settles days older than settlementAgeDays
 * - Uses configuration from account_statement_settlement_config
 * - Logs all settlements for audit
 * - Can be disabled via configuration
 * - Manual execution does NOT require enabled = true
 */

import prisma from '../core/prismaClient';
import { AccountStatementRepository } from '../repositories/accountStatement.repository';
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
    //  CRÍTICO: Leer configuración desde BD (según especificación actualizada)
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

    //  CRÍTICO: Ejecución manual NO requiere que enabled sea true (según especificación)
    // Solo verificar enabled para ejecuciones automáticas (cuando userId es undefined)
    if (!userId && !config.enabled) {
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

    //  CRÍTICO: Calcular fecha límite usando zona horaria de CR
    // date < (today - settlementAgeDays días) en zona horaria de CR
    const { crDateService } = await import('../utils/crDateService');
    
    // Obtener fecha actual en UTC y convertir a CR
    const nowUTC = new Date();
    const todayCRStr = crDateService.dateUTCToCRString(nowUTC); // 'YYYY-MM-DD'
    
    // Parsear fecha CR a Date para calcular cutoffDate
    const [year, month, day] = todayCRStr.split('-').map(Number);
    const todayCR = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    
    // Calcular cutoffDate restando settlementAgeDays días
    const cutoffDateCR = new Date(todayCR);
    cutoffDateCR.setUTCDate(cutoffDateCR.getUTCDate() - config.settlementAgeDays);

    //  DIAGNÓSTICO: Contar estados para entender qué está pasando
    const totalStatements = await prisma.accountStatement.count();
    const settledStatementsCount = await prisma.accountStatement.count({
      where: { isSettled: true }
    });
    const notSettledCount = await prisma.accountStatement.count({
      where: { isSettled: false }
    });
    const notSettledOldEnoughCount = await prisma.accountStatement.count({
      where: {
        isSettled: false,
        date: { lt: cutoffDateCR }
      }
    });

    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_START',
      payload: {
        cutoffDateCR: crDateService.postgresDateToCRString(cutoffDateCR),
        settlementAgeDays: config.settlementAgeDays,
        batchSize: config.batchSize,
        executedBy: userId || 'SYSTEM',
        diagnostics: {
          totalStatements,
          settledStatementsCount,
          notSettledCount,
          notSettledOldEnoughCount
        }
      }
    });

    //  CRÍTICO: Buscar todos los statements antiguos (con o sin actividad)
    // Criterios actualizados para Universal Settlement:
    // 1. date < (today - settlementAgeDays días) 
    // 2. isSettled = false 
    // 3. NO requiere actividad (permite cerrar días vacíos del historial) 
    const statementsToSettle = await prisma.accountStatement.findMany({
      where: {
        isSettled: false,
        date: {
          lt: cutoffDateCR
        }
      },
      include: {
        payments: {
          where: {
            isReversed: false
          }
        }
      },
      orderBy: {
        date: 'asc' // Procesar desde más antiguo a más reciente
      },
      take: config.batchSize // Procesar en lotes
    });

    let settledCount = 0;
    let skippedCount = 0;
    const errors: Array<{ statementId: string; error: string }> = [];

    for (const statement of statementsToSettle) {
      try {
        //  CRÍTICO: Recalcular totalPaid y totalCollected desde movimientos activos
        // Esto asegura que los totales estén actualizados si hubo cambios en los movimientos
        const totalPaid = statement.payments
          .filter(p => p.type === 'payment' && !p.isReversed)
          .reduce((sum, p) => sum + p.amount, 0);
        
        const totalCollected = statement.payments
          .filter(p => p.type === 'collection' && !p.isReversed)
          .reduce((sum, p) => sum + p.amount, 0);

        //  CORRECCIÓN CRÍTICA: NO recalcular remainingBalance
        // El remainingBalance ya está calculado correctamente cuando se creó/actualizó el statement
        // Recalcularlo aquí causa errores porque:
        // - statement.balance ya incluye movimientos: balance = sales - payouts - commission + totalPaid - totalCollected
        // - Si hacemos: remainingBalance = balance - totalCollected + totalPaid
        //   Resultado: remainingBalance = sales - payouts - commission + 2*totalPaid - 2*totalCollected (INCORRECTO)
        // 
        // El remainingBalance debe venir del cálculo progresivo desde sorteos/movimientos,
        // no de una fórmula que duplica movimientos
        // 
        // Solo actualizamos totalPaid y totalCollected para asegurar que estén sincronizados con los movimientos
        // El remainingBalance se mantiene como está (fue calculado correctamente cuando se creó el statement)

        //  CRÍTICO: NO usar calculateIsSettled (requiere remainingBalance ≈ 0)
        // Si llegó aquí, ya cumple los criterios:
        // - date < (today - settlementAgeDays)
        // - ticketCount > 0
        // - isSettled = false
        // Por lo tanto, debe asentarse directamente
        
        // Actualizar statement como asentado
        //  IMPORTANTE: NO actualizar remainingBalance, mantener el valor existente que es correcto
        await AccountStatementRepository.update(statement.id, {
          isSettled: true,
          canEdit: false,
          totalPaid,
          totalCollected,
          // remainingBalance NO se actualiza - mantener el valor correcto existente
          // accumulatedBalance NO se actualiza - mantener el valor correcto existente
          settledAt: new Date(),
          settledBy: userId || null, // null para automático, userId para manual
        });

        settledCount++;

        logger.info({
          layer: 'job',
          action: 'STATEMENT_SETTLED',
          payload: {
            statementId: statement.id,
            date: crDateService.postgresDateToCRString(statement.date),
            ventanaId: statement.ventanaId,
            vendedorId: statement.vendedorId,
            ticketCount: statement.ticketCount,
            totalPaid,
            totalCollected,
            remainingBalance: statement.remainingBalance,
            settledBy: userId || 'SYSTEM'
          }
        });
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
        cutoffDateCR: crDateService.postgresDateToCRString(cutoffDateCR),
        settlementAgeDays: config.settlementAgeDays,
        totalProcessed: statementsToSettle.length,
        settledCount,
        skippedCount,
        errorCount: errors.length,
        errors: errors.length > 0 ? errors : undefined,
        message: statementsToSettle.length === 0 
          ? 'No se encontraron estados de cuenta que cumplieran los criterios. Puede que ya estén todos asentados o que todos sean muy recientes.'
          : undefined
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

