import { ReportDimension } from '../types/enums/report.enum';
import prisma from "../core/prismaClient";
import { Prisma, TicketStatus, Role, BetType, SorteoStatus, OverrideScope } from '../generated/prisma/client';
import { withConnectionRetry } from "../core/withConnectionRetry";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { withTransactionRetry } from "../core/withTransactionRetry";
import { CommissionSnapshot } from "../services/commission/types/CommissionTypes";
import { CommissionContext } from "../services/commission/types/CommissionContext";
import { commissionService } from "../services/commission/CommissionService";
import { commissionResolver } from "../services/commission/CommissionResolver";
import { getBusinessDateCRInfo, getCRDayRangeUTC, getCRLocalComponents } from "../utils/businessDate";
import { nowCR, validateDate, formatDateCRWithTZ } from "../utils/datetime";
import { v4 as uuidv4 } from "uuid";
import { resolveNumbersToValidate, validateMaxTotalForNumbers, validateRulesInParallel, ScopeCache, calculateAccumulatedByNumbersAndScope, calculateAccumulatedForMultipleScopes, acquireLock, releaseLock } from "./helpers/ticket-restriction.helper";
import { getRedisClient, isRedisAvailable, markRedisError } from "../core/redisClient";
import { CacheService } from "../core/cache.service";
import { DailyNumberSalesService } from "../api/v1/services/dailyNumberSales.service";
import {
  CreateTicketInput,
  CreateTicketOptions,
  TicketWarning,
} from "../services/ticket/ticket.types";
import { TicketConcurrencyManager } from "../services/ticket/TicketConcurrencyManager";
import { TicketPrefetchService } from "../services/ticket/TicketPrefetchService";
import { TicketNumberGenerator } from "../services/ticket/TicketNumberGenerator";
import { TicketRiskValidator } from "../services/ticket/TicketRiskValidator";
import { TicketCommissionCalculator } from "../services/ticket/TicketCommissionCalculator";
import { TicketPersistenceService } from "../services/ticket/TicketPersistenceService";
import { TicketRedisAccumulator } from "../services/ticket/TicketRedisAccumulator";
import { TicketTimeoutCalculator } from "../services/ticket/TicketTimeoutCalculator";
import { TicketResponseBuilder } from "../services/ticket/TicketResponseBuilder";

export type { CreateTicketInput, CreateTicketOptions, TicketWarning };


const RULES_CACHE_TTL_SECONDS = 120; // 2 minutos en Redis

export function buildRulesCacheKey(params: {
  userId: string;
  ventanaId: string;
  bancaId: string;
}): string {
  return `rules:${params.userId}:${params.ventanaId}:${params.bancaId}`;
}

export async function getCachedRestrictionRules<T = unknown>(key: string): Promise<T[] | null> {
  return CacheService.get<T[]>(key);
}

export async function setCachedRestrictionRules<T = unknown>(key: string, rules: T[]): Promise<void> {
  await CacheService.set(key, rules, RULES_CACHE_TTL_SECONDS, ['rules']).catch(() => {});
}

/** Llamar desde el controller/repository de RestrictionRule en mutaciones (create/update/delete) */
export async function invalidateRestrictionRulesCache(): Promise<void> {
  await CacheService.invalidateTag('rules').catch(() => {});
}

// ---------------------------------------------------------------------------
// SECCIÓN 2: Método createOptimized refactorizado
// -
/**
 * Calcula el límite dinámico basado en baseAmount y salesPercentage
 * Obtiene las ventas del SORTEO dentro de la transacción
 * 
 * ️ IMPORTANTE: Este cálculo se hace sobre ventas BRUTAS del sorteo.
 * - Excluye tickets CANCELLED y EXCLUDED del cálculo
 * - NO excluye jugadas individuales con isExcluded=true (aún no procesadas en este momento)
 * - Los límites dinámicos NO se recalculan automáticamente cuando se excluyen jugadas después
 * 
 * Comportamiento:
 * - El límite se calcula una vez al momento de crear el ticket
 * - Se basa en ventas del sorteo en ese instante
 * - Si después se excluyen jugadas (SorteoListaExclusion), el límite NO se recalcula
 * 
 * Justificación:
 * - Las exclusiones se aplican DESPUÉS de crear el ticket (proceso asíncrono)
 * - Recalcular límites dinámicos después de exclusiones requeriría:
 *   1. Trigger después de cada exclusión
 *   2. Validación retroactiva de tickets ya creados
 *   3. Complejidad adicional sin beneficio claro
 * 
 *  CRÍTICO: Calcula sobre ventas del sorteo específico, no del día completo
 * 
 * @param tx Transacción de Prisma
 * @param rule Regla con baseAmount y/o salesPercentage
 * @param context Contexto del ticket (sorteoId, userId, ventanaId, etc.)
 * @returns Límite dinámico calculado (siempre >= 0)
 */
