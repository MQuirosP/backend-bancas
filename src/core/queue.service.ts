import { Queue } from 'bullmq';
import logger from './logger';
import { RedisProvider } from '../infrastructure/redis/RedisProvider';

// Configuración para productores (Queue) - Usar conexión centralizada Fail-Fast
const connection = RedisProvider.getQueueConnection();

export const sorteoEvaluationQueue = new Queue('sorteo-evaluation', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const QueueService = {
  /**
   * Encola el proceso completo de evaluación de un sorteo (Marcado de ganadores + Sync contable)
   */
  async addSorteoEvaluation(data: {
    sorteoId: string;
    winningNumber: string;
    extraMultiplierId?: string | null;
    extraX: number;
    extraOutcomeCode?: string | null;
    scheduledAt: Date;
    userId: string;
  }) {
    try {
      await sorteoEvaluationQueue.add('evaluate-sorteo-complete', {
        ...data,
        scheduledAt: data.scheduledAt.toISOString(),
      });
      logger.info({
        layer: 'queue',
        action: 'ADD_SORTEO_EVALUATION',
        payload: { sorteoId: data.sorteoId },
      });
    } catch (error) {
      logger.error({
        layer: 'queue',
        action: 'ADD_SORTEO_EVALUATION_ERROR',
        payload: { sorteoId: data.sorteoId, error: (error as Error).message },
      });
    }
  },

  /**
   * Encola la sincronización de statements (usado en reversión)
   */
  async addSorteoEvaluationSync(sorteoId: string, scheduledAt: Date) {
    try {
      await sorteoEvaluationQueue.add('sync-sorteo-statements', {
        sorteoId,
        scheduledAt: scheduledAt.toISOString(),
      });
      logger.info({
        layer: 'queue',
        action: 'ADD_SORTEO_EVALUATION_SYNC',
        payload: { sorteoId },
      });
    } catch (error) {
      logger.error({
        layer: 'queue',
        action: 'ADD_SORTEO_EVALUATION_SYNC_ERROR',
        payload: { sorteoId, error: (error as Error).message },
      });
    }
  },
};
