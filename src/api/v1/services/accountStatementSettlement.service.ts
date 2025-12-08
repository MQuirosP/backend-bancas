// src/api/v1/services/accountStatementSettlement.service.ts
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import logger from '../../../core/logger';

/**
 * Obtiene o crea la configuración de asentamiento automático (singleton)
 */
async function getOrCreateConfig() {
  let config = await prisma.accountStatementSettlementConfig.findFirst();
  
  if (!config) {
    config = await prisma.accountStatementSettlementConfig.create({
      data: {
        enabled: false,
        settlementAgeDays: 7,
        batchSize: 1000,
      },
    });
    logger.info({
      layer: 'service',
      action: 'ACCOUNT_STATEMENT_SETTLEMENT_CONFIG_CREATED',
      payload: { configId: config.id },
    });
  }
  
  return config;
}

export const AccountStatementSettlementService = {
  /**
   * Obtiene la configuración actual
   */
  async getConfig() {
    const config = await getOrCreateConfig();
    return {
      enabled: config.enabled,
      settlementAgeDays: config.settlementAgeDays,
      cronSchedule: config.cronSchedule,
      batchSize: config.batchSize,
      lastExecution: config.lastExecution,
      lastSettledCount: config.lastSettledCount,
      lastSkippedCount: config.lastSkippedCount,
      lastErrorCount: config.lastErrorCount,
      lastErrorMessage: config.lastErrorMessage,
      updatedAt: config.updatedAt,
    };
  },

  /**
   * Actualiza la configuración
   */
  async updateConfig(data: {
    enabled?: boolean;
    settlementAgeDays?: number;
    cronSchedule?: string | null;
    batchSize?: number;
  }, userId: string) {
    const config = await getOrCreateConfig();
    
    // Validaciones
    if (data.settlementAgeDays !== undefined) {
      if (data.settlementAgeDays < 1 || data.settlementAgeDays > 365) {
        throw new AppError('settlementAgeDays debe estar entre 1 y 365', 400);
      }
    }
    if (data.batchSize !== undefined) {
      if (data.batchSize < 100 || data.batchSize > 10000) {
        throw new AppError('batchSize debe estar entre 100 y 10000', 400);
      }
    }
    
    const updated = await prisma.accountStatementSettlementConfig.update({
      where: { id: config.id },
      data: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.settlementAgeDays !== undefined && { settlementAgeDays: data.settlementAgeDays }),
        ...(data.cronSchedule !== undefined && { cronSchedule: data.cronSchedule }),
        ...(data.batchSize !== undefined && { batchSize: data.batchSize }),
        updatedBy: userId,
      },
    });

    logger.info({
      layer: 'service',
      action: 'ACCOUNT_STATEMENT_SETTLEMENT_CONFIG_UPDATE',
      userId,
      payload: data,
    });

    return {
      enabled: updated.enabled,
      settlementAgeDays: updated.settlementAgeDays,
      cronSchedule: updated.cronSchedule,
      batchSize: updated.batchSize,
      lastExecution: updated.lastExecution,
      lastSettledCount: updated.lastSettledCount,
      lastSkippedCount: updated.lastSkippedCount,
      lastErrorCount: updated.lastErrorCount,
      lastErrorMessage: updated.lastErrorMessage,
      updatedAt: updated.updatedAt,
    };
  },

  /**
   * Ejecuta el asentamiento manualmente
   */
  async executeSettlement(userId: string) {
    const { executeSettlement } = await import('../../../jobs/accountStatementSettlement.job');
    return await executeSettlement(userId);
  },

  /**
   * Obtiene el estado de salud del job
   */
  async getHealthStatus() {
    const config = await getOrCreateConfig();
    
    // Calcular próxima ejecución programada
    const nextExecution = config.lastExecution
      ? new Date(config.lastExecution.getTime() + 24 * 60 * 60 * 1000) // +24 horas
      : null;

    return {
      enabled: config.enabled,
      lastExecution: config.lastExecution,
      nextScheduledExecution: nextExecution,
      lastSettledCount: config.lastSettledCount,
      lastSkippedCount: config.lastSkippedCount,
      lastErrorCount: config.lastErrorCount,
      lastErrorMessage: config.lastErrorMessage,
    };
  }
};

export default AccountStatementSettlementService;