export async function calculateDynamicLimit(
  tx: Prisma.TransactionClient,
  rule: {
    baseAmount?: number | null;
    salesPercentage?: number | null;
    appliesToVendedor?: boolean | null;
    ruleUserId?: string | null;
    bancaId?: string | null;   //  NUEVO: Para alcance de banca
    ventanaId?: string | null; //  NUEVO: Para alcance de ventana
  },
  context: {
    userId: string;
    ventanaId: string;
    bancaId: string;
    sorteoId: string;
    at: Date;
    cache?: ScopeCache;
  }
): Promise<number> {
  let dynamicLimit = 0;

  //  VALIDACIÓN: baseAmount no puede ser negativo
  if (rule.baseAmount != null && rule.baseAmount < 0) {
    logger.warn({
      layer: 'repository',
      action: 'INVALID_BASE_AMOUNT',
      payload: {
        baseAmount: rule.baseAmount,
        sorteoId: context.sorteoId,
        message: 'baseAmount negativo detectado, usando 0 como fallback',
      },
    });
  }

  //  VALIDACIÓN: salesPercentage debe estar entre 0 y 100
  if (rule.salesPercentage != null && (rule.salesPercentage < 0 || rule.salesPercentage > 100)) {
    logger.warn({
      layer: 'repository',
      action: 'INVALID_SALES_PERCENTAGE',
      payload: {
        salesPercentage: rule.salesPercentage,
        sorteoId: context.sorteoId,
        message: 'salesPercentage fuera de rango válido (0-100), ignorando porcentaje',
      },
    });
  }

  const baseAmt = (rule.baseAmount != null && rule.baseAmount > 0) ? rule.baseAmount : 0;
  const hasSalesPercentage = rule.salesPercentage != null && rule.salesPercentage > 0 && rule.salesPercentage <= 100;

  if (hasSalesPercentage) {
    //  CRÍTICO: Calcular sobre ventas DEL SORTEO, no del día completo
    const where: Prisma.TicketWhereInput = {
      deletedAt: null,
      isActive: true,
      status: { notIn: [TicketStatus.CANCELLED, TicketStatus.EXCLUDED] },
      sorteoId: context.sorteoId,
    };

    let cacheKey = "";

    //  LÓGICA DE ALCANCE JERÁRQUICO
    //  Prioriza el alcance más específico definido en la regla
    if (rule.ruleUserId || rule.appliesToVendedor) {
      // 1. Vendedor Individual (Personal o Automático/Masivo)
      where.vendedorId = context.userId;
      cacheKey = `USER:${context.userId}`;
    } else if (rule.ventanaId) {
      // 2. Ventana Específica
      where.ventanaId = rule.ventanaId;
      cacheKey = `VENTANA:${rule.ventanaId}`;
    } else if (rule.bancaId) {
      // 3. Banca Completa (Filtra todas las ventanas de la banca)
      where.ventana = { bancaId: rule.bancaId };
      cacheKey = `BANCA:${rule.bancaId}`;
    } else {
      // Fallback: Ventana actual (Seguridad para reglas globales sin scope explícito en registro)
      where.ventanaId = context.ventanaId;
      cacheKey = `VENTANA:${context.ventanaId}`;
    }

    // 2. Intentar obtener de caché (ahora con el alcance correcto)
    if (context.cache) {
      const cached = context.cache.salesTotals.get(cacheKey);
      if (cached !== undefined) {
        const percentageAmount = (cached * rule.salesPercentage!) / 100;
        // base actúa como piso garantizado: aunque el % sea menor, siempre se puede vender hasta la base
        // Cuando el % supera la base, el % es el límite total
        dynamicLimit = baseAmt > 0
          ? Math.max(baseAmt, percentageAmount)
          : percentageAmount;
        return Math.max(0, dynamicLimit);
      }
    }

    // Calcular ventas del sorteo según el alcance determinado
    const result = await tx.ticket.aggregate({
      _sum: { totalAmount: true },
      where,
    });

    const sorteoSales = Number(result._sum.totalAmount) || 0;

    // Guardar en caché
    if (context.cache) {
      context.cache.salesTotals.set(cacheKey, sorteoSales);
    }
    const percentageAmount = (sorteoSales * rule.salesPercentage!) / 100;

    // base actúa como piso garantizado: aunque el % sea menor, siempre se puede vender hasta la base
    // Cuando el % supera la base, el % es el límite total
    // Ejemplo: base=2500, 3% de 93950=2818.50 → límite=max(2500,2818.50)=2818.50 → disponible=2818.50-1300=1518.50
    // Ejemplo: base=2500, 3% de 10000=300 → límite=max(2500,300)=2500 → disponible=2500
    dynamicLimit = baseAmt > 0
      ? Math.max(baseAmt, percentageAmount)
      : percentageAmount;

    const gano = percentageAmount >= baseAmt ? 'porcentaje' : 'base';

    logger.debug({
      layer: 'repository',
      action: 'DYNAMIC_LIMIT_CALCULATED',
      payload: {
        scope: `${cacheKey.split(':')[0]}:${cacheKey.split(':')[1]}`,
        sorteoId: context.sorteoId,
        base: `₡${baseAmt.toLocaleString()}`,
        ventas: `₡${sorteoSales.toLocaleString()}`,
        calculo: `${rule.salesPercentage}% × ${sorteoSales.toLocaleString()} = ₡${percentageAmount.toFixed(2)}`,
        limite: `₡${dynamicLimit.toFixed(2)} (ganó ${gano})`,
      },
    });
  } else if (baseAmt > 0) {
    // Solo baseAmount sin salesPercentage → el límite es el base directamente
    dynamicLimit = baseAmt;

    logger.debug({
      layer: 'repository',
      action: 'DYNAMIC_LIMIT_CALCULATED',
      payload: {
        sorteoId: context.sorteoId,
        base: `₡${baseAmt.toLocaleString()}`,
        limite: `₡${baseAmt.toLocaleString()} (solo base, sin porcentaje)`,
      },
    });
  }

  //  VALIDACIÓN: Asegurar que el límite dinámico nunca sea negativo
  return Math.max(0, dynamicLimit);
}

export type RestrictionRuleWithRelations = Prisma.RestrictionRuleGetPayload<{
  include: { loteria: true; multiplier: true };
}>;

function isSameLocalDay(a: Date, b: Date) {
  const crA = getCRLocalComponents(a);
  const crB = getCRLocalComponents(b);
  return (
    crA.year === crB.year &&
    crA.month === crB.month &&
    crA.day === crB.day
  );
}

/**
 * Calcula el score de prioridad de una regla de restricción
 * Orden de prioridad: USER > VENTANA > BANCA
 * Bonus por número específico y reglas de lotería/multiplicador
 */
function calculatePriorityScore(rule: RestrictionRuleWithRelations): number {
  let score = 0;
  if (rule.bancaId) score += 1;
  if (rule.ventanaId) score += 10;
  if (rule.userId) score += 100;
  if (rule.number) score += 1000;
  // Prioridad máxima a reglas específicas de lotería/multiplicador
  if (rule.loteriaId && rule.multiplierId) score += 10000;
  return score;
}

