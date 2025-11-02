import prisma from '../core/prismaClient';
import { Prisma, ActivityType } from '@prisma/client';

interface ListActivityLogsParams {
  page: number;
  pageSize: number;
  userId?: string;
  action?: ActivityType;
  targetType?: string;
  targetId?: string;
  startDate?: Date;
  endDate?: Date;
}

const ActivityLogRepository = {
  async getById(id: string) {
    return prisma.activityLog.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            role: true,
          },
        },
      },
    });
  },

  async list(params: ListActivityLogsParams) {
    const {
      page,
      pageSize,
      userId,
      action,
      targetType,
      targetId,
      startDate,
      endDate,
    } = params;

    const skip = (page - 1) * pageSize;

    const where: Prisma.ActivityLogWhereInput = {
      ...(userId ? { userId } : {}),
      ...(action ? { action } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              name: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.activityLog.count({ where }),
    ]);

    return { data, total };
  },

  async listByUser(userId: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where: { userId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              name: true,
              role: true,
            },
          },
        },
      }),
      prisma.activityLog.count({ where: { userId } }),
    ]);

    return { data, total };
  },

  async listByTarget(targetType: string, targetId: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where: { targetType, targetId },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              name: true,
              role: true,
            },
          },
        },
      }),
      prisma.activityLog.count({ where: { targetType, targetId } }),
    ]);

    return { data, total };
  },

  async listByAction(action: ActivityType, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where: { action },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              name: true,
              role: true,
            },
          },
        },
      }),
      prisma.activityLog.count({ where: { action } }),
    ]);

    return { data, total };
  },

  async deleteOlderThan(days: number) {
    const date = new Date();
    date.setDate(date.getDate() - days);

    return prisma.activityLog.deleteMany({
      where: {
        createdAt: {
          lt: date,
        },
      },
    });
  },
};

export default ActivityLogRepository;
