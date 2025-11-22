// src/services/commission.resolver.ts
import logger from "../core/logger";
import { BetType } from "@prisma/client";

/**
 * Commission Policy JSON structure (stored in Banca, Ventana, User)
 * Version 1 - Percent in 0..100
 */
export interface CommissionPolicy {
  version: 1;
  effectiveFrom: string | null; // ISO 8601 o null
  effectiveTo: string | null; // ISO 8601 o null
  defaultPercent: number; // 0..100
  rules: CommissionRule[];
}

/**
 * Commission Rule structure
 */
export interface CommissionRule {
  id: string; // No vacío
  loteriaId: string | null; // UUID o null
  betType: BetType | null; // "NUMERO" | "REVENTADO" | null
  multiplierRange: {
    min: number;
    max: number; // min <= max, inclusivo
  };
  percent: number; // 0..100
}

/**
 * Input data for commission matching
 */
export interface CommissionMatchInput {
  loteriaId: string;
  betType: BetType;
  finalMultiplierX: number;
  amount: number;
}

/**
 * Commission snapshot result (to be stored in Jugada)
 * commissionPercent en 0..100
 */
export interface CommissionSnapshot {
  commissionPercent: number; // 0..100
  commissionAmount: number; // round2
  commissionOrigin: "USER" | "VENTANA" | "BANCA" | null;
  commissionRuleId: string | null;
}

/**
 * Valida estructura básica y vigencia de una política
 * Retorna null si JSON es malformado (logea WARN)
 */