// ────────────────────────────────────────────────────────────────────────────────
// Resolución de multiplicador Base (robusta + fallback)
// ────────────────────────────────────────────────────────────────────────────────

export async function resolveBaseMultiplierX(
  tx: Prisma.TransactionClient,
  args: {
    bancaId: string;
    loteriaId: string;
    userId: string;
    ventanaId: string;
  }
): Promise<{ valueX: number; source: string }> {
  const { bancaId, loteriaId, userId, ventanaId } = args;
  const cacheKey = `multiplier:resolve:${bancaId}:${loteriaId}:${userId}:${ventanaId}`;

  return await CacheService.wrap<{ valueX: number; source: string }>(
    cacheKey,
    async () => {
      // 0) Override por usuario (directo en X) - HIGHEST PRIORITY
      const [userOverride, ventanaOverride, bls, lmBase, lmNumero, lot] = await Promise.all([
        tx.multiplierOverride.findFirst({
          where: {
            scope: OverrideScope.USER,
            userId,
            loteriaId,
            multiplierType: BetType.NUMERO,
            isActive: true,
          },
          select: { baseMultiplierX: true },
        }),
        // 0.5) Override por ventana - SECOND PRIORITY
        tx.multiplierOverride.findFirst({
          where: {
            scope: OverrideScope.VENTANA,
            ventanaId,
            loteriaId,
            multiplierType: BetType.NUMERO,
            isActive: true,
          },
          select: { baseMultiplierX: true },
        }),
        // 1) Config por banca/lotería
        tx.bancaLoteriaSetting.findUnique({
          where: { bancaId_loteriaId: { bancaId, loteriaId } },
          select: { baseMultiplierX: true },
        }),
        // 2) Multiplicador de la Lotería (tabla loteriaMultiplier) - Base
        tx.loteriaMultiplier.findFirst({
          where: { loteriaId, isActive: true, name: "Base" },
          select: { valueX: true },
        }),
        // 2) Multiplicador de la Lotería (tabla loteriaMultiplier) - NUMERO
        tx.loteriaMultiplier.findFirst({
          where: { loteriaId, isActive: true, kind: BetType.NUMERO },
          orderBy: { createdAt: "asc" },
          select: { valueX: true, name: true },
        }),
        // 3) Fallback: rulesJson en Lotería
        tx.loteria.findUnique({
          where: { id: loteriaId },
          select: { rulesJson: true },
        }),
      ]);

      // Evaluar resultados en orden de prioridad
      if (typeof userOverride?.baseMultiplierX === "number") {
        return {
          valueX: userOverride.baseMultiplierX,
          source: "multiplierOverride[scope=USER]",
        };
      }

      if (typeof ventanaOverride?.baseMultiplierX === "number") {
        return {
          valueX: ventanaOverride.baseMultiplierX,
          source: "multiplierOverride[scope=VENTANA]",
        };
      }

      if (typeof bls?.baseMultiplierX === "number") {
        return {
          valueX: bls.baseMultiplierX,
          source: "bancaLoteriaSetting.baseMultiplierX",
        };
      }

      if (typeof lmBase?.valueX === "number" && lmBase.valueX > 0) {
        return { valueX: lmBase.valueX, source: "loteriaMultiplier[name=Base]" };
      }

      if (typeof lmNumero?.valueX === "number" && lmNumero.valueX > 0) {
        return {
          valueX: lmNumero.valueX,
          source: `loteriaMultiplier[kind=NUMERO,name=${lmNumero.name ?? ""}]`,
        };
      }

      const rulesX = (lot?.rulesJson as any)?.baseMultiplierX;
      if (typeof rulesX === "number" && rulesX > 0) {
        return { valueX: rulesX, source: "loteria.rulesJson.baseMultiplierX" };
      }

      // 4) Fallback global por env
      const def = Number(process.env.MULTIPLIER_BASE_DEFAULT_X ?? 0);
      if (def > 0) {
        return { valueX: def, source: "env.MULTIPLIER_BASE_DEFAULT_X" };
      }

      throw new AppError(
        `Missing baseMultiplierX for bancaId=${bancaId} & loteriaId=${loteriaId}`,
        400
      );
    },
    86400, // 24 horas (86400 segundos)
    [
      `user-override:${userId}`,
      `ventana-override:${ventanaId}`,
      `banca-setting:${bancaId}`,
      `loteria:${loteriaId}`
    ]
  );
}

