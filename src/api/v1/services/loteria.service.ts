import prisma from '../../../core/prismaClient';
import { ActivityType, Prisma } from '@prisma/client';
import ActivityService from '../../../core/activity.service';
import logger from '../../../core/logger';
import { AppError } from '../../../core/errors';

export const LoteriaService = {
  async create(data: { name: string; rulesJson?: Record<string, any> }, userId: string, requestId?: string) {
    try {
      const loteria = await prisma.loteria.create({
        data: {
          name: data.name,
          rulesJson: data.rulesJson ?? {},
        },
      });

      logger.info({
        layer: 'service',
        action: 'LOTERIA_CREATE',
        userId,
        requestId,
        payload: { id: loteria.id, name: loteria.name },
      });

      await ActivityService.log({
        userId,
        action: ActivityType.LOTERIA_CREATE,
        targetType: 'LOTERIA',
        targetId: loteria.id,
        details: { name: loteria.name },
        requestId,
        layer: 'service',
      });

      return loteria;
    } catch (err) {
      logger.error({
        layer: 'service',
        action: 'LOTERIA_CREATE_ERROR',
        userId,
        requestId,
        meta: { message: (err as Error).message },
      });
      throw new AppError('Failed to create Lotería', 500);
    }
  },

  async getById(id: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id },
    });

    if (!loteria) {
      throw new AppError('Lotería not found', 404);
    }

    return loteria;
  },

  async list(params: { page?: number; pageSize?: number; isDeleted?: boolean }) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 10;
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.loteria.findMany({
        where: { isDeleted: params.isDeleted ?? false },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.loteria.count({ where: { isDeleted: params.isDeleted ?? false } }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  async update(id: string, data: Partial<{ name: string; rulesJson: Record<string, any> }>, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError('Lotería not found', 404);

    const updated = await prisma.loteria.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        rulesJson: (data.rulesJson as Prisma.InputJsonValue) ?? existing.rulesJson,

      },
    });

    logger.info({
      layer: 'service',
      action: 'LOTERIA_UPDATE',
      userId,
      requestId,
      payload: { id, changes: Object.keys(data) },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_UPDATE,
      targetType: 'LOTERIA',
      targetId: id,
      details: data,
      requestId,
      layer: 'service',
    });

    return updated;
  },

  async softDelete(id: string, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError('Lotería not found', 404);

    const deleted = await prisma.loteria.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: 'Deleted by admin',
      },
    });

    logger.warn({
      layer: 'service',
      action: 'LOTERIA_DELETE',
      userId,
      requestId,
      payload: { id },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_DELETE,
      targetType: 'LOTERIA',
      targetId: id,
      details: { reason: 'Deleted by admin' },
      requestId,
      layer: 'service',
    });

    return deleted;
  },

  async restore(id: string, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError('Lotería not found', 404);

    const restored = await prisma.loteria.update({
      where: { id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      },
    });

    logger.info({
      layer: 'service',
      action: 'LOTERIA_RESTORE',
      userId,
      requestId,
      payload: { id },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_RESTORE,
      targetType: 'LOTERIA',
      targetId: id,
      details: null,
      requestId,
      layer: 'service',
    });

    return restored;
  },
};

export default LoteriaService;
