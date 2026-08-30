import { BetType, Prisma, Role } from "../../generated/prisma/client";
import { ReportDimension } from "../../types/enums/report.enum";
import logger from "../../core/logger";
import { getCRLocalComponents } from "../../utils/businessDate";
import {
  buildRulesCacheKey,
  getCachedRestrictionRules,
  setCachedRestrictionRules,
  calculateDynamicLimit,
  validateLoteriaRulesJson,
  validateAndMapMultipliers,
  RestrictionRuleWithRelations,
} from "../../repositories/ticket.repository";
import {
  ScopeCache,
  calculateAccumulatedForMultipleScopes,
  validateRulesInParallel,
} from "../../repositories/helpers/ticket-restriction.helper";
import {
  CreateTicketInput,
  CreateTicketOptions,
  TicketWarning,
  TransactionMeta,
} from "./ticket.types";

export type TicketRiskContext = {
  data: CreateTicketInput;
  meta: TransactionMeta;
  userId: string;
  options?: CreateTicketOptions;
};

export class TicketRiskValidator {
  /**
   * Ejecuta el motor de validación de riesgo de ventas y reglas de restricción en paralelo.
   * REGLA DE ORO: Recibe explícitamente tx: Prisma.TransactionClient.
   */
  static async validate(
    tx: Prisma.TransactionClient,
    context: TicketRiskContext
  ): Promise<{ warnings: TicketWarning[]; preparedJugadas: any[]; totalAmountTx: number }> {
    const { data, meta, userId, options } = context;
    const { loteriaId, sorteoId, ventanaId, jugadas } = data;
    const { bancaId, loteriaName, loteria } = meta;

    const warnings: TicketWarning[] = [];
    const warningRuleIds = new Set<string>();
    const actorRole = options?.actorRole ?? Role.VENDEDOR;

    // 1) Cargar reglas de restricción candidatas usando caché en Redis
    const rulesCacheKey = buildRulesCacheKey({ userId, ventanaId, bancaId });
    let candidateRules = await getCachedRestrictionRules<RestrictionRuleWithRelations>(rulesCacheKey);

    if (!candidateRules) {
      candidateRules = await tx.restrictionRule.findMany({
        where: {
          isActive: true,
          OR: [
            { userId },
            { ventanaId, userId: null },
            { bancaId, ventanaId: null, userId: null },
            {
              AND: [
                { userId: null },
                { ventanaId: null },
                { bancaId: null },
              ],
            },
          ],
        },
        include: {
          loteria: true,
          multiplier: true,
        },
      });
      await setCachedRestrictionRules(rulesCacheKey, candidateRules);
    }

    // 2) Filtrar reglas aplicables por huso horario y alcance
    const now = new Date();
    const crNowHour = getCRLocalComponents(now).hour;
    const isImpersonatedByVentanaOrAdmin =
      options?.createdByRole === Role.VENTANA ||
      options?.createdByRole === Role.ADMIN;

    const applicable: RestrictionRuleWithRelations[] = candidateRules
      .filter((r) => {
        if (isImpersonatedByVentanaOrAdmin && r.userId !== null) {
          return false;
        }
        if (
          r.appliesToDate &&
          !r.appliesToDate.toISOString().startsWith(now.toISOString().substring(0, 10))
        )
          return false;
        if (
          typeof r.appliesToHour === 'number' &&
          r.appliesToHour !== crNowHour
        )
          return false;
        return true;
      })
      .map((r) => {
        let score = 0;
        if (r.bancaId) score += 1;
        if (r.ventanaId) score += 10;
        if (r.userId) score += 100;
        if (r.number) score += 1000;
        if (r.loteriaId && r.multiplierId) score += 10000;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);

    const lotteryMultiplierRules = applicable.filter(
      (rule) => rule.loteriaId && rule.multiplierId
    );

    // 4) Validaciones de rulesJson en la Lotería
    validateLoteriaRulesJson(loteria.rulesJson, jugadas);

    // 5) Normalizar jugadas y mapear multiplicadores
    const multiplierCache = new Map<string, any>();
    let multipliers = options?.preFetched?.multipliers || [];

    if (multipliers.length === 0) {
      const numeroMultiplierIds = Array.from(
        new Set(
          jugadas
            .filter((j) => j.type === BetType.NUMERO && j.multiplierId)
            .map((j) => j.multiplierId!)
        )
      );

      if (numeroMultiplierIds.length > 0) {
        multipliers = await tx.loteriaMultiplier.findMany({
          where: { id: { in: numeroMultiplierIds } },
          select: {
            id: true,
            name: true,
            valueX: true,
            isActive: true,
            kind: true,
            loteriaId: true,
          },
        });
      }
    }

    for (const m of multipliers) {
      multiplierCache.set(m.id, {
        id: m.id,
        name: m.name,
        valueX: m.valueX,
        isActive: m.isActive,
        kind: m.kind as BetType,
        loteriaId: m.loteriaId,
      });
    }

    const preparedJugadas = validateAndMapMultipliers(
      jugadas,
      multiplierCache,
      lotteryMultiplierRules,
      loteriaId,
      loteriaName,
      actorRole,
      warnings,
      warningRuleIds
    );

    const totalAmountTx = preparedJugadas.reduce(
      (acc: number, j: any) => acc + j.amount,
      0
    );

    // 6) Construcción de caché de ventas acumuladas por alcance
    const cache: ScopeCache = {
      salesTotals: new Map(),
      numberTotals: new Map(),
    };

    const ticketNumbers = preparedJugadas.map((j: any) => ({
      number: j.type === BetType.NUMERO ? j.number : j.reventadoNumber!,
      amountForNumber: Number(j.amount),
      type: j.type,
      multiplierId: j.multiplierId || null,
    }));

    const uniqueNumberStrings = ticketNumbers.map((n: any) => n.number);
    const scopesToPreload = new Set<string>();

    for (const rule of applicable) {
      const hasDynamicLimitConfig =
        (rule.baseAmount != null && rule.baseAmount > 0) ||
        (rule.salesPercentage != null && rule.salesPercentage > 0);
      if (rule.maxTotal != null || hasDynamicLimitConfig) {
        const scopeType = rule.userId
          ? ReportDimension.VENDEDOR
          : rule.ventanaId
            ? ReportDimension.VENTANA
            : rule.bancaId
              ? ReportDimension.BANCA
              : null;
        const scopeId = rule.userId || rule.ventanaId || rule.bancaId;
        const multiplierId = rule.multiplierId
          ? rule.multiplier?.kind === BetType.REVENTADO
            ? 'REVENTADO'
            : rule.multiplierId
          : 'NONE';
        if (scopeType && scopeId) {
          scopesToPreload.add(`${scopeType}:${scopeId}:${multiplierId}`);
        }
      }
    }

    const scopesArray: any[] = [];
    for (const scopeKey of scopesToPreload) {
      const [scopeType, scopeId, multiplierKey] = scopeKey.split(':');
      const multiplierFilter =
        multiplierKey === 'NONE'
          ? null
          : multiplierKey === BetType.REVENTADO
            ? { id: 'REVENTADO', kind: BetType.REVENTADO as any }
            : { id: multiplierKey, kind: BetType.NUMERO as any };

      scopesArray.push({
        scopeType: scopeType as any,
        scopeId,
        multiplierFilter,
      });
    }

    if (scopesArray.length > 0) {
      await calculateAccumulatedForMultipleScopes(tx, {
        numbers: uniqueNumberStrings,
        sorteoId,
        scopes: scopesArray,
        cache,
      });
    }

    // 7) Cálculo dinámico de límites de riesgo
    const dynamicLimits = new Map<string, number>();
    const rulesNeedingDynamicLimits = applicable.filter(
      (rule: any) =>
        (rule.baseAmount != null && rule.baseAmount > 0) ||
        (rule.salesPercentage != null && rule.salesPercentage > 0)
    );

    if (rulesNeedingDynamicLimits.length > 0) {
      const dynamicLimitPromises = rulesNeedingDynamicLimits.map(
        async (rule: any) => {
          try {
            const limit = await calculateDynamicLimit(
              tx,
              {
                baseAmount: rule.baseAmount,
                salesPercentage: rule.salesPercentage,
                appliesToVendedor: rule.appliesToVendedor,
                ruleUserId: rule.userId,
                bancaId: rule.bancaId,
                ventanaId: rule.ventanaId,
              },
              {
                userId,
                ventanaId,
                bancaId,
                sorteoId,
                at: now,
                cache,
              }
            );
            return { ruleId: rule.id, limit };
          } catch (error) {
            const fallbackLimit =
              rule.baseAmount != null && rule.baseAmount > 0
                ? rule.baseAmount
                : null;
            logger.warn({
              layer: 'repository',
              action: 'DYNAMIC_LIMIT_CALCULATION_FAILED',
              payload: {
                ruleId: rule.id,
                error: (error as Error).message,
                fallbackLimit,
              },
            });
            return { ruleId: rule.id, limit: fallbackLimit };
          }
        }
      );

      const dynamicLimitResults = await Promise.all(dynamicLimitPromises);
      for (const result of dynamicLimitResults) {
        if (result.limit != null) {
          dynamicLimits.set(result.ruleId, result.limit);
        }
      }
    }

    // 8) Validación final de todas las reglas en paralelo
    await validateRulesInParallel(tx, {
      rules: applicable,
      numbers: ticketNumbers,
      sorteoId,
      loteriaId,
      dynamicLimits,
      cache,
      vendedorId: userId,
    });

    return { warnings, preparedJugadas, totalAmountTx };
  }
}
