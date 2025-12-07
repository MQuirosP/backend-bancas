// src/services/commission/commission.resolver.ts
// ⚠️ DEPRECATED: Este archivo está deprecado. Usar CommissionResolver de src/services/commission/CommissionResolver.ts
// Se mantiene por compatibilidad durante la migración

import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { commissionResolver } from "./CommissionResolver";
import {
  CommissionResolution,
  CommissionResolutionInput,
  CommissionPolicy,
} from "./types/CommissionTypes";
import { CommissionPolicyV1 } from "../../types/commission.types";

const ENFORCE_REVENTADO_COMMISSION = true; // negocio exige >0 para REVENTADO

/**
 * @deprecated Usar CommissionResolver.resolveFromPolicy() en su lugar
 */
export async function resolveCommission(
  input: CommissionResolutionInput
): Promise<CommissionResolution> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId! },
    select: { id: true, commissionPolicyJson: true },
  });
  
  const policy = commissionResolver.parsePolicy(
    (user as any)?.commissionPolicyJson,
    "USER"
  );
  
  const result = commissionResolver.resolveFromPolicy(
    policy,
    input,
    ENFORCE_REVENTADO_COMMISSION
  );

  logger.info({
    layer: "service",
    action: "COMMISSION_RESOLVE",
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

/**
 * @deprecated Usar CommissionResolver.resolveFromPolicy() en su lugar
 */
export function resolveCommissionFromPolicy(
  policy: CommissionPolicyV1 | null,
  input: CommissionResolutionInput
): CommissionResolution {
  // Convertir CommissionPolicyV1 a CommissionPolicy si es necesario
  // CommissionPolicyV1 y CommissionPolicy tienen la misma estructura
  const convertedPolicy = policy as CommissionPolicy | null;
  
  return commissionResolver.resolveFromPolicy(
    convertedPolicy,
    input,
    ENFORCE_REVENTADO_COMMISSION
  );
}

export default { resolveCommission };
