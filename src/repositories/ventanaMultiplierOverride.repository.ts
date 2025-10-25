import prisma from "../core/prismaClient";

export const VentanaMultiplierOverrideRepository = {
  async create(data: { ventanaId: string; loteriaId: string; baseMultiplierX: number; multiplierType: string }) {
    return prisma.ventanaMultiplierOverride.create({ data });
  },

  async update(id: string, data: { baseMultiplierX: number }) {
    return prisma.ventanaMultiplierOverride.update({
      where: { id },
      data,
    });
  },

  async delete(id: string, actorId: string, deletedReason?: string) {
    return prisma.ventanaMultiplierOverride.update({
      where: { id },
      data: {
        isActive: false,
      },
    });
  },

  async restore(id: string) {
    return prisma.ventanaMultiplierOverride.update({
      where: { id },
      data: {
        isActive: true,
      },
    });
  },

  async getById(id: string) {
    return prisma.ventanaMultiplierOverride.findUnique({ where: { id } });
  },

  async findByVentanaAndLoteria(ventanaId: string, loteriaId: string, multiplierType: string) {
    return prisma.ventanaMultiplierOverride.findFirst({
      where: { ventanaId, loteriaId, multiplierType, isActive: true }, // ✅
    });
  },

  async list(params: { ventanaId?: string; loteriaId?: string; skip: number; take: number }) {
    const { ventanaId, loteriaId, skip, take } = params;
    const where: any = { isActive: true }; // ✅

    if (ventanaId) where.ventanaId = ventanaId;
    if (loteriaId) where.loteriaId = loteriaId;

    const [data, total] = await Promise.all([
      prisma.ventanaMultiplierOverride.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.ventanaMultiplierOverride.count({ where }),
    ]);

    return { data, total };
  },
};

export default VentanaMultiplierOverrideRepository;
