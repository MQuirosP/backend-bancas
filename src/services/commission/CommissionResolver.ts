import logger from "../../core/logger";
import { AppError } from "../../core/errors";
import {
  CommissionPolicy,
  CommissionMatchInput,
  CommissionSnapshot,
  CommissionResolution,
  CommissionResolutionInput,
  CommissionPolicyOrigin,
  MatchingResult,
} from "./types/CommissionTypes";
import { parseCommissionPolicy } from "./utils/PolicyParser";
import { findMatchingRule, matchNumero, matchReventado } from "./utils/RuleMatcher";

/**
 * Configuración para validación de REVENTADO
 */
const ENFORCE_REVENTADO_COMMISSION = true; // negocio exige >0 para REVENTADO

/**
 * Resolver unificado de comisiones
 * Consolida la funcionalidad de los dos resolvers anteriores
 */
export class CommissionResolver {
  /**
   * Resuelve la comisión aplicable para una jugada
   * Prioridad: USER → VENTANA → BANCA
   * Retorna snapshot inmutable para almacenar en Jugada
   * Ante JSON malformado: percent=0 y WARN (no bloquea venta)
   */
  resolveVendedorCommission(
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
        return {
          commissionPercent: match.percent,
          commissionAmount,
          commissionOrigin: "BANCA",
          commissionRuleId: match.ruleId,
        };
      }
    }

    // Fallback: Sin comisión (0%)
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
  resolveListeroCommission(
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
        // logger.info({
        //   layer: "service",
        //   action: "LISTERO_COMMISSION_RESOLVED",
        //   payload: {
        //     origin: "VENTANA",
        //     percent: match.percent,
        //     ruleId: match.ruleId,
        //     amount: commissionAmount,
        //     loteriaId: input.loteriaId,
        //     betType: input.betType,
        //     multiplierX: input.finalMultiplierX,
        //   },
        // });
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
        // logger.info({
        //   layer: "service",
        //   action: "LISTERO_COMMISSION_RESOLVED",
        //   payload: {
        //     origin: "BANCA",
        //     percent: match.percent,
        //     ruleId: match.ruleId,
        //     amount: commissionAmount,
        //     loteriaId: input.loteriaId,
        //     betType: input.betType,
        //     multiplierX: input.finalMultiplierX,
        //   },
        // });
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

  /**
   * Resuelve comisión desde una política única (sin jerarquía)
   * Útil para casos especiales donde solo se tiene una política
   * Soporta validación estricta de REVENTADO si se requiere
   */
  resolveFromPolicy(
    policy: CommissionPolicy | null,
    input: CommissionResolutionInput,
    enforceReventado: boolean = false
  ): CommissionResolution {
    const base: CommissionResolution = { percent: 0, origin: "USER", ruleId: null };
    
    if (!policy) {
      if (input.betType === "REVENTADO" && enforceReventado && ENFORCE_REVENTADO_COMMISSION) {
        throw new AppError(
          "No hay regla o default válido para REVENTADO en esta lotería para el usuario.",
          422,
          "COMMISSION_RULE_MISSING"
        );
      }
      return base;
    }

    let picked: MatchingResult;
    if (input.betType === "NUMERO") {
      picked = matchNumero(policy, input.loteriaId, input.finalMultiplierX ?? undefined);
    } else {
      picked = matchReventado(policy, input.loteriaId);
    }

    if (input.betType === "REVENTADO" && enforceReventado && ENFORCE_REVENTADO_COMMISSION && picked.percent === 0) {
      throw new AppError(
        "No hay regla o default válido para REVENTADO en esta lotería para el usuario.",
        422,
        "COMMISSION_RULE_MISSING"
      );
    }

    return { percent: picked.percent, origin: "USER", ruleId: picked.ruleId };
  }

  /**
   * Encuentra la regla que aplica en una política
   * Wrapper para compatibilidad
   */
  findMatchingRule(policy: CommissionPolicy, input: CommissionMatchInput): MatchingResult | null {
    return findMatchingRule(policy, input);
  }

  /**
   * Parsea una política de comisión
   * Wrapper para compatibilidad
   */
  parsePolicy(policyJson: any, origin: CommissionPolicyOrigin): CommissionPolicy | null {
    return parseCommissionPolicy(policyJson, origin);
  }
}

// Instancia singleton para uso directo
export const commissionResolver = new CommissionResolver();


