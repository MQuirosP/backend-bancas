import prisma from './prismaClient';
import logger from './logger';
import { ActivityType, Prisma } from '@prisma/client';

export type ActivityPayload = {
  userId?: string | null;
  action: ActivityType;
  targetType?: string | null;
  targetId?: string | null;
  details?: Prisma.InputJsonValue | null; // <- aceptamos null aquí
  requestId?: string | null;
  layer?: string; // 'controller' | 'service' | 'repository' | etc
};

function normalizeDetails(details: ActivityPayload['details']) {
  // Prisma exige: InputJsonValue | NullableJsonNullValueInput | undefined
  // Mapeo:
  //  - undefined => undefined (no manda el campo)
  //  - null      => Prisma.JsonNull (NULL real)
  //  - otro      => tal cual
  if (details === undefined) return undefined;
  if (details === null) return Prisma.JsonNull;
  return details;
}

export const ActivityService = {
  async log(payload: ActivityPayload) {
    const {
      userId = null,
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
          failedToPersistActivity: { action, targetType, targetId, details },
        },
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

  async logWithTx(tx: Prisma.TransactionClient, payload: ActivityPayload) {
    const {
      userId = null,
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
          failedToPersistActivity: { action, targetType, targetId, details },
        },
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
