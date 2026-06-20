import logger from "../../../core/logger";
import { CommissionPolicy, CommissionPolicyOrigin } from "../types/CommissionTypes";
import { CommissionPolicySchema } from "../../../types/schemas/databaseJson.schema";

/**
 * Valida estructura básica y vigencia de una política usando Zod
 * Retorna null si JSON es malformado o si la política expiró (logea WARN/INFO)
 */
export function parseCommissionPolicy(
  policyJson: any,
  origin: CommissionPolicyOrigin
): CommissionPolicy | null {
  if (!policyJson) return null;

  // 1. Validar estructura usando Zod
  const validation = CommissionPolicySchema.safeParse(policyJson);
  if (!validation.success) {
    logger.warn({
      layer: "service",
      action: "COMMISSION_PARSE_ERROR",
      payload: { 
        origin, 
        error: "Schema validation failed", 
        details: validation.error.format() 
      },
    });
    return null;
  }

  const policy = validation.data;

  // 2. Verificar vigencia (effectiveFrom/effectiveTo)
  const now = new Date();
  if (policy.effectiveFrom && new Date(policy.effectiveFrom) > now) {
    logger.info({
      layer: "service",
      action: "COMMISSION_POLICY_NOT_EFFECTIVE",
      payload: { origin, effectiveFrom: policy.effectiveFrom },
    });
    return null; // Política aún no vigente
  }

  if (policy.effectiveTo && new Date(policy.effectiveTo) < now) {
    logger.info({
      layer: "service",
      action: "COMMISSION_POLICY_EXPIRED",
      payload: { origin, effectiveTo: policy.effectiveTo },
    });
    return null; // Política ya expirada
  }

  // Retornamos el objeto tipado y validado
  return policy as unknown as CommissionPolicy;
}
