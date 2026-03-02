// src/repositories/restrictionRule.repository.ts
import prisma from "../core/prismaClient";
import { withConnectionRetry } from "../core/withConnectionRetry";
import logger from "../core/logger";
import { Role } from "@prisma/client";
import { getCRLocalComponents } from "../utils/businessDate";
import { SalesService } from "../api/v1/services/sales.service";
import { getCachedCutoff, setCachedCutoff, invalidateRestrictionCaches, getCachedRestrictions, setCachedRestrictions } from "../utils/restrictionCache";

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

    const rule = await withConnectionRetry(
      () => prisma.restrictionRule.create({
        data: validData,
        include: includeLabels,
      }),
      { context: 'RestrictionRuleRepository.create' }
    );

    //  OPTIMIZACIÓN: Invalidar caché cuando se crea una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
  },

  async update(id: string, data: any) {
    const rule = await withConnectionRetry(
      () => prisma.restrictionRule.update({
        where: { id },
        data,
        include: includeLabels,
      }),
      { context: 'RestrictionRuleRepository.update' }
    );

    //  OPTIMIZACIÓN: Invalidar caché cuando se actualiza una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
  },

  async softDelete(id: string, _actorId: string, _reason?: string) {
    // baja lógica: isActive = false
    const rule = await withConnectionRetry(
      () => prisma.restrictionRule.update({
        where: { id },
        data: { isActive: false, updatedAt: new Date() },
        include: includeLabels,
      }),
      { context: 'RestrictionRuleRepository.softDelete' }
    );

    //  OPTIMIZACIÓN: Invalidar caché cuando se elimina (inactiva) una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
  },

  async restore(id: string) {
    const rule = await withConnectionRetry(
      () => prisma.restrictionRule.update({
        where: { id },
        data: { isActive: true },
        include: includeLabels,
      }),
      { context: 'RestrictionRuleRepository.restore' }
    );

    //  OPTIMIZACIÓN: Invalidar caché cuando se restaura una restricción
    await invalidateRestrictionCaches({
      bancaId: rule.bancaId || undefined,
      ventanaId: rule.ventanaId || undefined,
      userId: rule.userId || undefined,
    });

    return rule;
  },

  async findById(id: string) {
    return withConnectionRetry(
      () => prisma.restrictionRule.findUnique({
        where: { id },
        include: includeLabels, // ← incluye banca/ventana/user para mostrar nombre/código
      }),
      { context: 'RestrictionRuleRepository.findById' }
    );
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

    //  Zod ya parsea correctamente los booleanos con enum + transform
    // Si no viene isActive, usar true por defecto (solo activas)
    const _isActive = isActive !== undefined ? isActive : true;

    // Los otros filtros de tipo son opcionales y Zod los parsea correctamente
    const _hasCutoff = hasCutoff === true;
    const _hasAmount = hasAmount === true;
    const _hasAutoDate = hasAutoDate !== undefined ? hasAutoDate : undefined;

    const where: any = {};
    // Aplicar filtro isActive siempre (por defecto true si no se especifica)
    where.isActive = _isActive;
    
    //  CORRECCIÓN: Inferir bancaId cuando se consulta por bancaId pero las restricciones solo tienen ventanaId/vendedorId
    if (bancaId) {
        // Obtener ventanas y vendedores de esta banca para incluir sus restricciones
        const ventanas = await withConnectionRetry(
            () => prisma.ventana.findMany({
                where: { bancaId },
                select: { id: true },
            }),
            { context: 'RestrictionRuleRepository.list.fetchVentanas' }
        );
        const ventanaIds = ventanas.map(v => v.id);
        
        const vendedores = ventanaIds.length > 0 ? await withConnectionRetry(
            () => prisma.user.findMany({
                where: {
                    ventanaId: { in: ventanaIds },
                    role: Role.VENDEDOR,
                },
                select: { id: true },
            }),
            { context: 'RestrictionRuleRepository.list.fetchVendedores' }
        ) : [];
        const vendedorIds = vendedores.map(u => u.id);
        
        // Buscar restricciones que:
        // 1. Tengan bancaId directamente, O
        // 2. Tengan ventanaId de esta banca, O
        // 3. Tengan userId (vendedor) de esta banca
        const bancaOrConditions: any[] = [{ bancaId }];
        if (ventanaIds.length > 0) {
            bancaOrConditions.push({ ventanaId: { in: ventanaIds } });
        }
        if (vendedorIds.length > 0) {
            bancaOrConditions.push({ userId: { in: vendedorIds } });
        }
        
        // Si solo hay una condición, usar directamente, sino usar OR
        if (bancaOrConditions.length === 1) {
            Object.assign(where, bancaOrConditions[0]);
        } else {
            where.OR = bancaOrConditions;
        }
    } else {
        if (ventanaId) where.ventanaId = ventanaId;
        if (userId) where.userId = userId;
    }
    
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

      //  CRÍTICO: Combinar filtros de tipo con filtros de banca/ventana existentes
      // Si ya hay un OR de bancaId, necesitamos combinar con AND
      const typeFilterConditions: any[] = [];
      
      if (_hasCutoff && _hasAmount) {
        // ambas clases de reglas
        typeFilterConditions.push(
          { AND: [{ salesCutoffMinutes: { not: null } }, { number: null }] },
          { OR: [{ maxAmount: { not: null } }, { maxTotal: { not: null } }] }
        );
      } else if (_hasCutoff) {
        // solo cutoff: sin number
        typeFilterConditions.push(
          { salesCutoffMinutes: { not: null } },
          { number: null }
        );
      } else if (_hasAmount) {
        // solo montos (incluye automáticas con maxAmount/maxTotal)
        typeFilterConditions.push(
          { maxAmount: { not: null } },
          { maxTotal: { not: null } }
        );
      }
      
      // Si hay filtros de tipo, combinarlos con los filtros existentes usando AND
      if (typeFilterConditions.length > 0) {
        const existingConditions = { ...where };
        delete existingConditions.OR; // Separar OR si existe
        
        if (where.OR) {
          // Si ya hay OR (de bancaId), usar AND para combinar
          where.AND = [
            { OR: where.OR },
            ...(_hasCutoff && _hasAmount 
              ? [{ OR: typeFilterConditions }]
              : typeFilterConditions.length === 1 
                ? typeFilterConditions 
                : [{ OR: typeFilterConditions }]
            )
          ];
          delete where.OR;
        } else {
          // Si no hay OR, agregar directamente
          if (typeFilterConditions.length === 1) {
            Object.assign(where, typeFilterConditions[0]);
          } else if (_hasCutoff && _hasAmount) {
            where.OR = typeFilterConditions;
          } else {
            where.AND = [...(where.AND ?? []), ...typeFilterConditions];
          }
        }
      }
    } else {
      // Si NO hay filtros de tipo, no aplicar ningún filtro de tipo (retornar TODAS las restricciones)
      // Esto incluye automáticas, de montos, de cutoff, y de lotería/multiplicador
    }

    // Optimización: Usar Promise.all en lugar de $transaction para mejor performance
    const [data, total] = await withConnectionRetry(
      () => Promise.all([
        prisma.restrictionRule.findMany({
          where,
          orderBy: [{ updatedAt: "desc" }],
          skip,
          take,
          include: includeLabels,
        }),
        prisma.restrictionRule.count({ where }),
      ]),
      { context: 'RestrictionRuleRepository.list' }
    );

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

    return withConnectionRetry(
      () => prisma.restrictionRule.findMany({
        where: {
          isActive: true,
          userId: null, // Solo reglas generales (sin usuario específico)
          OR: orConditions,
        },
        orderBy: { updatedAt: "desc" },
        include: includeLabels,
      }),
      { context: 'RestrictionRuleRepository.findGeneralRules' }
    );
  },

  /**
   * Límites de montos efectivos (USER > VENTANA > BANCA), con soporte de number y ventana temporal.
   * Solo considera reglas activas.
   * Ahora incluye soporte para isAutoDate y límites dinámicos (baseAmount + salesPercentage).
   *  ACTUALIZADO: Soporte para restricciones de lotería y multiplicador usando sistema de puntaje.
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

    // Intentar obtener de caché si no hay filtros específicos (loteria/multiplier) que no estén contemplados en la key
    // Por ahora, la key de caché solo contempla banca/ventana/user/number.
    // Si hay loteriaId o multiplierId, evitamos el caché por ahora o extendemos la key.
    const isCacheable = !loteriaId && !multiplierId;
    if (isCacheable) {
      const cached = await getCachedRestrictions({ bancaId, ventanaId, userId, number });
      if (cached) return cached;
    }

    const at = params.at ?? new Date();
    const hour = at.getHours();

    // Normalizar fecha para comparación (sin hora)
    const dateOnly = new Date(at.getFullYear(), at.getMonth(), at.getDate());

    // 1. Obtener candidatos (Global, Banca, Ventana, Usuario)
    const candidateRules = await withConnectionRetry(
      () => prisma.restrictionRule.findMany({
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
      }),
      { context: 'RestrictionRuleRepository.getEffectiveLimits.candidateRules' }
    );

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

    if (applicable.length === 0) {
      return { source: null, maxAmount: null, maxTotal: null };
    }

    // Consolidar límites de forma acumulativa (más restrictivo gana)
    let minMaxAmount = Infinity;
    let minMaxTotal = Infinity;
    let sourceMaxAmount: EffectiveRestriction["source"] = null;
    let sourceMaxTotal: EffectiveRestriction["source"] = null;

    // Para campos adicionales, usamos la regla más específica (la primera por puntuación)
    const primaryRule = applicable[0].r;

    for (const { r } of applicable) {
      if (r.maxAmount != null && r.maxAmount < minMaxAmount) {
        minMaxAmount = r.maxAmount;
        sourceMaxAmount = r.userId ? "USER" : r.ventanaId ? "VENTANA" : r.bancaId ? "BANCA" : "GLOBAL";
      }
      if (r.maxTotal != null && r.maxTotal < minMaxTotal) {
        minMaxTotal = r.maxTotal;
        sourceMaxTotal = r.userId ? "USER" : r.ventanaId ? "VENTANA" : r.bancaId ? "BANCA" : "GLOBAL";
      }
    }

    // El source general será el de la regla más específica de las que impusieron los límites mínimos.
    // Priorizamos el source del maxTotal que suele ser el límite más dinámico/crítico.
    let finalSource: EffectiveRestriction["source"] =
      sourceMaxTotal || sourceMaxAmount || (primaryRule.userId ? "USER" : primaryRule.ventanaId ? "VENTANA" : primaryRule.bancaId ? "BANCA" : "GLOBAL");

    const result = {
      source: finalSource,
      maxAmount: minMaxAmount === Infinity ? null : minMaxAmount,
      maxTotal: minMaxTotal === Infinity ? null : minMaxTotal,
      baseAmount: primaryRule.baseAmount ?? null,
      salesPercentage: primaryRule.salesPercentage ?? null,
      appliesToVendedor: primaryRule.appliesToVendedor ?? null,
    };

    if (isCacheable) {
      await setCachedRestrictions({ bancaId, ventanaId, userId, number }, result);
    }

    return result;
  },

  /**
   * LÓGICA DE CUTOFF CONSOLIDADA (v2 — query única + scoring)
   *
   * Jerarquía de prioridad (score más alto gana):
   *   100  RestrictionRule con userId  exacto  → USER
   *    10  RestrictionRule con ventanaId exacto → VENTANA
   *     5  RestrictionRule con bancaId directo  → BANCA
   *     1  RestrictionRule en otra ventana de la misma banca → BANCA (fallback)
   *   ---  Banca.salesCutoffMinutes (tabla)     → BANCA
   *   ---  DEFAULT = 1 minuto
   *
   * Ventaja vs v1: una restricción creada con ventanaId (sin bancaId)
   * ahora se resuelve como fallback para TODOS los usuarios de la banca,
   * no solo para los de esa ventana específica.
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

    const timeFilters = [
      { OR: [{ appliesToDate: null }, { appliesToDate: dateOnly }] },
      { OR: [{ appliesToHour: null }, { appliesToHour: hour }] },
    ];

    // ── Round 1: ventana IDs de la banca + valor de tabla Banca (en paralelo)
    const [bancaVentanas, bancaTable] = await Promise.all([
      prisma.ventana.findMany({
        where: { bancaId },
        select: { id: true },
      }),
      prisma.banca.findUnique({
        where: { id: bancaId, isActive: true },
        select: { salesCutoffMinutes: true },
      }),
    ]);

    const allVentanaIds = bancaVentanas.map(v => v.id);

    // ── Round 2: query consolidada de candidatos
    const orConditions: any[] = [{ bancaId }];
    if (allVentanaIds.length > 0) {
      orConditions.push({ ventanaId: { in: allVentanaIds } });
    }
    if (userId) orConditions.push({ userId });

    const candidates = await prisma.restrictionRule.findMany({
      where: {
        isActive: true,
        salesCutoffMinutes: { not: null },
        number: null,
        OR: orConditions,
        AND: timeFilters,
      },
      select: {
        salesCutoffMinutes: true,
        userId: true,
        ventanaId: true,
        bancaId: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    // ── Scoring por especificidad
    const scored = candidates
      .map(r => {
        if (r.userId) {
          if (r.userId === userId) return { r, score: 100, source: 'USER' as CutoffSource };
          return null; // regla de otro usuario, ignorar
        }
        if (r.ventanaId) {
          if (r.ventanaId === ventanaId) return { r, score: 10, source: 'VENTANA' as CutoffSource };
          // ventana de la misma banca → fallback nivel BANCA
          return { r, score: 1, source: 'BANCA' as CutoffSource };
        }
        if (r.bancaId) {
          return { r, score: 5, source: 'BANCA' as CutoffSource };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score);

    // ── Jerarquía: scored rules → bancaTable → default
    let result: EffectiveSalesCutoffDetailed;

    if (scored.length > 0) {
      const winner = scored[0];
      result = { minutes: winner.r.salesCutoffMinutes!, source: winner.source };
    } else if (bancaTable?.salesCutoffMinutes != null) {
      result = { minutes: bancaTable.salesCutoffMinutes, source: 'BANCA' };
    } else {
      const safeDefault = (typeof defaultCutoff === 'number' && !isNaN(defaultCutoff)) ? defaultCutoff : 1;
      result = { minutes: Math.max(0, safeDefault), source: 'DEFAULT' };
    }

    logger.info({
      layer: 'repository',
      action: 'CUTOFF_RESOLVED',
      payload: {
        bancaId,
        ventanaId,
        userId,
        result,
        hierarchy: {
          rules: scored.map(({ r, score, source }) => ({
            salesCutoffMinutes: r.salesCutoffMinutes,
            source,
            score,
          })),
          bancaTable: bancaTable?.salesCutoffMinutes,
          default: defaultCutoff,
        },
        message: `Resolved cutoff: ${result.minutes} min from ${result.source}`,
      },
    });

    await setCachedCutoff({ bancaId, ventanaId, userId }, result);
    return result;
  },
};
