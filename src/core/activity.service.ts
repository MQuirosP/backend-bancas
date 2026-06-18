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

async function resolveBancaId(
  tx: Prisma.TransactionClient,
  userId: string | null,
  targetType: string | null,
  targetId: string | null
): Promise<string | null> {
  // 1. Si el target es TICKET
  if (targetType === 'TICKET' && targetId) {
    try {
      const ticket = await tx.ticket.findUnique({
        where: { id: targetId },
        select: { bancaId: true },
      });
      if (ticket?.bancaId) return ticket.bancaId;
    } catch {}
  }

  // 2. Si el target es SORTEO
  if (targetType === 'SORTEO' && targetId) {
    try {
      const sorteo = await tx.sorteo.findUnique({
        where: { id: targetId },
        select: { bancaId: true },
      });
      if (sorteo?.bancaId) return sorteo.bancaId;
    } catch {}
  }

  // 3. Si el target es ACCOUNT_PAYMENT
  if (targetType === 'ACCOUNT_PAYMENT' && targetId) {
    try {
      const payment = await tx.accountPayment.findUnique({
        where: { id: targetId },
        select: { bancaId: true, ventanaId: true },
      });
      if (payment?.bancaId) return payment.bancaId;
      if (payment?.ventanaId) {
        const ventana = await tx.ventana.findUnique({
          where: { id: payment.ventanaId },
          select: { bancaId: true },
        });
        if (ventana?.bancaId) return ventana.bancaId;
      }
    } catch {}
  }

  // 4. Si el log involucra a un usuario (por ejemplo LOGIN)
  if (userId) {
    try {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          bancaId: true,
          ventanaId: true,
        },
      });
      if (user?.bancaId) return user.bancaId;
      if (user?.ventanaId) {
        const ventana = await tx.ventana.findUnique({
          where: { id: user.ventanaId },
          select: { bancaId: true },
        });
        if (ventana?.bancaId) return ventana.bancaId;
      }
    } catch {}
  }

  return null;
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

    let resolvedBancaId = payload.bancaId || null;

    try {
      await prisma.$transaction(async (tx) => {
        if (!resolvedBancaId) {
          resolvedBancaId = await resolveBancaId(tx, userId, targetType, targetId);
        }
        await tx.activityLog.create({
          data: {
            userId,
            bancaId: resolvedBancaId,
            action,
            targetType,
            targetId,
            details: normalizeDetails(details),
          },
        });
      });
    } catch (err) {
      logger.error({
        layer,
        action: 'SYSTEM_ACTION',
        userId,
        requestId,
        payload: {
          failedToPersistActivity: { action, targetType, targetId, details, bancaId: resolvedBancaId },
        },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      bancaId: resolvedBancaId,
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

    let resolvedBancaId = payload.bancaId || null;

    try {
      if (!resolvedBancaId) {
        resolvedBancaId = await resolveBancaId(tx, userId, targetType, targetId);
      }
      await tx.activityLog.create({
        data: {
          userId,
          bancaId: resolvedBancaId,
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
          failedToPersistActivity: { action, targetType, targetId, details, bancaId: resolvedBancaId },
        },
        meta: { error: (err as Error).message },
      });
      return;
    }

    logger.info({
      layer,
      action,
      userId,
      bancaId: resolvedBancaId,
      requestId,
      payload: { targetType, targetId, details },
    });
  },
};

export default ActivityService;
