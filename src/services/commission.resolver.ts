// src/services/commission.resolver.ts
// ️ DEPRECATED: Este archivo está deprecado. Usar CommissionResolver de src/services/commission/CommissionResolver.ts
// Se mantiene por compatibilidad durante la migración

import { commissionResolver } from "./commission/CommissionResolver";
import {
  CommissionPolicy,
  CommissionRule,
  CommissionMatchInput,
  CommissionSnapshot,
} from "./commission/types/CommissionTypes";
import { parseCommissionPolicy as parsePolicy } from "./commission/utils/PolicyParser";
import { findMatchingRule as findRule } from "./commission/utils/RuleMatcher";

/**
 * @deprecated Usar CommissionResolver.resolveVendedorCommission() en su lugar
 */
export function resolveCommission(
  input: CommissionMatchInput,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot {
  return commissionResolver.resolveVendedorCommission(
    input,
    userPolicyJson,
    ventanaPolicyJson,
    bancaPolicyJson
  );
}

/**
 * @deprecated Usar CommissionResolver.resolveListeroCommission() en su lugar
 */
export function resolveListeroCommission(
  input: CommissionMatchInput,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot {
  return commissionResolver.resolveListeroCommission(
    input,
    ventanaPolicyJson,
    bancaPolicyJson
  );
}

/**
 * @deprecated Usar parseCommissionPolicy de utils/PolicyParser en su lugar
 */
export function parseCommissionPolicy(
  policyJson: any,
  origin: "USER" | "VENTANA" | "BANCA"
): CommissionPolicy | null {
  return parsePolicy(policyJson, origin);
}

/**
 * @deprecated Usar findMatchingRule de utils/RuleMatcher en su lugar
 */
export function findMatchingRule(
  policy: CommissionPolicy,
  input: CommissionMatchInput
): { percent: number; ruleId: string | null } | null {
  return findRule(policy, input);
}

// Re-exportar tipos para compatibilidad
export type {
  CommissionPolicy,
  CommissionRule,
  CommissionMatchInput,
  CommissionSnapshot,
};
