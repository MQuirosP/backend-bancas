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
import { warmupConnection } from '../core/connectionWarmup';
import { AccountStatementRepository } from '../repositories/accountStatement.repository';
import logger from '../core/logger';
import { activeOperationsService } from '../core/activeOperations.service';

let settlementTimer: NodeJS.Timeout | null = null;

/**
 * Parse a very limited 5-field cron ("m h * * *") and return next Date in UTC.
 * Supports numeric minute/hour only (no ranges/lists/steps). Returns null if unsupported.
 */
function getNextRunFromCron(cronExpr: string, now: Date): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr] = parts;
  const minute = minStr === '*' ? 0 : Number(minStr);
  const hour = hourStr === '*' ? 0 : Number(hourStr);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  const candidate = new Date(now);
  candidate.setUTCHours(hour, minute, 0, 0);
  if (candidate <= now) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/**
 * Calculate milliseconds until next scheduled run
 * If cronSchedule is set in DB, respect it (minute/hour daily); fallback to 3 AM UTC.
 */
async function getMillisecondsUntilNextSettlement(): Promise<number> {
  const config = await prisma.accountStatementSettlementConfig.findFirst();
  const now = new Date();

  let next: Date | null = null;
  if (config?.cronSchedule) {
    next = getNextRunFromCron(config.cronSchedule, now);
    if (!next) {
      logger.warn({
        layer: 'job',
        action: 'SETTLEMENT_CRON_PARSE_FAILED',
        payload: { cronSchedule: config.cronSchedule, fallback: '03:00 UTC' }
      });
    }
  }

  if (!next) {
    next = new Date(now);
    next.setUTCHours(3, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
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
  carryForward?: {
    createdCount: number;
    skippedCount: number;
    errorCount: number;
  };
}> {
  // ✅ OPTIMIZACIÓN: Registrar operación activa para graceful shutdown
  const operationId = `settlement-${Date.now()}`;

  try {
    activeOperationsService.register(operationId, 'job', 'Account Statement Settlement Job');

    // 🔥 F3.1: Warmup del Pooler (puerto 6543) antes de empezar
    const isReady = await warmupConnection({ useDirect: false, context: 'settlement' });
    if (!isReady) {
      logger.error({
        layer: 'job',
        action: 'SETTLEMENT_SKIP',
        payload: { reason: 'Connection warmup failed' }
      });
      return {
        success: false,
        settledCount: 0,
        skippedCount: 0,
        errorCount: 1,
        executedAt: new Date(),
        errors: [{ statementId: 'CONNECTION', error: 'Connection warmup failed' }]
      };
    }
  } catch (error) {
    // Si el servidor está cerrando, rechazar la operación
    logger.warn({
      layer: 'job',
      action: 'SETTLEMENT_REJECTED_SHUTDOWN',
      payload: { message: (error as Error).message }
    });
    return {
      success: false,
      settledCount: 0,
      skippedCount: 0,
      errorCount: 1,
      executedAt: new Date(),
      errors: [{ statementId: 'SHUTDOWN', error: 'Server is shutting down' }]
    };
  }

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

    // ✅ SEGURIDAD: Validar límite superior de batchSize para prevenir memory issues
    const MAX_BATCH_SIZE = 2000;
    const safeBatchSize = Math.min(config.batchSize, MAX_BATCH_SIZE);

    if (config.batchSize > MAX_BATCH_SIZE) {
      logger.warn({
        layer: 'job',
        action: 'SETTLEMENT_BATCH_SIZE_CAPPED',
        payload: {
          configuredSize: config.batchSize,
          cappedSize: safeBatchSize,
          maxAllowed: MAX_BATCH_SIZE,
          message: `Batch size capped to ${MAX_BATCH_SIZE} to prevent memory issues`
        }
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

    // 📊 DIAGNÓSTICO: Obtener métricas consolidadas en una sola query (F2.1)
    const diagnosticsResult = await prisma.$queryRaw<any[]>`
      SELECT 
        COUNT(*)::int as "totalStatements",
        COUNT(*) FILTER (WHERE "isSettled" = true)::int as "settledStatementsCount",
        COUNT(*) FILTER (WHERE "isSettled" = false)::int as "notSettledCount",
        COUNT(*) FILTER (WHERE "isSettled" = false AND "date" < ${cutoffDateCR})::int as "notSettledOldEnoughCount"
      FROM "AccountStatement"
    `;

    const {
      totalStatements,
      settledStatementsCount,
      notSettledCount,
      notSettledOldEnoughCount
    } = diagnosticsResult[0];

    logger.info({
      layer: 'job',
      action: 'SETTLEMENT_START',
      payload: {
        cutoffDateCR: crDateService.postgresDateToCRString(cutoffDateCR),
        settlementAgeDays: config.settlementAgeDays,
        batchSize: safeBatchSize, // ← Usar safeBatchSize en lugar de config.batchSize
        executedBy: userId || 'SYSTEM',
        diagnostics: {
          totalStatements,
          settledStatementsCount,
          notSettledCount,
          notSettledOldEnoughCount
        }
      }
    });

    // 🚀 CRÍTICO: Buscar todos los statements antiguos (F2.2: Optimización de memoria - quitar include)
    const statementsToSettle = await prisma.accountStatement.findMany({
      where: {
        isSettled: false,
        date: {
          lt: cutoffDateCR
        }
      },
      orderBy: {
        date: 'asc' // Procesar desde más antiguo a más reciente
      },
      take: safeBatchSize // ← Usar safeBatchSize validado
    });

    // ⚡ OPTIMIZACIÓN (F2.2): Obtener totales de pagos agrupados por accountStatementId en un solo query
    const statementIds = statementsToSettle.map(s => s.id);
    const paymentTotals = statementIds.length > 0 
      ? await prisma.accountPayment.groupBy({
          by: ['accountStatementId', 'type'],
          where: {
            accountStatementId: { in: statementIds },
            isReversed: false
          },
          _sum: {
            amount: true
          }
        })
      : [];

    // Mapear totales a un objeto para búsqueda rápida
    const totalsMap = paymentTotals.reduce((acc, curr) => {
      if (!acc[curr.accountStatementId]) {
        acc[curr.accountStatementId] = { totalPaid: 0, totalCollected: 0 };
      }
      if (curr.type === 'payment') {
        acc[curr.accountStatementId].totalPaid = curr._sum.amount || 0;
      } else if (curr.type === 'collection') {
        acc[curr.accountStatementId].totalCollected = curr._sum.amount || 0;
      }
      return acc;
    }, {} as Record<string, { totalPaid: number, totalCollected: number }>);

    // ✅ ADVERTENCIA: Si llegamos al límite del batch, hay más registros pendientes
    if (statementsToSettle.length === safeBatchSize) {
      logger.info({
        layer: 'job',
        action: 'SETTLEMENT_MORE_RECORDS_AVAILABLE',
        payload: {
          batchSize: safeBatchSize,
          totalPending: notSettledOldEnoughCount,
          message: `Procesados ${safeBatchSize} registros. Quedan ${notSettledOldEnoughCount - safeBatchSize} pendientes para próxima ejecución.`
        }
      });
    }

    let settledCount = 0;
    let skippedCount = 0;
    const errors: Array<{ statementId: string; error: string }> = [];

    for (const statement of statementsToSettle) {
      try {
        // ⚡ OPTIMIZACIÓN (F2.2): Usar totales pre-calculados del mapa
        const { totalPaid = 0, totalCollected = 0 } = totalsMap[statement.id] || {};

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

    // ═══════════════════════════════════════════════════════════════════════════
    // FASE 2: ARRASTRE DE SALDOS
    // Crea statements para entidades sin actividad pero con saldo pendiente
    // Esto garantiza que siempre exista un AccountStatement actualizado
    // ═══════════════════════════════════════════════════════════════════════════
    let carryForwardCreated = 0;
    let carryForwardSkipped = 0;
    const carryForwardErrors: Array<{ entityId: string; error: string }> = [];

    try {
      logger.info({
        layer: 'job',
        action: 'CARRY_FORWARD_START',
        payload: { targetDate: todayCRStr }
      });

      // Obtener todas las entidades activas (3 dimensiones: banca, ventana, vendedor)
      const [activeBancas, activeVentanas, activeVendedores] = await Promise.all([
        prisma.banca.findMany({
          where: { isActive: true },
          select: { id: true }
        }),
        prisma.ventana.findMany({
          where: { isActive: true },
          select: { id: true, bancaId: true }
        }),
        prisma.user.findMany({
          where: {
            isActive: true,
            role: 'VENDEDOR',
            // Incluir TODOS los vendedores activos, con o sin ventana
            // Los vendedores sin ventana también tienen su propio saldo
          },
          select: { id: true, ventanaId: true, ventana: { select: { bancaId: true } } }
        })
      ]);

      // 🚀 OPTIMIZACIÓN (F2.3): Arrastre de saldos por Lotes (Batch Carry Forward)
      // 1. Obtener statements existentes hoy para evitar duplicados
      const existingToday = await prisma.accountStatement.findMany({
        where: { date: todayCR },
        select: { bancaId: true, ventanaId: true, vendedorId: true }
      });
      
      const existingKeySet = new Set(existingToday.map(s => 
        `${s.bancaId}-${s.ventanaId || 'null'}-${s.vendedorId || 'null'}`
      ));

      // 2. Obtener el último statement para cada entidad usando DISTINCT ON (Optimización Postgres)
      // --- BANCAS ---
      const latestBancaStatements = await prisma.$queryRaw<any[]>`
        SELECT DISTINCT ON ("bancaId") *
        FROM "AccountStatement"
        WHERE "ventanaId" IS NULL AND "vendedorId" IS NULL AND "date" < ${todayCR}
        ORDER BY "bancaId", "date" DESC
      `;

      // --- VENTANAS ---
      const latestVentanaStatements = await prisma.$queryRaw<any[]>`
        SELECT DISTINCT ON ("ventanaId") *
        FROM "AccountStatement"
        WHERE "ventanaId" IS NOT NULL AND "vendedorId" IS NULL AND "date" < ${todayCR}
        ORDER BY "ventanaId", "date" DESC
      `;

      // --- VENDEDORES ---
      const latestVendedorStatements = await prisma.$queryRaw<any[]>`
        SELECT DISTINCT ON ("vendedorId") *
        FROM "AccountStatement"
        WHERE "vendedorId" IS NOT NULL AND "date" < ${todayCR}
        ORDER BY "vendedorId", "date" DESC
      `;

      const toCreate: any[] = [];
      const effectiveMonth = todayCRStr.substring(0, 7);

      const activeBancaIds = new Set(activeBancas.map(b => b.id));
      const activeVentanaIds = new Set(activeVentanas.map(v => v.id));
      const activeVendedorIds = new Set(activeVendedores.map(v => v.id));

      // Procesar Bancas
      // ✅ ETAPA 2: NO filtramos entidades con saldo 0.
      // Necesitamos que TODAS existan para que getBySorteo encuentre lastDayAccumulated
      // sin disparar el fallback costoso de getStatementDirect.
      for (const ls of latestBancaStatements) {
        if (!activeBancaIds.has(ls.bancaId)) continue;
        const key = `${ls.bancaId}-null-null`;
        if (existingKeySet.has(key)) continue;
        
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: ls.bancaId,
          ventanaId: null,
          vendedorId: null,
          ticketCount: 0,
          totalSales: 0,
          totalPayouts: 0,
          listeroCommission: 0,
          vendedorCommission: 0,
          balance: 0,
          totalPaid: 0,
          totalCollected: 0,
          remainingBalance: Number(ls.remainingBalance),
          accumulatedBalance: Number(ls.accumulatedBalance || ls.remainingBalance),
          isSettled: false,
          canEdit: true
        });
      }

      // Procesar Ventanas
      for (const ls of latestVentanaStatements) {
        if (!activeVentanaIds.has(ls.ventanaId)) continue;
        const key = `${ls.bancaId}-${ls.ventanaId}-null`;
        if (existingKeySet.has(key)) continue;
        
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: ls.bancaId,
          ventanaId: ls.ventanaId,
          vendedorId: null,
          ticketCount: 0,
          totalSales: 0,
          totalPayouts: 0,
          listeroCommission: 0,
          vendedorCommission: 0,
          balance: 0,
          totalPaid: 0,
          totalCollected: 0,
          remainingBalance: Number(ls.remainingBalance),
          accumulatedBalance: Number(ls.accumulatedBalance || ls.remainingBalance),
          isSettled: false,
          canEdit: true
        });
      }

      // Procesar Vendedores
      for (const ls of latestVendedorStatements) {
        if (!activeVendedorIds.has(ls.vendedorId)) continue;
        const key = `${ls.bancaId}-null-${ls.vendedorId}`;
        if (existingKeySet.has(key)) continue;
        
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: ls.bancaId,
          ventanaId: null,
          vendedorId: ls.vendedorId,
          ticketCount: 0,
          totalSales: 0,
          totalPayouts: 0,
          listeroCommission: 0,
          vendedorCommission: 0,
          balance: 0,
          totalPaid: 0,
          totalCollected: 0,
          remainingBalance: Number(ls.remainingBalance),
          accumulatedBalance: Number(ls.accumulatedBalance || ls.remainingBalance),
          isSettled: false,
          canEdit: true
        });
      }

      // ✅ ETAPA 2 – SEGUNDA PASADA: Entidades sin historial previo
      // La consulta DISTINCT ON solo devuelve entidades que ya tienen algún AccountStatement.
      // Si una entidad es nueva y nunca tuvo actividad, nunca aparece en los resultados anteriores
      // y getBySorteo seguiría disparando el fallback costoso.
      // Aquí creamos un registro inicial de saldo cero para garantizar continuidad.
      const seenBancaIds = new Set(latestBancaStatements.map((s: any) => s.bancaId));
      const seenVentanaIds = new Set(latestVentanaStatements.map((s: any) => s.ventanaId));
      const seenVendedorIds = new Set(latestVendedorStatements.map((s: any) => s.vendedorId));

      for (const banca of activeBancas) {
        if (seenBancaIds.has(banca.id)) continue; // ya procesada en la primera pasada
        const key = `${banca.id}-null-null`;
        if (existingKeySet.has(key)) continue;
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: banca.id,
          ventanaId: null,
          vendedorId: null,
          ticketCount: 0, totalSales: 0, totalPayouts: 0,
          listeroCommission: 0, vendedorCommission: 0, balance: 0,
          totalPaid: 0, totalCollected: 0,
          remainingBalance: 0, accumulatedBalance: 0,
          isSettled: false, canEdit: true,
        });
      }

      for (const ventana of activeVentanas) {
        if (seenVentanaIds.has(ventana.id)) continue;
        const key = `${ventana.bancaId}-${ventana.id}-null`;
        if (existingKeySet.has(key)) continue;
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: ventana.bancaId,
          ventanaId: ventana.id,
          vendedorId: null,
          ticketCount: 0, totalSales: 0, totalPayouts: 0,
          listeroCommission: 0, vendedorCommission: 0, balance: 0,
          totalPaid: 0, totalCollected: 0,
          remainingBalance: 0, accumulatedBalance: 0,
          isSettled: false, canEdit: true,
        });
      }

      for (const vendor of activeVendedores) {
        if (seenVendedorIds.has(vendor.id)) continue;
        const bancaIdForVendor = vendor.ventana?.bancaId ?? null;
        // Si el vendedor no tiene ventana, omitir (no podemos inferir la banca)
        if (!bancaIdForVendor) continue;
        const key = `${bancaIdForVendor}-null-${vendor.id}`;
        if (existingKeySet.has(key)) continue;
        toCreate.push({
          date: todayCR,
          month: effectiveMonth,
          bancaId: bancaIdForVendor,
          ventanaId: null,
          vendedorId: vendor.id,
          ticketCount: 0, totalSales: 0, totalPayouts: 0,
          listeroCommission: 0, vendedorCommission: 0, balance: 0,
          totalPaid: 0, totalCollected: 0,
          remainingBalance: 0, accumulatedBalance: 0,
          isSettled: false, canEdit: true,
        });
      }

      if (toCreate.length > 0) {

        const result = await prisma.accountStatement.createMany({
          data: toCreate,
          skipDuplicates: true
        });
        carryForwardCreated = result.count;
      }

      carryForwardSkipped = (activeBancas.length + activeVentanas.length + activeVendedores.length) - carryForwardCreated;

      logger.info({
        layer: 'job',
        action: 'CARRY_FORWARD_COMPLETE',
        payload: {
          targetDate: todayCRStr,
          dimensions: {
            bancas: activeBancas.length,
            ventanas: activeVentanas.length,
            vendedores: activeVendedores.length,
          },
          createdCount: carryForwardCreated,
          skippedCount: carryForwardSkipped,
          errorCount: carryForwardErrors.length,
        }
      });
    } catch (error) {
      logger.error({
        layer: 'job',
        action: 'CARRY_FORWARD_ERROR',
        payload: { error: (error as Error).message }
      });
    }

    return {
      success: true,
      settledCount,
      skippedCount,
      errorCount: errors.length,
      executedAt: new Date(),
      errors: errors.length > 0 ? errors : undefined,
      carryForward: {
        createdCount: carryForwardCreated,
        skippedCount: carryForwardSkipped,
        errorCount: carryForwardErrors.length,
      }
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
  } finally {
    // ✅ CRÍTICO: Siempre desregistrar la operación al terminar (éxito o error)
    activeOperationsService.unregister(operationId);
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
