// src/repositories/restrictionRule.repository.ts
import prisma from "../core/prismaClient";
import { getCRLocalComponents } from "../utils/businessDate";
import { SalesService } from "../api/v1/services/sales.service";

export type EffectiveRestriction = {
  source: "USER" | "VENTANA" | "BANCA" | null;
  maxAmount: number | null;
  maxTotal: number | null;
  baseAmount?: number | null;
  salesPercentage?: number | null;
  appliesToVendedor?: boolean | null;
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
  /** si 'true' lista solo reglas automáticas por fecha */
  hasAutoDate?: boolean | string;
  loteriaId?: string;
  multiplierId?: string;
};

const includeLabels = {
  banca: { select: { id: true, name: true, code: true } },
  ventana: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, name: true, username: true } },
  loteria: { select: { id: true, name: true } },
  multiplier: { select: { id: true, name: true, valueX: true, kind: true } },
} as const;

export const RestrictionRuleRepository = {
  async create(data: any) {
    // Filtrar solo los campos válidos del schema de Prisma
    const validData: any = {
      bancaId: data.bancaId ?? null,
      ventanaId: data.ventanaId ?? null,
      userId: data.userId ?? null,
      number: data.number ?? null,
      maxAmount: data.maxAmount ?? null,
      maxTotal: data.maxTotal ?? null,
      baseAmount: data.baseAmount ?? null,
      salesPercentage: data.salesPercentage ?? null,
      appliesToVendedor: data.appliesToVendedor ?? false,
      appliesToDate: data.appliesToDate ?? null,
      appliesToHour: data.appliesToHour ?? null,
      isActive: data.isActive ?? true,
      isAutoDate: data.isAutoDate ?? false,
      salesCutoffMinutes: data.salesCutoffMinutes ?? null,
      message: data.message ?? null,
      loteriaId: data.loteriaId ?? null,
      multiplierId: data.multiplierId ?? null,
    };

    return prisma.restrictionRule.create({
      data: validData,
      include: includeLabels,
    });
  },

  async update(id: string, data: any) {
    return prisma.restrictionRule.update({
      where: { id },
      data,
      include: includeLabels,
    });
  },

  async softDelete(id: string, _actorId: string, _reason?: string) {
    // baja lógica: isActive = false
    return prisma.restrictionRule.update({
      where: { id },
      data: { isActive: false, updatedAt: new Date() },
      include: includeLabels,
    });
  },

  async restore(id: string) {
    return prisma.restrictionRule.update({
      where: { id },
      data: { isActive: true },
      include: includeLabels,
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
      isActive, // Zod ya parsea esto a boolean, pero puede venir como string desde query params
      page = 1,
      pageSize = 20,
      hasCutoff,
      hasAmount,
      hasAutoDate,
      loteriaId,
      multiplierId,
    } = params;

    const _page = Math.max(1, Number(page) || 1);
    const _pageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const skip = (_page - 1) * _pageSize;
    const take = _pageSize;

    // ✅ Zod ya parsea correctamente los booleanos con enum + transform
    // Si no viene isActive, usar true por defecto (solo activas)
    const _isActive = isActive !== undefined ? isActive : true;

    // Los otros filtros de tipo son opcionales y Zod los parsea correctamente
    const _hasCutoff = hasCutoff === true;
    const _hasAmount = hasAmount === true;
    const _hasAutoDate = hasAutoDate !== undefined ? hasAutoDate : undefined;

    const where: any = {};
    // Aplicar filtro isActive siempre (por defecto true si no se especifica)
    where.isActive = _isActive;
    if (bancaId) where.bancaId = bancaId;
    if (ventanaId) where.ventanaId = ventanaId;
    if (userId) where.userId = userId;
    if (number) where.number = number;

    // Determinar si hay algún filtro de tipo especificado
    const hasAnyTypeFilter = _hasCutoff || _hasAmount || _hasAutoDate !== undefined || loteriaId || multiplierId;

    // Solo aplicar filtros de tipo si se especifican explícitamente
    if (hasAnyTypeFilter) {
      // Filtro para restricciones automáticas por fecha
      if (_hasAutoDate !== undefined) {
        where.isAutoDate = _hasAutoDate;
      }

      // Filtros de lotería/multiplicador
      if (loteriaId) where.loteriaId = loteriaId;
      if (multiplierId) where.multiplierId = multiplierId;

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
        // solo montos (incluye automáticas con maxAmount/maxTotal)
        where.OR = [
          ...(where.OR ?? []),
          { maxAmount: { not: null } },
          { maxTotal: { not: null } },
        ];
      }
    } else {
      // Si NO hay filtros de tipo, no aplicar ningún filtro de tipo (retornar TODAS las restricciones)
      // Esto incluye automáticas, de montos, de cutoff, y de lotería/multiplicador
    }

    // Optimización: Usar Promise.all en lugar de $transaction para mejor performance
    const [data, total] = await Promise.all([
      prisma.restrictionRule.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        skip,
        take,
        include: includeLabels,
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
   * Busca reglas generales aplicables a un contexto (Banca/Ventana)
   * que NO tienen usuario asignado.
   *
   * Retorna:
   * 1. Reglas Globales (bancaId=null, ventanaId=null)
   * 2. Reglas de la Banca (bancaId=X, ventanaId=null)
   * 3. Reglas de la Ventana (bancaId=X, ventanaId=Y)
   */
  async findGeneralRules(bancaId: string, ventanaId: string | null) {
    const orConditions: any[] = [
      // 1. Globales
      { bancaId: null, ventanaId: null },
      // 2. De la Banca
      { bancaId, ventanaId: null },
    ];

    if (ventanaId) {
      // 3. De la Ventana (debe coincidir banca también para consistencia, 
      // aunque ventanaId debería ser único, mejor ser explícito)
      orConditions.push({ bancaId, ventanaId });
    }

    return prisma.restrictionRule.findMany({
      where: {
        isActive: true,
        userId: null, // Solo reglas generales (sin usuario específico)
        OR: orConditions,
      },
      orderBy: { updatedAt: "desc" },
      include: includeLabels,
    });
  },

  /**
   * Límites de montos efectivos (USER > VENTANA > BANCA), con soporte de number y ventana temporal.
   * Solo considera reglas activas.
   * Ahora incluye soporte para isAutoDate y límites dinámicos (baseAmount + salesPercentage).
   */
  async getEffectiveLimits(params: {
    bancaId: string;
    ventanaId: string | null;
    userId: string | null;
    number?: string | null;
    at?: Date;
  }): Promise<EffectiveRestriction> {
    const { bancaId, ventanaId, userId } = params;
    let number = params.number?.trim() || null;
    const at = params.at ?? new Date();
    const hour = at.getHours();
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    // Si hay un número, también buscar restricciones automáticas por fecha
    let autoDateNumber: string | null = null;
    if (number) {
      // Obtener día del mes actual en CR
      const crComponents = getCRLocalComponents(at);
      autoDateNumber = String(crComponents.day).padStart(2, "0");
    }

    const whereTime = {
      AND: [
        { OR: [{ appliesToDate: null }, { appliesToDate: dateOnly }] },
        { OR: [{ appliesToHour: null }, { appliesToHour: hour }] },
      ],
    };

    // Construir condiciones para buscar reglas específicas
    // Incluye número directo Y restricciones automáticas por fecha
    const numberConditions: any[] = [];
    if (number) {
      numberConditions.push({ number });
    }
    if (autoDateNumber) {
      numberConditions.push({
        isAutoDate: true,
        number: autoDateNumber
      });
    }

    const numberWhere = numberConditions.length > 0
      ? { OR: numberConditions }
      : { number: null };

    // 🔎 reglas específicas (con number o isAutoDate)
    const [userSpecific, ventanaSpecific, bancaSpecific] = await Promise.all([
      userId
        ? prisma.restrictionRule.findFirst({
          where: {
            userId,
            isActive: true,
            ...whereTime,
            ...(number ? numberWhere : { number: null }),
          },
          orderBy: { updatedAt: "desc" },
        })
        : Promise.resolve(null),
      ventanaId
        ? prisma.restrictionRule.findFirst({
          where: {
            ventanaId,
            isActive: true,
            ...whereTime,
            ...(number ? numberWhere : { number: null }),
          },
          orderBy: { updatedAt: "desc" },
        })
        : Promise.resolve(null),
      prisma.restrictionRule.findFirst({
        where: {
          bancaId,
          isActive: true,
          ...whereTime,
          ...(number ? numberWhere : { number: null }),
        },
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
          baseAmount: r.baseAmount ?? null,
          salesPercentage: r.salesPercentage ?? null,
          appliesToVendedor: r.appliesToVendedor ?? null,
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
