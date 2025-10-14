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
  /** NUEVO (opcional): si 'true' lista solo reglas de cutoff */
  hasCutoff?: boolean | string;
  /** NUEVO (opcional): si 'true' lista solo reglas de montos */
  hasAmount?: boolean | string;
};

export const RestrictionRuleRepository = {
  async create(data: any) {
    return prisma.restrictionRule.create({ data });
  },

  async update(id: string, data: any) {
    return prisma.restrictionRule.update({ where: { id }, data });
  },

  async softDelete(id: string, _actorId: string, _reason?: string) {
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

  /**
   * Listado con filtros + paginado.
   * Añadimos filtros opcionales:
   *  - hasCutoff=true → solo reglas con salesCutoffMinutes != null y number == null
   *  - hasAmount=true → solo reglas con maxAmount/maxTotal
   *  (Si ambos true, se devuelven las que cumplan cualquiera de los dos grupos)
   */
  async list(params: ListParams) {
    const {
      bancaId,
      ventanaId,
      userId,
      number,
      isDeleted = false,
      page = 1,
      pageSize = 20,
      hasCutoff,
      hasAmount,
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

    const _hasCutoff =
      typeof hasCutoff === "string"
        ? hasCutoff.toLowerCase() === "true"
        : Boolean(hasCutoff);

    const _hasAmount =
      typeof hasAmount === "string"
        ? hasAmount.toLowerCase() === "true"
        : Boolean(hasAmount);

    // Filtros base
    const where: any = { isDeleted: _isDeleted };
    if (bancaId) where.bancaId = bancaId;
    if (ventanaId) where.ventanaId = ventanaId;
    if (userId) where.userId = userId;
    if (number) where.number = number;

    // Filtros por tipo de regla
    // - Cutoff: salesCutoffMinutes != null y number == null
    // - Amount: maxAmount != null o maxTotal != null
    if (_hasCutoff && _hasAmount) {
      where.OR = [
        { AND: [{ salesCutoffMinutes: { not: null } }, { number: null }] },
        { OR: [{ maxAmount: { not: null } }, { maxTotal: { not: null } }] },
      ];
    } else if (_hasCutoff) {
      where.AND = [
        ...(where.AND ?? []),
        { salesCutoffMinutes: { not: null } },
        { number: null },
      ];
    } else if (_hasAmount) {
      where.OR = [
        ...(where.OR ?? []),
        { maxAmount: { not: null } },
        { maxTotal: { not: null } },
      ];
    }

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

  /**
   * Límites de monto efectivos (USER > VENTANA > BANCA), con soporte de number y ventana temporal
   * (lo que ya tenías).
   */
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

  /**
   * NUEVO:
   * Resuelve el cutoff efectivo (minutos antes del sorteo) según reglas (USER > VENTANA > BANCA).
   * Considera ventana temporal (appliesToDate / appliesToHour) y SOLO reglas con salesCutoffMinutes (number debe ser null).
   */
  async getEffectiveSalesCutoff(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    at?: Date;
  }): Promise<number | null> {
    const { bancaId, ventanaId, userId } = params;
    const at = params.at ?? new Date();
    const hour = at.getHours();
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    const whereTime = {
      AND: [
        { OR: [{ appliesToDate: null }, { appliesToDate: dateOnly }] },
        { OR: [{ appliesToHour: null }, { appliesToHour: hour }] },
      ],
    };

    // Buscamos SOLO reglas de cutoff: salesCutoffMinutes != null y number == null
    const baseWhere = (extra: any) => ({
      ...extra,
      salesCutoffMinutes: { not: null },
      number: null,
      isDeleted: false,
      ...whereTime,
    });

    const [userRule, ventanaRule, bancaRule] = await Promise.all([
      userId
        ? prisma.restrictionRule.findFirst({
            where: baseWhere({ userId }),
            orderBy: { updatedAt: "desc" },
            select: { salesCutoffMinutes: true },
          })
        : Promise.resolve(null),
      ventanaId
        ? prisma.restrictionRule.findFirst({
            where: baseWhere({ ventanaId }),
            orderBy: { updatedAt: "desc" },
            select: { salesCutoffMinutes: true },
          })
        : Promise.resolve(null),
      prisma.restrictionRule.findFirst({
        where: baseWhere({ bancaId }),
        orderBy: { updatedAt: "desc" },
        select: { salesCutoffMinutes: true },
      }),
    ]);

    return (
      userRule?.salesCutoffMinutes ??
      ventanaRule?.salesCutoffMinutes ??
      bancaRule?.salesCutoffMinutes ??
      null
    );
  },

  /**
   * NUEVO helper:
   * Devuelve el cutoff efectivo usando reglas; si no hay, hace fallback a cutoff de Banca (si lo tienes en la tabla Banca) o a un default.
   */
  async resolveSalesCutoff(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    defaultCutoff?: number; // default si ninguna regla aplica
  }): Promise<number> {
    const { bancaId, ventanaId, userId, defaultCutoff = 5 } = params;

    const ruleCutoff = await this.getEffectiveSalesCutoff({
      bancaId,
      ventanaId: ventanaId ?? null,
      userId: userId ?? null,
      at: new Date(),
    });

    return ruleCutoff ?? defaultCutoff;
  },
};
