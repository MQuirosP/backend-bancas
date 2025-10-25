// src/repositories/multiplierOverride.repository.ts
import prisma from "../core/prismaClient";

export const UserMultiplierOverrideRepository = {
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
        isActive: false,
      },
    });
  },

  // Restore
  async restore(id: string) {
    return prisma.userMultiplierOverride.update({
      where: { id },
      data: { isActive: true },
    });
  },

  async getById(id: string) {
    return prisma.userMultiplierOverride.findUnique({ where: { id } });
  },

  async findByUserAndLoteria(userId: string, loteriaId: string, multiplierType: string) {
    return prisma.userMultiplierOverride.findFirst({
      where: { userId, loteriaId, multiplierType, isActive: true },
    });
  },

  async list(params: { userId?: string; loteriaId?: string; skip: number; take: number }) {
    const { userId, loteriaId, skip, take } = params;
    const where: any = { isActive: true };
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

export default UserMultiplierOverrideRepository;
