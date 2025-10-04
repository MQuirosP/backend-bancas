import prisma from './prismaClient';
import logger from './logger';
import { ActivityType, Prisma } from '@prisma/client';

export type ActivityPayload = {
  userId?: string | null;
  action: ActivityType;
  targetType?: string | null;
  targetId?: string | null;
  details?: Prisma.InputJsonValue | null;
  requestId?: string | null;
  layer?: string; // 'controller' | 'service' | 'repository' | etc
};

export const ActivityService = {
  async log(payload: ActivityPayload) {
    const { userId = null, action, targetType = null, targetId = null, details = null, requestId = null, layer = 'activity-service' } = payload;

    try {
      await prisma.activityLog.create({
        data: {
          userId,
          action,
          targetType,
          targetId,
          details: details ?? undefined,
        },
      });
    } catch (err) {
      logger.error({
        layer,
        action: 'SYSTEM_ACTION',
        userId,
        requestId,
        payload: { failedToPersistActivity: { action, targetType, targetId, details } },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      requestId,
      payload: { targetType, targetId, details },
    });
  },

  async logWithTx(tx: typeof prisma, payload: ActivityPayload) {
    const { userId = null, action, targetType = null, targetId = null, details = null, requestId = null, layer = 'activity-service' } = payload;
    try {
      await (tx as any).activityLog.create({
        data: { userId, action, targetType, targetId, details },
      });
    } catch (err) {
      logger.error({
        layer,
        action: 'SYSTEM_ACTION',
        userId,
        requestId,
        payload: { failedToPersistActivity: { action, targetType, targetId, details } },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      requestId,
      payload: { targetType, targetId, details },
    });
  },
};

export default ActivityService;