export function parseCommissionPolicy(
  policyJson: any,
  origin: "USER" | "VENTANA" | "BANCA"
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

/**
 * Verifica si una regla aplica al input dado
 * Match exacto: loteriaId (o null), betType (o null), multiplierRange
 */
function ruleMatches(rule: CommissionRule, input: CommissionMatchInput): boolean {
  // Si la regla especifica loteriaId (no null), debe coincidir
  if (rule.loteriaId !== null && rule.loteriaId !== input.loteriaId) {
    return false;
  }

  // Si la regla especifica betType (no null), debe coincidir
  if (rule.betType !== null && rule.betType !== input.betType) {
    return false;
  }

  // Para NUMERO las reglas pueden depender del rango de multiplicador.
  // Para REVENTADO o cuando no se proporciona multiplicador, ignorar el rango.
  if (rule.multiplierRange && (rule.betType === null || rule.betType === "NUMERO")) {
    const multiplier = typeof input.finalMultiplierX === "number" ? input.finalMultiplierX : null;
    if (multiplier !== null) {
      const { min, max } = rule.multiplierRange;
      if (multiplier < min || multiplier > max) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Encuentra la PRIMERA regla que aplica en una política (first match wins)
 * Retorna { percent, ruleId } o null si no hay match
 */
export function findMatchingRule(
  policy: CommissionPolicy,
  input: CommissionMatchInput
): { percent: number; ruleId: string | null } | null {
  // Buscar primera regla que aplica (orden del array)
  for (const rule of policy.rules) {
    if (ruleMatches(rule, input)) {
      return { percent: rule.percent, ruleId: rule.id };
    }
  }

  // Si no hay regla específica, usar defaultPercent
  return { percent: policy.defaultPercent, ruleId: null };
}

/**
 * Resuelve la comisión aplicable para una jugada
 * Prioridad: USER → VENTANA → BANCA
 * Retorna snapshot inmutable para almacenar en Jugada
 * Ante JSON malformado: percent=0 y WARN (no bloquea venta)
 */
export function resolveCommission(
  input: CommissionMatchInput,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot {
  // Intentar resolver desde USER
  const userPolicy = parseCommissionPolicy(userPolicyJson, "USER");
  if (userPolicy) {
    const match = findMatchingRule(userPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(((input.amount * match.percent) / 100).toFixed(2));
      logger.info({
        layer: "service",
        action: "COMMISSION_RESOLVED",
        payload: {
          origin: "USER",
          percent: match.percent,
          ruleId: match.ruleId,
          amount: commissionAmount,
        },
      });
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "USER",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // Intentar resolver desde VENTANA
  const ventanaPolicy = parseCommissionPolicy(ventanaPolicyJson, "VENTANA");
  if (ventanaPolicy) {
    const match = findMatchingRule(ventanaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(((input.amount * match.percent) / 100).toFixed(2));
      logger.info({
        layer: "service",
        action: "COMMISSION_RESOLVED",
        payload: {
          origin: "VENTANA",
          percent: match.percent,
          ruleId: match.ruleId,
          amount: commissionAmount,
        },
      });
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "VENTANA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // Intentar resolver desde BANCA
  const bancaPolicy = parseCommissionPolicy(bancaPolicyJson, "BANCA");
  if (bancaPolicy) {
    const match = findMatchingRule(bancaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(((input.amount * match.percent) / 100).toFixed(2));
      logger.info({
        layer: "service",
        action: "COMMISSION_RESOLVED",
        payload: {
          origin: "BANCA",
          percent: match.percent,
          ruleId: match.ruleId,
          amount: commissionAmount,
        },
      });
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "BANCA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // Fallback: Sin comisión (0%)
  // Cambiar a DEBUG para evitar logs excesivos cuando no hay políticas configuradas
  logger.debug({
    layer: "service",
    action: "COMMISSION_RESOLVED",
    payload: {
      origin: null,
      percent: 0,
      ruleId: null,
      amount: 0,
      note: "No commission policy found, defaulting to 0%",
    },
  });

  return {
    commissionPercent: 0,
    commissionAmount: 0,
    commissionOrigin: null,
    commissionRuleId: null,
  };
}

/**
 * Resuelve la comisión del LISTERO (ventana) para una jugada
 * Prioridad: VENTANA → BANCA (NO incluye USER)
 * Usado para snapshot de comisión del listero en Jugada
 */
export function resolveListeroCommission(
  input: CommissionMatchInput,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): CommissionSnapshot {
  // Intentar resolver desde VENTANA
  const ventanaPolicy = parseCommissionPolicy(ventanaPolicyJson, "VENTANA");
  if (ventanaPolicy) {
    const match = findMatchingRule(ventanaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(((input.amount * match.percent) / 100).toFixed(2));
      logger.info({
        layer: "service",
        action: "LISTERO_COMMISSION_RESOLVED",
        payload: {
          origin: "VENTANA",
          percent: match.percent,
          ruleId: match.ruleId,
          amount: commissionAmount,
          loteriaId: input.loteriaId,
          betType: input.betType,
          multiplierX: input.finalMultiplierX,
        },
      });
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "VENTANA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // Intentar resolver desde BANCA
  const bancaPolicy = parseCommissionPolicy(bancaPolicyJson, "BANCA");
  if (bancaPolicy) {
    const match = findMatchingRule(bancaPolicy, input);
    if (match) {
      const commissionAmount = parseFloat(((input.amount * match.percent) / 100).toFixed(2));
      logger.info({
        layer: "service",
        action: "LISTERO_COMMISSION_RESOLVED",
        payload: {
          origin: "BANCA",
          percent: match.percent,
          ruleId: match.ruleId,
          amount: commissionAmount,
          loteriaId: input.loteriaId,
          betType: input.betType,
          multiplierX: input.finalMultiplierX,
        },
      });
      return {
        commissionPercent: match.percent,
        commissionAmount,
        commissionOrigin: "BANCA",
        commissionRuleId: match.ruleId,
      };
    }
  }

  // Log cuando no se encuentra comisión del listero
  logger.warn({
    layer: "service",
    action: "LISTERO_COMMISSION_NOT_FOUND",
    payload: {
      loteriaId: input.loteriaId,
      betType: input.betType,
      multiplierX: input.finalMultiplierX,
      amount: input.amount,
      ventanaPolicyExists: !!ventanaPolicy,
      bancaPolicyExists: !!bancaPolicy,
      ventanaPolicyRules: ventanaPolicy?.rules?.length ?? 0,
      bancaPolicyRules: bancaPolicy?.rules?.length ?? 0,
    },
  });

  // Fallback: Sin comisión (0%)
  return {
    commissionPercent: 0,
    commissionAmount: 0,
    commissionOrigin: null,
    commissionRuleId: null,
  };
}
