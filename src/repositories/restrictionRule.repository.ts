// src/repositories/restrictionRule.repository.ts
import prisma from "../core/prismaClient";

export type EffectiveRestriction = {
  source: "USER" | "VENTANA" | "BANCA" | null;
  maxAmount: number | null;
  maxTotal: number | null;
};

export type CutoffSource = "USER" | "VENTANA" | "BANCA" | "DEFAULT";

export type EffectiveSalesCutoffDetailed = {
  minutes: number;
  source: CutoffSource;
};

type ListParams = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;
  number?: string;
  isActive?: boolean | string;
  page?: number | string;
  pageSize?: number | string;
  /** si 'true' lista solo reglas de cutoff */
  hasCutoff?: boolean | string;
  /** si 'true' lista solo reglas de montos */
  hasAmount?: boolean | string;
};

const includeLabels = {
  banca:   { select: { id: true, name: true, code: true } },
  ventana: { select: { id: true, name: true, code: true } },
  user:    { select: { id: true, name: true, username: true } },
} as const;

export const RestrictionRuleRepository = {
  async create(data: any) {
    return prisma.restrictionRule.create({ data });
  },

  async update(id: string, data: any) {
    return prisma.restrictionRule.update({ where: { id }, data });
  },

  async softDelete(id: string, _actorId: string, _reason?: string) {
    // baja lógica: isActive = false
    return prisma.restrictionRule.update({
      where: { id },
      data: { isActive: false, updatedAt: new Date() },
    });
  },

  async restore(id: string) {
    return prisma.restrictionRule.update({
      where: { id },
      data: { isActive: true },
    });
  },

  async findById(id: string) {
    return prisma.restrictionRule.findUnique({
      where: { id },
      include: includeLabels, // ← incluye banca/ventana/user para mostrar nombre/código
    });
  },

  /**
   * Listado con filtros + paginado (incluye filtros hasCutoff / hasAmount).
   */
  async list(params: ListParams) {
    const {
      bancaId,
      ventanaId,
      userId,
      number,
      isActive = true, // por defecto solo activas
      page = 1,
      pageSize = 20,
      hasCutoff,
      hasAmount,
    } = params;

    const _page = Math.max(1, Number(page) || 1);
    const _pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const skip = (_page - 1) * _pageSize;
    const take = _pageSize;

    // ✅ parseo correcto de boolean desde string
    const _isActive =
      typeof isActive === "string"
        ? isActive.toLowerCase() === "true"
        : Boolean(isActive);

    const _hasCutoff =
      typeof hasCutoff === "string"
        ? hasCutoff.toLowerCase() === "true"
        : Boolean(hasCutoff);

    const _hasAmount =
      typeof hasAmount === "string"
        ? hasAmount.toLowerCase() === "true"
        : Boolean(hasAmount);

    const where: any = {};
    // por default aplicamos isActive (true), pero si lo envían como string/boolean, respetamos:
    if (_isActive !== undefined) where.isActive = _isActive;
    if (bancaId) where.bancaId = bancaId;
    if (ventanaId) where.ventanaId = ventanaId;
    if (userId) where.userId = userId;
    if (number) where.number = number;

    if (_hasCutoff && _hasAmount) {
      // ambas clases de reglas
      where.OR = [
        { AND: [{ salesCutoffMinutes: { not: null } }, { number: null }] },
        { OR: [{ maxAmount: { not: null } }, { maxTotal: { not: null } }] },
      ];
    } else if (_hasCutoff) {
      // solo cutoff: sin number
      where.AND = [
        ...(where.AND ?? []),
        { salesCutoffMinutes: { not: null } },
        { number: null },
      ];
    } else if (_hasAmount) {
      // solo montos
      where.OR = [
        ...(where.OR ?? []),
        { maxAmount: { not: null } },
        { maxTotal: { not: null } },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.restrictionRule.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        skip,
        take,
        include: includeLabels, // ← incluye banca/ventana/user en el listado
      }),
      prisma.restrictionRule.count({ where }),
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
   * Límites de montos efectivos (USER > VENTANA > BANCA), con soporte de number y ventana temporal.
   * Solo considera reglas activas.
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

    // 🔎 reglas específicas (con number)
    const [userSpecific, ventanaSpecific, bancaSpecific] = await Promise.all([
      userId
        ? prisma.restrictionRule.findFirst({
            where: { userId, number, isActive: true, ...whereTime },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve(null),
      ventanaId
        ? prisma.restrictionRule.findFirst({
            where: { ventanaId, number, isActive: true, ...whereTime },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve(null),
      prisma.restrictionRule.findFirst({
        where: { bancaId, number, isActive: true, ...whereTime },
        orderBy: { updatedAt: "desc" },
      }),
    ]);

    // 🔎 reglas genéricas (sin number) si no hubo específica
    const [userGeneric, ventanaGeneric, bancaGeneric] = await Promise.all([
      userSpecific || !userId
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { userId, number: null, isActive: true, ...whereTime },
            orderBy: { updatedAt: "desc" },
          }),
      ventanaSpecific || !ventanaId
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { ventanaId, number: null, isActive: true, ...whereTime },
            orderBy: { updatedAt: "desc" },
          }),
      bancaSpecific
        ? Promise.resolve(null)
        : prisma.restrictionRule.findFirst({
            where: { bancaId, number: null, isActive: true, ...whereTime },
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
   * Cutoff efectivo con FUENTE (USER > VENTANA > BANCA) y ventana temporal.
   * Solo considera reglas activas.
   */
  async getEffectiveSalesCutoffWithSource(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    at?: Date;
  }): Promise<{ minutes: number | null; source: "USER" | "VENTANA" | "BANCA" | null }> {
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

    // Base para cutoff: debe ser activa, sin number, con minutos
    const baseWhere = (extra: any) => ({
      ...extra,
      isActive: true,
      salesCutoffMinutes: { not: null },
      number: null,
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

    if (userRule?.salesCutoffMinutes != null) {
      return { minutes: userRule.salesCutoffMinutes, source: "USER" };
    }
    if (ventanaRule?.salesCutoffMinutes != null) {
      return { minutes: ventanaRule.salesCutoffMinutes, source: "VENTANA" };
    }
    if (bancaRule?.salesCutoffMinutes != null) {
      return { minutes: bancaRule.salesCutoffMinutes, source: "BANCA" };
    }
    return { minutes: null, source: null };
  },

  /**
   * API ÚNICA para el resto del sistema:
   * - si hay regla → respeta minutos y fuente
   * - si no hay → fallback a `defaultCutoff` y source="DEFAULT"
   */
  async resolveSalesCutoff(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    defaultCutoff?: number;
  }): Promise<EffectiveSalesCutoffDetailed> {
    const { bancaId, ventanaId, userId, defaultCutoff = 5 } = params;
    const eff = await this.getEffectiveSalesCutoffWithSource({
      bancaId,
      ventanaId: ventanaId ?? null,
      userId: userId ?? null,
    });

    if (eff.minutes == null) {
      return { minutes: Math.max(0, defaultCutoff), source: "DEFAULT" };
    }
    return { minutes: Math.max(0, eff.minutes), source: eff.source! };
  },
};