// Garantiza que exista un multiplicador "Base" (para linkear en jugadas NUMERO)
export const TicketRepository = {
  /**
   * Facade (Director de Orquesta) para la creación optimizada de tickets.
   * Modulo desacoplado aplicando Principios SOLID y patrones de diseño.
   */
  async createOptimized(
    data: Omit<CreateTicketInput, 'totalAmount'>,
    userId: string,
    options?: CreateTicketOptions
  ): Promise<{ ticket: any; warnings: TicketWarning[] }> {
    const dynamicTimeout = TicketTimeoutCalculator.calculate(data.jugadas.length);
    const lock = await TicketConcurrencyManager.acquire(data.sorteoId, data.ventanaId, options);

    try {
      const preFetchedMultipliers = await TicketPrefetchService.fetchMultipliersIfNeeded(data.jugadas, options);
      if (preFetchedMultipliers && preFetchedMultipliers.length > 0) {
        options = {
          ...options,
          preFetched: {
            ...options?.preFetched,
            multipliers: preFetchedMultipliers,
          },
        };
      }

      const txResult = await withTransactionRetry(
        async (tx) => {
          const meta = await TicketPrefetchService.resolveTransactionMetadata(tx, data, userId, options);
          const { ticketNumber, seqForLog } = await TicketNumberGenerator.generate(tx, meta.businessDateInfo.businessDateISO);

          const { warnings, preparedJugadas, totalAmountTx } = await TicketRiskValidator.validate(tx, { data, meta, userId, options });

          const commissions = TicketCommissionCalculator.calculate({ data, meta, preparedJugadas, options });
          const saveResult = await TicketPersistenceService.save(tx, {
            data,
            meta,
            ticketNumber,
            seqForLog,
            totalAmountTx,
            commissions,
            warnings,
            userId,
            options,
          });

          return { ...saveResult, businessDateInfo: meta.businessDateInfo, sorteoScheduledAt: meta.sorteo?.scheduledAt };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxRetries: 3,
          backoffMinMs: 150,
          backoffMaxMs: 2_000,
          maxWaitMs: 10_000,
          timeoutMs: dynamicTimeout,
        }
      );

      const ticket = TicketResponseBuilder.build(txResult, data, userId, options);
      TicketRedisAccumulator.incrementAsync(ticket, txResult.sorteoScheduledAt, options);

      return { ticket, warnings: txResult.warnings };
    } finally {
      if (lock) {
        await TicketConcurrencyManager.release(lock);
      }
    }
  },
  async getById(id: string, bancaId?: string) {
    return withConnectionRetry(
      () => prisma.ticket.findUnique({
        where: bancaId ? { id, bancaId } : { id },
        include: {
          jugadas: {
            where: { deletedAt: null },
          },
          loteria: true,
          sorteo: true,
          ventana: {
            include: {
              banca: true,
            },
          },
          vendedor: true,
          createdByUser: true,
        },
      }),
      { context: "TicketRepository.getById" }
    );
  },

  async list(
    page = 1,
    pageSize = 10,
    filters: {
      status?: TicketStatus;
      isActive?: boolean;
      sorteoId?: string;
      loteriaId?: string;
      multiplierId?: string;
      ventanaId?: string;
      search?: string;
      userId?: string;
      dateFrom?: Date;
      dateTo?: Date;
      businessDateFrom?: Date;
      businessDateTo?: Date;
      winnersOnly?: boolean;
      number?: string; //  NUEVO: Búsqueda por número de jugada (1-2 dígitos)
      winningNumber?: string; // NUEVO: Búsqueda por número ganador específico
      scheduledTime?: string; // NUEVO: Filtro por hora programada (HH:mm)
      bancaId?: string; //  NUEVO: Filtro por banca
      lastId?: string; // Keyset pagination: ID del último elemento
      lastCreatedAt?: Date; // Keyset pagination: createdAt del último elemento
    } = {}
  ) {
    const where: Prisma.TicketWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
      ...(filters.sorteoId && filters.sorteoId !== "all" ? { sorteoId: filters.sorteoId } : {}),
      ...(filters.loteriaId && filters.loteriaId !== "all" ? { loteriaId: filters.loteriaId } : {}),
      ...(filters.multiplierId && filters.multiplierId !== "all"
        ? {
          jugadas: {
            some: {
              multiplierId: filters.multiplierId,
            },
          },
        }
        : {}),
      ...(filters.userId && filters.userId !== "all" ? { vendedorId: filters.userId } : {}),
      ...(filters.ventanaId && filters.ventanaId !== "all" ? { ventanaId: filters.ventanaId } : {}),
      ...(filters.bancaId && filters.bancaId !== "all" ? { bancaId: filters.bancaId } : {}),
      ...(filters.winnersOnly === true ? { isWinner: true } : {}),
      ...(filters.businessDateFrom || filters.businessDateTo
        ? {
          businessDate: {
            ...(filters.businessDateFrom ? { gte: filters.businessDateFrom } : {}),
            ...(filters.businessDateTo ? { lte: filters.businessDateTo } : {}),
          },
        }
        : {}),
    };

    // Keyset pagination: optimizar skip masivos
    if (filters.lastId && filters.lastCreatedAt) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        {
          OR: [
            { createdAt: { lt: filters.lastCreatedAt } },
            { AND: [{ createdAt: filters.lastCreatedAt }, { id: { lt: filters.lastId } }] }
          ]
        }
      ];
    }

    const skip = filters.lastId ? undefined : (page - 1) * pageSize;

    // NUEVO: Filtro por hora programada del sorteo (scheduledTime: HH:mm)
    if (filters.scheduledTime) {
      // 1. Buscar todos los sorteos que coincidan con la hora en el rango de fechas
      // (Limitamos por fecha para evitar cargar miles de sorteos)
      const sorteosInRange = await withConnectionRetry(
        () => prisma.sorteo.findMany({
          where: {
            scheduledAt: {
              gte: filters.dateFrom,
              lt: filters.dateTo,
            },
            loteriaId: filters.loteriaId,
          },
          select: { id: true, scheduledAt: true },
        }),
        { context: 'TicketRepository.list.sorteosInRange' }
      );

      // 2. Filtrar por hora exacta en Costa Rica
      const matchingSorteoIds = sorteosInRange
        .filter((s) => {
          const { hour, minute } = getCRLocalComponents(s.scheduledAt);
          const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
          return timeStr === filters.scheduledTime;
        })
        .map((s) => s.id);

      // 3. Aplicar filtro sorteoId
      if (matchingSorteoIds.length === 0) {
        // Si no hay sorteos que coincidan, retornar resultado vacío inmediatamente
        return {
          data: [],
          meta: {
            total: 0,
            page,
            pageSize,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
        };
      }

      if (where.sorteoId) {
        // Si ya hay un sorteoId filtrado, intersecar
        if (typeof where.sorteoId === "string") {
          if (!matchingSorteoIds.includes(where.sorteoId as string)) {
            return { data: [], meta: { total: 0, page, pageSize, totalPages: 0, hasNextPage: false, hasPrevPage: false } };
          }
        } else if ((where.sorteoId as any).in) {
          where.sorteoId = {
            in: matchingSorteoIds.filter((id) =>
              (where.sorteoId as any).in.includes(id)
            ),
          };
        }
      } else {
        where.sorteoId = { in: matchingSorteoIds };
      }
    }

    //  NUEVO: Búsqueda exacta por número de jugada
    // Busca en jugada.number (para NUMERO) y jugada.reventadoNumber (para REVENTADO)
    // La búsqueda es exacta: si se busca "12", encuentra "12" pero no "123" o "012"
    if (filters.number) {
      const numberStr = filters.number.trim();
      // Normalizar el número: asegurar que tenga formato consistente (sin ceros a la izquierda para comparación)
      // Pero mantener la búsqueda exacta en la base de datos
      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          jugadas: {
            some: {
              OR: [
                // Búsqueda en number (para tipo NUMERO)
                { number: numberStr },
                // Búsqueda en reventadoNumber (para tipo REVENTADO)
                { reventadoNumber: numberStr },
              ],
              deletedAt: null, // Solo jugadas activas
            },
          },
        },
      ];
    }

    //  NUEVO: Búsqueda por número ganador específico
    // Solo retorna tiquetes donde el número especificado resultó ganador
    if (filters.winningNumber) {
      const winNumStr = filters.winningNumber.trim();
      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          jugadas: {
            some: {
              OR: [
                { number: winNumStr, isWinner: true },
                { reventadoNumber: winNumStr, isWinner: true },
              ],
              deletedAt: null,
            },
          },
        },
      ];
    }

    // búsqueda unificada
    const s = typeof filters.search === "string" ? filters.search.trim() : "";
    if (s.length > 0) {
      const isDigits = /^\d+$/.test(s);
      const n = isDigits ? Number(s) : null;

      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          OR: [
            ...(n !== null
              ? [{ ticketNumber: n } as Prisma.TicketWhereInput]
              : []),
            { vendedor: { name: { contains: s, mode: "insensitive" } } },
            { ventana: { name: { contains: s, mode: "insensitive" } } },
            { loteria: { name: { contains: s, mode: "insensitive" } } },
            { sorteo: { name: { contains: s, mode: "insensitive" } } },
          ],
        },
      ];
    }

    // OPTIMIZACIÓN: Usar select específico en lugar de include para evitar cargar campos pesados (como rulesJson de Loteria y contraseñas de User) a memoria, manteniendo compatibilidad de la APK.
    const [data, total] = await withConnectionRetry(
      () => Promise.all([
        prisma.ticket.findMany({
          where,
          skip,
          take: pageSize,
          select: {
            id: true,
            ticketNumber: true,
            loteriaId: true,
            ventanaId: true,
            vendedorId: true,
            totalAmount: true,
            status: true,
            deletedAt: true,
            deletedBy: true,
            deletedReason: true,
            createdAt: true,
            updatedAt: true,
            isActive: true,
            isWinner: true,
            sorteoId: true,
            totalPayout: true,
            totalPaid: true,
            remainingAmount: true,
            lastPaymentAt: true,
            paidById: true,
            paymentMethod: true,
            paymentNotes: true,
            paymentHistory: true,
            clienteNombre: true,
            businessDate: true,
            totalCommission: true,
            createdBy: true,
            createdByRole: true,
            isSorteoClosed: true,
            idempotencyKey: true,
            bancaId: true,
            printCount: true,
            loteria: {
              select: { id: true, name: true }
            },
            sorteo: {
              select: { id: true, name: true, scheduledAt: true, status: true }
            },
            ventana: {
              select: { id: true, name: true }
            },
            vendedor: {
              select: { id: true, name: true, code: true }
            },
            jugadas: {
              where: { deletedAt: null },
              select: {
                id: true,
                number: true,
                amount: true,
                type: true,
                isWinner: true,
                payout: true,
                reventadoNumber: true,
                finalMultiplierX: true
              },
              orderBy: { id: "asc" },
            }
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        prisma.ticket.count({ where }),
      ]),
      { context: 'TicketRepository.list' }
    );

    const totalPages = Math.ceil(total / pageSize);
    const meta = {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    logger.info({
      layer: "repository",
      action: "TICKET_LIST",
      payload: {
        filters: { ...filters, search: s || undefined },
        page,
        pageSize,
        total,
      },
    });

    return { data, meta };
  },

  async cancel(id: string, userId: string, bancaId?: string) {
    // Cancelación bajo retry + timeouts (misma estrategia que create)
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado con filtro de banca
        const existing = await tx.ticket.findUnique({
          where: bancaId ? { id, bancaId } : { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status === TicketStatus.EVALUATED) {
          throw new AppError(
            "Cannot cancel an evaluated ticket",
            400,
            "INVALID_STATE"
          );
        }

        // 2) Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
        if (
          existing.sorteo.status === "CLOSED" ||
          existing.sorteo.status === "EVALUATED"
        ) {
          throw new AppError(
            "Cannot cancel ticket from closed or evaluated sorteo",
            400,
            "SORTEO_LOCKED"
          );
        }

        // 3) Actualizar ticket (soft delete + inactivar)
        // IMPORTANTE: También inactivar todas las jugadas del ticket
        const now = new Date();
        const cancelled = await tx.ticket.update({
          where: { id },
          data: {
            isActive: false,
            status: TicketStatus.CANCELLED,
            deletedAt: now, // Registrar fecha de cancelación/eliminación
            updatedAt: now,
          },
          include: { jugadas: true },
        });

        // 4) Inactivar todas las jugadas del ticket cancelado
        await tx.jugada.updateMany({
          where: { ticketId: id },
          data: {
            isActive: false,
          },
        });

        // 5) Decremento incremental en DailyNumberSales (atómico)
        await DailyNumberSalesService.decrementFromTicket(id, tx);

        return cancelled;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // Logging global
    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: {
        ticketId: id,
        userId,
        sorteoId: (ticket as any).sorteoId,
        totalAmount: ticket.totalAmount,
      },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST-TRANSACCIÓN: Decrementar acumulados en Redis tras anulación exitosa
    // ─────────────────────────────────────────────────────────────────────────
    if (isRedisAvailable()) {
      const redis = getRedisClient();
      if (redis) {
        try {
          const pipeline = redis.pipeline();
          const sorteoId = ticket.sorteoId;
          const vendedorId = ticket.vendedorId;
          const ventanaId = ticket.ventanaId;

          // Obtener la bancaId real para el decremento
          let targetBancaId = null;
          if (ventanaId) {
            const vent = await prisma.ventana.findUnique({
              where: { id: ventanaId },
              select: { bancaId: true },
            });
            targetBancaId = vent?.bancaId;
          }

          if (targetBancaId) {
            const scopes = [
              { id: targetBancaId, type: ReportDimension.BANCA },
              { id: ventanaId, type: ReportDimension.VENTANA },
              { id: vendedorId, type: ReportDimension.VENDEDOR }
            ];

            const keysToExpire = new Set<string>();

            for (const j of ticket.jugadas) {
              const amount = j.amount;
              const num = j.number;

              for (const sc of scopes) {
                if (!sc.id) continue;

                // 1. Restar de la clave general
                const genKey = `sorteo:${sorteoId}:scope:${sc.id}:acumulados`;
                pipeline.hincrbyfloat(genKey, num, -amount);
                keysToExpire.add(genKey);

                // 2. Restar de la clave por multiplicador si corresponde
                const multId = j.type === BetType.REVENTADO ? 'REVENTADO' : j.multiplierId;
                if (multId) {
                  const multKey = `sorteo:${sorteoId}:scope:${sc.id}:multiplier:${multId}:acumulados`;
                  pipeline.hincrbyfloat(multKey, num, -amount);
                  keysToExpire.add(multKey);
                }
              }
            }

            // Aplicar expiración una sola vez por clave única
            for (const key of keysToExpire) {
              pipeline.expire(key, 43200);
            }

            await pipeline.exec();

            logger.debug({
              layer: 'redis-update',
              action: 'ACCUMULATED_REDIS_DECREMENTED',
              payload: {
                ticketId: ticket.id,
                sorteoId,
                bancaId: targetBancaId,
                jugadasCount: ticket.jugadas.length,
              },
            });
          }
        } catch (redisErr: any) {
          markRedisError('cancel-decrement');
          logger.error({
            layer: 'redis-update',
            action: 'REDIS_DECREMENT_ERROR',
            payload: { ticketId: ticket.id, error: redisErr.message },
          });
        }
      }
    }

    return ticket;
  },

  async incrementPrintCount(id: string) {
    return withConnectionRetry(
      () => prisma.ticket.update({
        where: { id },
        data: {
          printCount: { increment: 1 }
        },
        include: {
          sorteo: true,
          loteria: true,
          vendedor: true,
          ventana: true
        }
      }),
      { context: 'TicketRepository.incrementPrintCount' }
    );
  },

  /**
   * Restaura un ticket cancelado si el sorteo aún no ha pasado
   */
  async restore(id: string, userId: string, bancaId?: string) {
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado con filtro de banca
        const existing = await tx.ticket.findUnique({
          where: bancaId ? { id, bancaId } : { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status !== TicketStatus.CANCELLED) {
          throw new AppError(
            "Only cancelled tickets can be restored",
            400,
            "INVALID_STATE"
          );
        }

        // 2) Validar que el sorteo no haya pasado
        const now = new Date();
        if (existing.sorteo.scheduledAt <= now) {
          throw new AppError(
            "Cannot restore ticket: draw has passed",
            409,
            "DRAW_PASSED"
          );
        }

        // 3) Validar estado del sorteo
        if (
          existing.sorteo.status === "CLOSED" ||
          existing.sorteo.status === "EVALUATED"
        ) {
          throw new AppError(
            "Cannot restore ticket: draw is closed or evaluated",
            409,
            "SORTEO_LOCKED"
          );
        }

        // 4) Restaurar ticket
        const restored = await tx.ticket.update({
          where: { id },
          data: {
            isActive: true,
            status: TicketStatus.ACTIVE,
            updatedAt: new Date(),
          },
          include: { jugadas: true },
        });

        // 5) Restaurar jugadas
        await tx.jugada.updateMany({
          where: { ticketId: id },
          data: {
            isActive: true,
          },
        });

        // 6) Incremento incremental en DailyNumberSales (atómico)
        await DailyNumberSalesService.incrementFromTicket(id, tx);

        return restored;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    logger.info({
      layer: "repository",
      action: "TICKET_RESTORE_DB",
      payload: {
        ticketId: id,
        userId,
      },
    });

    return ticket;
  },

  /**
   * Obtiene los saldos disponibles para todos los números (00-99 o 000-999) de un sorteo específico.
   * Evalúa todas las reglas de restricción (MaxTotal) y límites dinámicos aplicables.
   */
  async getSorteoBalances(params: {
    sorteoId: string;
    vendedorId: string;
    bancaId?: string;
    actorRole?: Role;
  }): Promise<Record<string, { remaining: number; limit: number; accumulated: number }>> {
    const { sorteoId, vendedorId, bancaId, actorRole } = params;

    return await withConnectionRetry(async () => {
      // 1. Obtener contexto del vendedor (ventanaId, bancaId real)
      // OPTIMIZACIÓN: Cache 300s — el contexto de ventana/banca de un vendedor cambia muy raramente
      const user = await CacheService.wrap(
        `user:ctx:${vendedorId}`,
        () => prisma.user.findUnique({
          where: { id: vendedorId },
          select: { id: true, ventanaId: true, role: true, ventana: { select: { bancaId: true } } },
        }),
        300,
        [`user:${vendedorId}`]
      );

      if (!user || !user.ventanaId) return {};

      const effectiveBancaId = user.ventana?.bancaId || bancaId;
      if (!effectiveBancaId) return {};

      // 2. Obtener sorteo y su lotería
      // OPTIMIZACIÓN: Cache 1h — los metadatos de un sorteo (digits, loteriaId) no cambian
      const sorteo = await CacheService.wrap(
        `sorteo:meta:${sorteoId}`,
        () => prisma.sorteo.findUnique({
          where: { id: sorteoId },
          select: { id: true, loteriaId: true, scheduledAt: true, digits: true },
        }),
        3600
      );

      if (!sorteo) return {};

      // 3. Obtener reglas de restricción aplicables
      // OPTIMIZACIÓN: Reutiliza el L1 cache en memoria (RULES_CACHE_TTL_MS = 60s) ya existente
      const now = new Date();
      const rulesCacheKey = buildRulesCacheKey({
        userId: vendedorId,
        ventanaId: user.ventanaId,
        bancaId: effectiveBancaId,
      });
      const cachedRules = await getCachedRestrictionRules<any>(rulesCacheKey);
      const candidateRules = cachedRules ?? await (async () => {
        const fresh = await prisma.restrictionRule.findMany({
          where: {
            isActive: true,
            OR: [
              { userId: vendedorId },
              { ventanaId: user.ventanaId, userId: null },
              { bancaId: effectiveBancaId, ventanaId: null, userId: null },
              { AND: [{ userId: null }, { ventanaId: null }, { bancaId: null }] },
            ],
          },
          include: { loteria: true, multiplier: true },
        });
        await setCachedRestrictionRules(rulesCacheKey, fresh);
        return fresh;
      })();

      const isImpersonatedByVentanaOrAdmin =
        actorRole === Role.VENTANA ||
        actorRole === Role.ADMIN;

      const crNowHour = getCRLocalComponents(now).hour;
      const applicableRules = candidateRules.filter((r) => {
        // Si es impersonación por listero/admin, ignorar reglas específicas del vendedor
        if (isImpersonatedByVentanaOrAdmin && r.userId !== null) return false;
        if (r.multiplierId) return false;
        if (r.loteriaId && r.loteriaId !== sorteo.loteriaId) return false;
        if (r.appliesToDate && !isSameLocalDay(new Date(r.appliesToDate), now)) return false;
        if (typeof r.appliesToHour === "number" && r.appliesToHour !== crNowHour) return false;
        return r.maxTotal != null || r.baseAmount != null || r.salesPercentage != null;
      });

      // 4. Generar lista de números según los dígitos del sorteo
      const maxDigits = sorteo.digits || 2;
      const totalNumbers = Math.pow(10, maxDigits);
      const numbers = Array.from({ length: totalNumbers }, (_, i) => String(i).padStart(maxDigits, '0'));

      // 5. Calcular acumulados actuales de forma paralela
      const [bancaAccumulated, ventanaAccumulated, userAccumulated] = await Promise.all([
        calculateAccumulatedByNumbersAndScope(prisma as any, {
          numbers,
          scopeType: ReportDimension.BANCA,
          scopeId: effectiveBancaId,
          sorteoId,
        }),
        calculateAccumulatedByNumbersAndScope(prisma as any, {
          numbers,
          scopeType: ReportDimension.VENTANA,
          scopeId: user.ventanaId,
          sorteoId,
        }),
        calculateAccumulatedByNumbersAndScope(prisma as any, {
          numbers,
          scopeType: ReportDimension.VENDEDOR,
          scopeId: vendedorId,
          sorteoId,
        }),
      ]);

      // 6. Pre-calcular límites dinámicos
      const dynamicLimits = new Map<string, number>();
      for (const rule of applicableRules) {
        if (rule.salesPercentage != null || rule.baseAmount != null) {
          const limit = await calculateDynamicLimit(prisma as any, {
            baseAmount: rule.baseAmount,
            salesPercentage: rule.salesPercentage,
            appliesToVendedor: rule.appliesToVendedor,
            ruleUserId: rule.userId,
            bancaId: rule.bancaId,
            ventanaId: rule.ventanaId,
          }, {
            userId: vendedorId,
            ventanaId: user.ventanaId,
            bancaId: effectiveBancaId,
            sorteoId,
            at: now,
          });
          dynamicLimits.set(rule.id, limit);
        }
      }

      // 7. Evaluar reglas por número
      const balances: Record<string, { remaining: number; limit: number; accumulated: number }> = {};
      for (const num of numbers) {
        let minRemaining = Infinity;
        let selectedLimit = Infinity;
        let selectedAccumulated = 0;
        let hasRestrictiveRule = false;

        for (const rule of applicableRules) {
          if (rule.number) {
            const ruleNumbers = resolveNumbersToValidate(rule, now);
            if (ruleNumbers.length > 0 && !ruleNumbers.includes(num)) continue;
          }

          const scopeType = (rule.appliesToVendedor || rule.userId) ? ReportDimension.VENDEDOR : rule.ventanaId ? ReportDimension.VENTANA : ReportDimension.BANCA;
          const accumulated = scopeType === ReportDimension.VENDEDOR ? (userAccumulated.get(num) ?? 0) : scopeType === ReportDimension.VENTANA ? (ventanaAccumulated.get(num) ?? 0) : (bancaAccumulated.get(num) ?? 0);

          const staticLimit = rule.maxTotal ?? Infinity;
          const dynamicLimit = dynamicLimits.get(rule.id) ?? Infinity;
          const limit = (rule.salesPercentage != null && dynamicLimit !== Infinity)
            ? dynamicLimit
            : Math.min(staticLimit, dynamicLimit);
          const remaining = Math.max(0, limit - accumulated);

          if (remaining < minRemaining) {
            minRemaining = remaining;
            selectedLimit = limit;
            selectedAccumulated = accumulated;
            hasRestrictiveRule = true;
          }
        }

        if (hasRestrictiveRule) {
          balances[num] = { remaining: minRemaining, limit: selectedLimit, accumulated: selectedAccumulated };
        }
      }
      return balances;
    }, { context: 'TicketRepository.getSorteoBalances' });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FUNCIONES AUXILIARES DE SOPORTE PARA MODULARIZACIÓN Y LEGIBILIDAD
// ─────────────────────────────────────────────────────────────────────────────

export function validateLoteriaRulesJson(rulesJson: any, jugadas: any[]) {
  const RJ = (rulesJson ?? {}) as any;
  const numberRange =
    RJ.numberRange &&
      typeof RJ.numberRange.min === 'number' &&
      typeof RJ.numberRange.max === 'number'
      ? { min: RJ.numberRange.min, max: RJ.numberRange.max }
      : { min: 0, max: 99 };

  const minBetAmount =
    typeof RJ.minBetAmount === 'number' ? RJ.minBetAmount : undefined;
  const maxBetAmount =
    typeof RJ.maxBetAmount === 'number' ? RJ.maxBetAmount : undefined;
  const maxNumbersPerTicket =
    typeof RJ.maxNumbersPerTicket === 'number'
      ? RJ.maxNumbersPerTicket
      : undefined;

  for (const j of jugadas) {
    const num = Number(j.number);
    if (
      Number.isNaN(num) ||
      num < numberRange.min ||
      num > numberRange.max
    ) {
      throw new AppError(
        `Número fuera de rango permitido (${numberRange.min}..${numberRange.max}): ${j.number}`,
        400,
        'NUMBER_OUT_OF_RANGE'
      );
    }
    if (
      typeof minBetAmount === 'number' &&
      j.amount < minBetAmount
    ) {
      throw new AppError(
        `Monto mínimo por jugada: ${minBetAmount}`,
        400,
        'BET_MIN_VIOLATION'
      );
    }
    if (
      typeof maxBetAmount === 'number' &&
      j.amount > maxBetAmount
    ) {
      throw new AppError(
        `Monto máximo por jugada: ${maxBetAmount}`,
        400,
        'BET_MAX_VIOLATION'
      );
    }
  }

  if (typeof maxNumbersPerTicket === 'number') {
    const uniqueNumeros = new Set(
      jugadas.filter((j) => j.type === BetType.NUMERO).map((j) => j.number)
    );
    if (uniqueNumeros.size > maxNumbersPerTicket) {
      throw new AppError(
        `Máximo de números por ticket: ${maxNumbersPerTicket}`,
        400,
        'MAX_NUMBERS_PER_TICKET'
      );
    }
  }
}

export function validateAndMapMultipliers(
  jugadas: any[],
  multiplierCache: Map<string, any>,
  lotteryMultiplierRules: any[],
  loteriaId: string,
  loteriaName: string | null,
  actorRole: Role,
  warnings: TicketWarning[],
  warningRuleIds: Set<string>
) {
  return jugadas.map((j) => {
    if (j.type === BetType.REVENTADO) {
      return {
        type: BetType.REVENTADO,
        number: j.number,
        reventadoNumber: j.reventadoNumber,
        amount: j.amount,
        finalMultiplierX: 0,
        multiplierId: null,
      };
    }

    if (!j.multiplierId) {
      throw new AppError(
        'Debe seleccionar un multiplicador para jugadas tipo NUMERO',
        400,
        'MISSING_MULTIPLIER_ID'
      );
    }

    const multiplier = multiplierCache.get(j.multiplierId);
    if (!multiplier)
      throw new AppError(
        'Multiplicador inválido para jugada NUMERO',
        400,
        'INVALID_MULTIPLIER'
      );
    if (multiplier.kind !== BetType.NUMERO)
      throw new AppError(
        'Multiplicador incompatible con jugada NUMERO',
        400,
        'INVALID_MULTIPLIER_KIND'
      );
    if (multiplier.loteriaId !== loteriaId) {
      logger.error({
        layer: 'repository',
        action: 'MULTIPLIER_LOTERIA_MISMATCH',
        payload: {
          multiplierId: j.multiplierId,
          multiplierLoteriaId: multiplier.loteriaId,
          requestLoteriaId: loteriaId,
          multiplierName: multiplier.name,
        },
      });
      throw new AppError(
        'Multiplicador no pertenece a la lotería',
        400,
        'INVALID_MULTIPLIER_LOTERIA'
      );
    }
    if (!multiplier.isActive)
      throw new AppError('Multiplicador inactivo', 400, 'INACTIVE_MULTIPLIER');

    const multiplierX = multiplier.valueX;
    if (typeof multiplierX !== 'number' || multiplierX <= 0)
      throw new AppError(
        'Multiplicador con valor inválido',
        400,
        'INVALID_MULTIPLIER_VALUE'
      );

    const matchingRule = lotteryMultiplierRules.find(
      (rule) =>
        rule.loteriaId === loteriaId &&
        rule.multiplierId === j.multiplierId
    );

    if (matchingRule) {
      const ruleScope: ReportDimension = matchingRule.userId
        ? ReportDimension.VENDEDOR
        : matchingRule.ventanaId
          ? ReportDimension.VENTANA
          : ReportDimension.BANCA;

      const loteriaNameForWarning =
        matchingRule.loteria?.name ?? loteriaName;
      const multiplierNameForWarning =
        multiplier.name ?? matchingRule.multiplier?.name ?? null;
      const defaultMessage = multiplier.name
        ? `El multiplicador '${multiplier.name}' está restringido para esta lotería.`
        : 'El multiplicador seleccionado está restringido para esta lotería.';
      const message =
        (matchingRule.message && matchingRule.message.trim()) ||
        defaultMessage;

      if (actorRole === Role.ADMIN) {
        if (!warningRuleIds.has(matchingRule.id)) {
          warnings.push({
            code: 'LOTTERY_MULTIPLIER_RESTRICTED',
            restrictedButAllowed: true,
            ruleId: matchingRule.id,
            scope: ruleScope,
            loteriaId,
            loteriaName: loteriaNameForWarning,
            multiplierId: j.multiplierId,
            multiplierName: multiplierNameForWarning,
            message,
          });
          warningRuleIds.add(matchingRule.id);
        }
      } else {
        throw new AppError(message, 400, {
          code: 'LOTTERY_MULTIPLIER_RESTRICTED',
          ruleId: matchingRule.id,
          scope: ruleScope,
          loteriaId,
          loteriaName: loteriaNameForWarning,
          multiplierId: j.multiplierId,
          multiplierName: multiplierNameForWarning,
        });
      }
    }

    return {
      type: BetType.NUMERO,
      number: j.number,
      reventadoNumber: null,
      amount: j.amount,
      finalMultiplierX: multiplierX,
      multiplierId: j.multiplierId,
      isActive: (j as any).isActive !== false,
    };
  });
}

export default TicketRepository;

