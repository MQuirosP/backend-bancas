import prisma from '../../core/prismaClient';
import logger from '../../core/logger';
import { AppError } from '../../core/errors';
import {
  BetType,
  CommissionResolution,
  CommissionResolutionInput,
  CommissionPolicyV1,
} from '../../types/commission.types';

const ENFORCE_REVENTADO_COMMISSION = true; // negocio exige >0 para REVENTADO

function parsePolicy(json: any): CommissionPolicyV1 | null {
  if (!json || typeof json !== 'object') return null;
  if (json.version !== 1) return null;
  if (!Array.isArray(json.rules)) return null;
  const policy = json as CommissionPolicyV1;
  const now = new Date();
  if (policy.effectiveFrom && new Date(policy.effectiveFrom) > now) return null;
  if (policy.effectiveTo && new Date(policy.effectiveTo) < now) return null;
  return policy;
}

function matchNumero(policy: CommissionPolicyV1, loteriaId: string, finalMultiplierX?: number | null) {
  const rules = policy.rules.filter((r) => r.betType === 'NUMERO' && (!r.loteriaId || r.loteriaId === loteriaId));
  if (rules.length === 0) return { percent: policy.defaultPercent, ruleId: null };

  if (typeof finalMultiplierX === 'number') {
    // Primero, por rango explícito
    for (const r of rules) {
      const range = r.multiplierRange;
      if (range && finalMultiplierX >= range.min && finalMultiplierX <= range.max) {
        return { percent: r.percent, ruleId: r.id };
      }
    }
  }
  // Regla genérica para lotería (sin rango)
  const generic = rules.find((r) => !r.multiplierRange);
  if (generic) return { percent: generic.percent, ruleId: generic.id };

  return { percent: policy.defaultPercent, ruleId: null };
}

function matchReventado(policy: CommissionPolicyV1, loteriaId: string) {
  const rules = policy.rules.filter((r) => r.betType === 'REVENTADO' && (!r.loteriaId || r.loteriaId === loteriaId));
  if (rules.length === 0) return { percent: policy.defaultPercent, ruleId: null };

  // Preferir regla con rango (más específica), luego genérica
  const ranged = rules
    .filter((r) => !!r.multiplierRange)
    .sort((a, b) => {
      const aw = (a.multiplierRange!.max - a.multiplierRange!.min);
      const bw = (b.multiplierRange!.max - b.multiplierRange!.min);
      if (aw !== bw) return aw - bw; // más estrecho primero
      return (a.multiplierRange!.min - b.multiplierRange!.min);
    });
  if (ranged.length > 0) return { percent: ranged[0].percent, ruleId: ranged[0].id };

  const generic = rules.find((r) => !r.multiplierRange);
  if (generic) return { percent: generic.percent, ruleId: generic.id };

  return { percent: policy.defaultPercent, ruleId: null };
}

export async function resolveCommission(input: CommissionResolutionInput): Promise<CommissionResolution> {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, commissionPolicyJson: true } });
  const policy = parsePolicy((user as any)?.commissionPolicyJson);
  const result = resolveCommissionFromPolicy(policy, input);

  logger.info({
    layer: 'service',
    action: 'COMMISSION_RESOLVE',
    payload: {
      userId: input.userId,
      loteriaId: input.loteriaId,
      betType: input.betType,
      origin: result.origin,
      ruleId: result.ruleId ?? null,
      percent: result.percent,
    },
  });

  return result;
}

export function resolveCommissionFromPolicy(policy: CommissionPolicyV1 | null, input: CommissionResolutionInput): CommissionResolution {
  const base: CommissionResolution = { percent: 0, origin: 'USER', ruleId: null };
  if (!policy) {
    if (input.betType === 'REVENTADO' && ENFORCE_REVENTADO_COMMISSION) {
      throw new AppError(
        'No hay regla o default válido para REVENTADO en esta lotería para el usuario.',
        422,
        'COMMISSION_RULE_MISSING'
      );
    }
    return base;
  }

  let picked: { percent: number; ruleId: string | null };
  if (input.betType === 'NUMERO') {
    picked = matchNumero(policy, input.loteriaId, input.finalMultiplierX ?? undefined);
  } else {
    picked = matchReventado(policy, input.loteriaId);
  }

  if (input.betType === 'REVENTADO' && ENFORCE_REVENTADO_COMMISSION && picked.percent === 0) {
    throw new AppError(
      'No hay regla o default válido para REVENTADO en esta lotería para el usuario.',
      422,
      'COMMISSION_RULE_MISSING'
    );
  }

  return { percent: picked.percent, origin: 'USER', ruleId: picked.ruleId };
}

export default { resolveCommission };

