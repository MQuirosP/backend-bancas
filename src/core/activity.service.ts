import prisma from './prismaClient';
import logger from './logger';
import { ActivityType, Prisma } from '../generated/prisma/client';

export type ActivityPayload = {
  userId?: string | null;
  bancaId?: string | null;
  ventanaId?: string | null;
  action: ActivityType;
  targetType?: string | null;
  targetId?: string | null;
  details?: Prisma.InputJsonValue | null;
  requestId?: string | null;
  layer?: string; // 'controller' | 'service' | 'repository' | etc
};

function normalizeDetails(details: ActivityPayload['details']) {
  if (details === undefined) return undefined;
  if (details === null) return Prisma.JsonNull;
  return details;
}

export const ActivityService = {
  async log(payload: ActivityPayload) {
    const {
      userId = null,
      bancaId = null,
      action,
      targetType = null,
      targetId = null,
      details = null,
      requestId = null,
      layer = 'activity-service',
    } = payload;

    try {
      await prisma.activityLog.create({
        data: {
          userId,
          bancaId,
          action,
          targetType,
          targetId,
          details: normalizeDetails(details),
        },
      });
    } catch (err) {
      logger.error({
        layer,
        action: 'SYSTEM_ACTION',
        userId,
        requestId,
        payload: {
          failedToPersistActivity: { action, targetType, targetId, details, bancaId },
        },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      bancaId,
      requestId,
      payload: { targetType, targetId, details },
    });
  },

  async logWithTx(tx: Prisma.TransactionClient, payload: ActivityPayload) {
    const {
      userId = null,
      bancaId = null,
      action,
      targetType = null,
      targetId = null,
      details = null,
      requestId = null,
      layer = 'activity-service',
    } = payload;

    try {
      await tx.activityLog.create({
        data: {
          userId,
          bancaId,
          action,
          targetType,
          targetId,
          details: normalizeDetails(details),
        },
      });
    } catch (err) {
      logger.error({
        layer,
        action: 'SYSTEM_ACTION',
        userId,
        requestId,
        payload: {
          failedToPersistActivity: { action, targetType, targetId, details, bancaId },
        },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      bancaId,
      requestId,
      payload: { targetType, targetId, details },
    });
  },
};

export default ActivityService;
