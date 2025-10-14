// src/repositories/multiplierOverride.repository.ts
import prisma from "../core/prismaClient";

export const MultiplierOverrideRepository = {
  async create(data: { userId: string; loteriaId: string; baseMultiplierX: number; multiplierType: string }) {
    return prisma.userMultiplierOverride.create({ data });
  },

  async update(id: string, data: { baseMultiplierX: number }) {
    return prisma.userMultiplierOverride.update({
      where: { id },
      data,
    });
  },

  // Soft-delete
  async delete(id: string, actorId: string, deletedReason?: string) {
    return prisma.userMultiplierOverride.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: actorId,
        deletedReason: deletedReason ?? null,
      },
    });
  },

  // Restore
  async restore(id: string) {
    return prisma.userMultiplierOverride.update({
      where: { id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      },
    });
  },

  async getById(id: string) {
    return prisma.userMultiplierOverride.findUnique({ where: { id } });
  },

  async findByUserAndLoteria(userId: string, loteriaId: string, multiplierType: string) {
    return prisma.userMultiplierOverride.findFirst({
      where: { userId, loteriaId, multiplierType, isDeleted: false },
    });
  },

  async list(params: { userId?: string; loteriaId?: string; skip: number; take: number }) {
    const { userId, loteriaId, skip, take } = params;
    const where: any = { isDeleted: false };
    if (userId) where.userId = userId;
    if (loteriaId) where.loteriaId = loteriaId;

    const [data, total] = await Promise.all([
      prisma.userMultiplierOverride.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.userMultiplierOverride.count({ where }),
    ]);

    return { data, total };
  },
};

export default MultiplierOverrideRepository;
