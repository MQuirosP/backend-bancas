import logger from "../../../core/logger";
import { CommissionPolicy, CommissionPolicyOrigin } from "../types/CommissionTypes";

/**
 * Valida estructura básica y vigencia de una política
 * Retorna null si JSON es malformado (logea WARN)
 */
export function parseCommissionPolicy(
  policyJson: any,
  origin: CommissionPolicyOrigin
): CommissionPolicy | null {
  if (!policyJson) return null;

  try {
    // Validación básica
    if (typeof policyJson !== "object") {
      logger.warn({
        layer: "service",
        action: "COMMISSION_PARSE_ERROR",
        payload: { origin, error: "Policy is not an object" },
      });
      return null;
    }

    if (policyJson.version !== 1) {
      logger.warn({
        layer: "service",
        action: "COMMISSION_PARSE_ERROR",
        payload: { origin, error: "Invalid or unsupported version (must be 1)" },
      });
      return null;
    }

    if (typeof policyJson.defaultPercent !== "number") {
      logger.warn({
        layer: "service",
        action: "COMMISSION_PARSE_ERROR",
        payload: { origin, error: "defaultPercent is not a number" },
      });
      return null;
    }

    if (!Array.isArray(policyJson.rules)) {
      logger.warn({
        layer: "service",
        action: "COMMISSION_PARSE_ERROR",
        payload: { origin, error: "rules is not an array" },
      });
      return null;
    }

    // Validar cada regla
    for (const rule of policyJson.rules) {
      if (!rule.id || typeof rule.percent !== "number") {
        logger.warn({
          layer: "service",
          action: "COMMISSION_PARSE_ERROR",
          payload: { origin, error: "Invalid rule structure", rule },
        });
        return null;
      }
    }

    // Verificar vigencia (effectiveFrom/effectiveTo)
    const now = new Date();
    if (policyJson.effectiveFrom && new Date(policyJson.effectiveFrom) > now) {
      logger.info({
        layer: "service",
        action: "COMMISSION_POLICY_NOT_EFFECTIVE",
        payload: { origin, effectiveFrom: policyJson.effectiveFrom },
      });
      return null; // Política aún no vigente
    }
    if (policyJson.effectiveTo && new Date(policyJson.effectiveTo) < now) {
      logger.info({
        layer: "service",
        action: "COMMISSION_POLICY_EXPIRED",
        payload: { origin, effectiveTo: policyJson.effectiveTo },
      });
      return null; // Política ya expirada
    }

    return policyJson as CommissionPolicy;
  } catch (error) {
    logger.warn({
      layer: "service",
      action: "COMMISSION_PARSE_ERROR",
      payload: { origin, error: (error as Error).message },
    });
    return null;
  }
}


