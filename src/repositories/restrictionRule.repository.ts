// src/repositories/restrictionRule.repository.ts
import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { getCRLocalComponents } from "../utils/businessDate";
import { SalesService } from "../api/v1/services/sales.service";
import { getCachedCutoff, setCachedCutoff, invalidateRestrictionCaches } from "../utils/restrictionCache";

export type EffectiveRestriction = {
  source: "USER" | "VENTANA" | "BANCA" | "GLOBAL" | null;
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

    const rule = await prisma.restrictionRule.create({
      data: validData,
      include: includeLabels,
    });

    // ✅ OPTIMIZACIÓN: Invalidar caché cuando se crea una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
  },

  async update(id: string, data: any) {
    const rule = await prisma.restrictionRule.update({
      where: { id },
      data,
      include: includeLabels,
    });

    // ✅ OPTIMIZACIÓN: Invalidar caché cuando se actualiza una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
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
   * 3. Reglas de la Ventana (ventanaId=Y, bancaId se infiere desde la relación Ventana->Banca)
   */
  async findGeneralRules(bancaId: string, ventanaId: string | null) {
    const orConditions: any[] = [
      // 1. Globales
      { bancaId: null, ventanaId: null },
      // 2. De la Banca
      { bancaId, ventanaId: null },
    ];

    if (ventanaId) {
      // 3. De la Ventana (solo por ventanaId, el bancaId se infiere automáticamente desde la relación)
      // No requerimos bancaId aquí porque las restricciones de ventana tienen bancaId=null
      orConditions.push({ ventanaId });
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
   * ✅ ACTUALIZADO: Soporte para restricciones de lotería y multiplicador usando sistema de puntaje.
   */
  async getEffectiveLimits(params: {
    bancaId: string;
    ventanaId: string | null;
    userId: string | null;
    number?: string | null;
    loteriaId?: string | null;
    multiplierId?: string | null;
    at?: Date;
  }): Promise<EffectiveRestriction> {
    const { bancaId, ventanaId, userId, loteriaId, multiplierId } = params;
    let number = params.number?.trim() || null;
    const at = params.at ?? new Date();
    const hour = at.getHours();

    // Normalizar fecha para comparación (sin hora)
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    // 1. Obtener candidatos (Global, Banca, Ventana, Usuario)
    const candidateRules = await prisma.restrictionRule.findMany({
      where: {
        isActive: true,
        OR: [
          { userId },
          { ventanaId },
          { bancaId },
          // Reglas globales (incluyendo específicas de lotería sin scope de usuario)
          { AND: [{ userId: null }, { ventanaId: null }, { bancaId: null }] }
        ],
      },
      include: {
        loteria: true,
        multiplier: true,
      }
    });

    // 2. Filtrar y Puntuar reglas
    const applicable = candidateRules
      .filter((r) => {
        // Filtro de Tiempo (Fecha y Hora)
        if (r.appliesToDate) {
          const ruleDate = new Date(r.appliesToDate);
          if (ruleDate.getTime() !== dateOnly.getTime()) return false;
        }
        if (typeof r.appliesToHour === "number" && r.appliesToHour !== hour) {
          return false;
        }

        // Filtro de Lotería/Multiplicador (si se solicita para una lotería específica)
        if (loteriaId) {
          // Si la regla tiene lotería, debe coincidir. Si es null (global), aplica.
          if (r.loteriaId && r.loteriaId !== loteriaId) return false;
        }
        if (multiplierId) {
          if (r.multiplierId && r.multiplierId !== multiplierId) return false;
        }

        // Filtro de Número
        if (number) {
          // Si la regla es isAutoDate, resolver el número automático
          if (r.isAutoDate) {
            const crComponents = getCRLocalComponents(at);
            const autoNumber = String(crComponents.day).padStart(2, "0");
            if (autoNumber !== number) return false;
          } else if (r.number) {
            // Si la regla tiene números explícitos (string o lista separada por comas en DB legacy, aunque schema dice String?)
            // El schema define 'number' como String?. Asumimos string exacto o manejo array en lógica superior.
            // Para validación simple de igualdad:
            if (r.number !== number) return false;
            // NOTA: Si 'number' en DB soporta listas (ej "15,20"), esta validación simple fallaría.
            // Pero `ticket.repository` usa `resolveNumbersToValidate`.
            // Para `getEffectiveLimits` (consulta UI), asumimos coincidencia exacta o global (null).
            // Si hay necesidad de listas complejas, la UI debería iterar.
          }
        } else {
          // Si NO pedimos un número específico (consulta general),
          // ¿deberíamos incluir reglas que SON para números específicos?
          // Generalmente `getEffectiveLimits` sin número pide el "Límite General".
          // Reglas con número específico no aplican al "Límite General".
          if (r.number || r.isAutoDate) return false;
        }

        return true;
      })
      .map((r) => {
        let score = 0;
        // Sistema de puntaje similar a ticket.repository.ts
        if (r.loteriaId && r.multiplierId) score += 10000;
        else if (r.loteriaId) score += 5000;

        if (r.number || r.isAutoDate) score += 1000;

        if (r.userId) score += 100;
        else if (r.ventanaId) score += 10;
        else if (r.bancaId) score += 1;

        return { r, score };
      })
      .sort((a, b) => b.score - a.score);

    const bestRule = applicable[0]?.r;

    if (!bestRule) {
      return { source: null, maxAmount: null, maxTotal: null };
    }

    // Determinar fuente para respuesta
    let source: EffectiveRestriction["source"] = "GLOBAL";
    if (bestRule.userId) source = "USER";
    else if (bestRule.ventanaId) source = "VENTANA";
    else if (bestRule.bancaId) source = "BANCA";

    // Si es regla de lotería global, source sigue siendo GLOBAL (o podría ser LOTTERY si existiera en el tipo)

    return {
      source,
      maxAmount: bestRule.maxAmount ?? null,
      maxTotal: bestRule.maxTotal ?? null,
      baseAmount: bestRule.baseAmount ?? null,
      salesPercentage: bestRule.salesPercentage ?? null,
      appliesToVendedor: bestRule.appliesToVendedor ?? null,
    };
  },

  /**
   * LÓGICA DE CUTOFF CONSOLIDADA
   *
   * Concepto: El cutoff más ALTO (más restrictivo) siempre gana
   * - DEFAULT = 1 minuto (más permisivo: venta permitida hasta 1 min antes)
   * - RESTRICCIÓN = 5 minutos (más restrictivo: venta bloqueada a 5 min antes)
   *
   * Prioridad (se usa el MÁS ALTO de todos):
   * 1. RestrictionRule.USER
   * 2. RestrictionRule.VENTANA
   * 3. RestrictionRule.BANCA
   * 4. Banca.salesCutoffMinutes (tabla directa)
   * 5. DEFAULT = 1 minuto (fallback si nada configurado)
   *
   * Ejemplo:
   * - USER: 2 min, VENTANA: 5 min, BANCA: 3 min → Usa 5 min (VENTANA)
   * - Sin restricciones, Banca tiene 3 min → Usa 3 min (BANCA)
   * - Sin nada → Usa 1 min (DEFAULT)
   */
  async resolveSalesCutoff(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    defaultCutoff?: number;
  }): Promise<EffectiveSalesCutoffDetailed> {
    const { bancaId, ventanaId, userId, defaultCutoff = 1 } = params;

    // Intentar obtener de caché
    const cached = await getCachedCutoff({ bancaId, ventanaId, userId });
    if (cached && typeof cached.minutes === 'number' && !isNaN(cached.minutes) && cached.minutes >= 0) {
      return cached;
    }

    const at = new Date();
    const hour = at.getHours();
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    const whereTime = {
      AND: [
        { OR: [{ appliesToDate: null }, { appliesToDate: dateOnly }] },
        { OR: [{ appliesToHour: null }, { appliesToHour: hour }] },
      ],
    };

    const baseWhere = (extra: any) => ({
      ...extra,
      isActive: true,
      salesCutoffMinutes: { not: null },
      number: null,
      ...whereTime,
    });

    // Buscar TODAS las restricciones en paralelo (RestrictionRule + Banca tabla)
    const [userRule, ventanaRule, bancaRule, bancaTable] = await Promise.all([
      userId
        ? prisma.restrictionRule.findFirst({
          where: baseWhere({ userId }),
          orderBy: { updatedAt: "desc" },
          select: { salesCutoffMinutes: true },
        })
        : null,
      ventanaId
        ? prisma.restrictionRule.findFirst({
          where: baseWhere({ ventanaId }),
          orderBy: { updatedAt: "desc" },
          select: { salesCutoffMinutes: true },
        })
        : null,
      prisma.restrictionRule.findFirst({
        where: baseWhere({ bancaId }),
        orderBy: { updatedAt: "desc" },
        select: { salesCutoffMinutes: true },
      }),
      prisma.banca.findUnique({
        where: { id: bancaId, isActive: true },
        select: { salesCutoffMinutes: true },
      }),
    ]);

    // Recolectar todos los candidatos válidos
    const candidates: Array<{ minutes: number; source: "USER" | "VENTANA" | "BANCA" | "DEFAULT" }> = [];

    if (userRule?.salesCutoffMinutes != null) {
      candidates.push({ minutes: userRule.salesCutoffMinutes, source: "USER" });
    }
    if (ventanaRule?.salesCutoffMinutes != null) {
      candidates.push({ minutes: ventanaRule.salesCutoffMinutes, source: "VENTANA" });
    }
    if (bancaRule?.salesCutoffMinutes != null) {
      candidates.push({ minutes: bancaRule.salesCutoffMinutes, source: "BANCA" });
    }
    if (bancaTable?.salesCutoffMinutes != null) {
      candidates.push({ minutes: bancaTable.salesCutoffMinutes, source: "BANCA" });
    }

    // Si no hay restricciones, usar DEFAULT
    if (candidates.length === 0) {
      const safeDefault = (typeof defaultCutoff === 'number' && !isNaN(defaultCutoff)) ? defaultCutoff : 1;
      const result = { minutes: Math.max(0, safeDefault), source: "DEFAULT" as const };

      logger.info({
        layer: 'repository',
        action: 'CUTOFF_USING_DEFAULT',
        payload: { bancaId, ventanaId, userId, minutes: result.minutes, source: result.source }
      });

      await setCachedCutoff({ bancaId, ventanaId, userId }, result);
      return result;
    }

    // Encontrar el MÁS RESTRICTIVO (el que tiene más minutos)
    const mostRestrictive = candidates.reduce((max, current) =>
      current.minutes > max.minutes ? current : max
    );

    const result = {
      minutes: Math.max(0, mostRestrictive.minutes),
      source: mostRestrictive.source
    };

    logger.info({
      layer: 'repository',
      action: 'CUTOFF_RESOLVED',
      payload: {
        bancaId,
        ventanaId,
        userId,
        result,
        allCandidates: candidates,
        message: `Using most restrictive cutoff: ${result.minutes} min from ${result.source}`
      }
    });

    await setCachedCutoff({ bancaId, ventanaId, userId }, result);
    return result;
  },
};
