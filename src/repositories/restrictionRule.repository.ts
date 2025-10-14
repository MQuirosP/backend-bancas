import prisma from "../core/prismaClient";

export type EffectiveRestriction = {
  source: "USER" | "VENTANA" | "BANCA" | null;
  maxAmount: number | null;
  maxTotal: number | null;
};

type ListParams = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;
  number?: string;
  isDeleted?: boolean | string; // default: false
  page?: number | string; // viene de query → string
  pageSize?: number | string; // viene de query → string
};

export const RestrictionRuleRepository = {
  async create(data: any) {
    return prisma.restrictionRule.create({ data });
  },

  async update(id: string, data: any) {
    return prisma.restrictionRule.update({ where: { id }, data });
  },

  async softDelete(id: string, actorId: string, reason?: string) {
    return prisma.restrictionRule.update({
      where: { id },
      data: { isDeleted: true, updatedAt: new Date() },
    });
  },

  async restore(id: string) {
    return prisma.restrictionRule.update({
      where: { id },
      data: { isDeleted: false },
    });
  },

  async findById(id: string) {
    return prisma.restrictionRule.findUnique({ where: { id } });
  },

  async list(params: ListParams) {
    const {
      bancaId,
      ventanaId,
      userId,
      number,
      isDeleted = false,
      page = 1,
      pageSize = 20,
    } = params;

    // COERCIÓN SEGURA
    const _page = Math.max(1, Number(page) || 1);
    const _pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const skip = (_page - 1) * _pageSize;
    const take = _pageSize;

    // Coerce a boolean real aunque venga como string
    const _isDeleted =
      typeof isDeleted === "string"
        ? isDeleted.toLowerCase() === "true"
        : Boolean(isDeleted);

    // Filtros
    const where: any = { isDeleted: _isDeleted };
    if (bancaId) where.bancaId = bancaId;
    if (ventanaId) where.ventanaId = ventanaId;
    if (userId) where.userId = userId;
    if (number) where.number = number;

    // Transacción: findMany + count
    const [data, total] = await prisma.$transaction([
      prisma.restrictionRule.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        skip,
        take,
      }),
      prisma.restrictionRule.count({
        where, // ← count correcto (sin select)
      }),
    ]);

    return {
      data,
      meta: {
        page: _page,
        pageSize: _pageSize,
        total,
        pages: Math.ceil(total / _pageSize),
      },
    };
  },

  async getEffectiveLimits(params: {
    bancaId: string;
    ventanaId: string | null;
    userId: string | null;
    number?: string | null;
    at?: Date;
  }): Promise<EffectiveRestriction> {
    const { bancaId, ventanaId, userId } = params;
    const number = params.number?.trim() || null;
    const at = params.at ?? new Date();
    const hour = at.getHours();
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    const whereTime = {
      AND: [
        { OR: [{ appliesToDate: null }, { appliesToDate: dateOnly }] },
        { OR: [{ appliesToHour: null }, { appliesToHour: hour }] },
      ],
    };

    const [userSpecific, ventanaSpecific, bancaSpecific] = await Promise.all([
      userId
        ? prisma.restrictionRule.findFirst({
            where: { userId, number, ...whereTime },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve(null),
      ventanaId
        ? prisma.restrictionRule.findFirst({
            where: { ventanaId, number, ...whereTime },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve(null),
      prisma.restrictionRule.findFirst({
        where: { bancaId, number, ...whereTime },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    const [userGeneric, ventanaGeneric, bancaGeneric] = await Promise.all([
      userSpecific || !userId
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { userId, number: null, ...whereTime },
            orderBy: { updatedAt: "desc" },
          }),
      ventanaSpecific || !ventanaId
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { ventanaId, number: null, ...whereTime },
            orderBy: { updatedAt: "desc" },
          }),
      bancaSpecific
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { bancaId, number: null, ...whereTime },
            orderBy: { updatedAt: "desc" },
          }),
    ]);

    const pick = (r: any, scope: EffectiveRestriction["source"]) =>
      r
        ? {
            source: scope,
            maxAmount: r.maxAmount ?? null,
            maxTotal: r.maxTotal ?? null,
          }
        : null;

    const chosen =
      pick(userSpecific, "USER") ||
      pick(ventanaSpecific, "VENTANA") ||
      pick(bancaSpecific, "BANCA") ||
      pick(userGeneric, "USER") ||
      pick(ventanaGeneric, "VENTANA") ||
      pick(bancaGeneric, "BANCA");

    return chosen || { source: null, maxAmount: null, maxTotal: null };
  },
};
