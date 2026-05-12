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
  search?: string;
  bancaId?: string | null;
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
      search,
      bancaId,
    } = params;

    const skip = (page - 1) * pageSize;

    const where: Prisma.ActivityLogWhereInput = {
      bancaId: bancaId === undefined ? undefined : bancaId,
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
      ...(search
        ? {
            OR: [
              // Buscar en action como string (el enum se convierte a string en la query)
              { action: { in: Object.values(ActivityType).filter((a) => a.toLowerCase().includes(search.toLowerCase())) } as any },
              { targetType: { contains: search, mode: 'insensitive' } },
              { targetId: { contains: search, mode: 'insensitive' } },
              {
                user: {
                  OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { username: { contains: search, mode: 'insensitive' } },
                  ],
                },
              },
            ],
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

  async listByUser(userId: string, page = 1, pageSize = 20, bancaId?: string | null) {
    const skip = (page - 1) * pageSize;
    const where: Prisma.ActivityLogWhereInput = {
      userId,
      bancaId: bancaId === undefined ? undefined : bancaId,
    };

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
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
      prisma.activityLog.count({ where }),
    ]);

    return { data, total };
  },

  async listByTarget(targetType: string, targetId: string, page = 1, pageSize = 20, bancaId?: string | null) {
    const skip = (page - 1) * pageSize;
    const where: Prisma.ActivityLogWhereInput = {
      targetType,
      targetId,
      bancaId: bancaId === undefined ? undefined : bancaId,
    };

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
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
      prisma.activityLog.count({ where }),
    ]);

    return { data, total };
  },

  async listByAction(action: ActivityType, page = 1, pageSize = 20, bancaId?: string | null) {
    const skip = (page - 1) * pageSize;
    const where: Prisma.ActivityLogWhereInput = {
      action,
      bancaId: bancaId === undefined ? undefined : bancaId,
    };

    const [data, total] = await prisma.$transaction([
      prisma.activityLog.findMany({
        where,
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
      prisma.activityLog.count({ where }),
    ]);

    return { data, total };
  },

  async deleteOlderThan(days: number, bancaId?: string | null) {
    const date = new Date();
    date.setDate(date.getDate() - days);

    return prisma.activityLog.deleteMany({
      where: {
        createdAt: {
          lt: date,
        },
        bancaId: bancaId === undefined ? undefined : bancaId,
      },
    });
  },
};

export default ActivityLogRepository;
