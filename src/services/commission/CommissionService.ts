import { commissionResolver } from "./CommissionResolver";
import {
  CommissionMatchInput,
  CommissionSnapshot,
  CommissionPolicy,
  CommissionPolicyOrigin,
} from "./types/CommissionTypes";
import { CommissionContext } from "./types/CommissionContext";
import { parseCommissionPolicy } from "./utils/PolicyParser";
import { getCachedCommissionPolicy } from "../../utils/commissionCache";

/**
 * Servicio centralizado para cálculo de comisiones
 * Integra funcionalidad de resolver y precalc
 */
export class CommissionService {
  /**
   * Prepara el contexto de comisiones (parsea y cachea políticas)
   */
  async prepareContext(
    userId: string | null,
    ventanaId: string,
    bancaId: string,
    userPolicyJson: any,
    ventanaPolicyJson: any,
    bancaPolicyJson: any,
    listeroPolicyJson: any = null
  ): Promise<CommissionContext> {
    const userPolicy = userId
      ? await getCachedCommissionPolicy("USER", userId, userPolicyJson)
      : null;
    const ventanaPolicy = await getCachedCommissionPolicy(
      "VENTANA",
      ventanaId,
      ventanaPolicyJson
    );
    const bancaPolicy = await getCachedCommissionPolicy(
      "BANCA",
      bancaId,
      bancaPolicyJson
    );
    const listeroPolicy = listeroPolicyJson
      ? parseCommissionPolicy(listeroPolicyJson, "USER")
      : null;

    return {
      userPolicy,
      ventanaPolicy,
      bancaPolicy,
      listeroPolicy,
    };
  }

  /**
   * Calcula comisión para una jugada individual usando contexto ya preparado
   * Versión optimizada que evita parsing repetitivo
   */
  calculateCommissionForJugada(
    input: CommissionMatchInput,
    context: CommissionContext
  ): CommissionSnapshot {
    // Intentar resolver desde USER
    if (context.userPolicy) {
      const match = commissionResolver.findMatchingRule(
        context.userPolicy,
        input
      );
      if (match) {
        const commissionAmount = parseFloat(
          ((input.amount * match.percent) / 100).toFixed(2)
        );
        return {
          commissionPercent: match.percent,
          commissionAmount,
          commissionOrigin: "USER",
          commissionRuleId: match.ruleId,
        };
      }
    }

    // Intentar resolver desde VENTANA
    if (context.ventanaPolicy) {
      const match = commissionResolver.findMatchingRule(
        context.ventanaPolicy,
        input
      );
      if (match) {
        const commissionAmount = parseFloat(
          ((input.amount * match.percent) / 100).toFixed(2)
        );
        return {
          commissionPercent: match.percent,
          commissionAmount,
          commissionOrigin: "VENTANA",
          commissionRuleId: match.ruleId,
        };
      }
    }

    // Intentar resolver desde BANCA
    if (context.bancaPolicy) {
      const match = commissionResolver.findMatchingRule(
        context.bancaPolicy,
        input
      );
      if (match) {
        const commissionAmount = parseFloat(
          ((input.amount * match.percent) / 100).toFixed(2)
        );
        return {
          commissionPercent: match.percent,
          commissionAmount,
          commissionOrigin: "BANCA",
          commissionRuleId: match.ruleId,
        };
      }
    }

    // Si no hay match
    return {
      commissionPercent: 0,
      commissionAmount: 0,
      commissionOrigin: null,
      commissionRuleId: null,
    };
  }

  /**
   * Calcula comisiones para múltiples jugadas usando contexto ya preparado
   * Versión optimizada que evita parsing repetitivo
   */
  calculateCommissionsForJugadas(
    jugadas: Array<{
      type: "NUMERO" | "REVENTADO";
      number: string;
      amount: number;
      finalMultiplierX: number;
    }>,
    loteriaId: string,
    context: CommissionContext
  ): Array<{
    type: "NUMERO" | "REVENTADO";
    number: string;
    amount: number;
    finalMultiplierX: number;
    commissionPercent: number;
    commissionAmount: number;
    commissionOrigin: "USER" | "VENTANA" | "BANCA" | null;
    commissionRuleId: string | null;
  }> {
    return jugadas.map((j) => {
      const commission = this.calculateCommissionForJugada(
        {
          loteriaId,
          betType: j.type,
          finalMultiplierX: j.finalMultiplierX,
          amount: j.amount,
        },
        context
      );

      return {
        ...j,
        ...commission,
      };
    });
  }

  /**
   * Calcula comisión del vendedor usando jerarquía completa
   * USER → VENTANA → BANCA
   */
  calculateVendedorCommission(
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
   * Calcula comisión del listero usando jerarquía VENTANA → BANCA
   */
  calculateListeroCommission(
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
   * Valida una política de comisión
   */
  validatePolicy(
    policyJson: any,
    origin: CommissionPolicyOrigin
  ): { valid: boolean; policy: CommissionPolicy | null; error?: string } {
    const policy = parseCommissionPolicy(policyJson, origin);
    if (!policy) {
      return {
        valid: false,
        policy: null,
        error: "Invalid or expired policy",
      };
    }
    return { valid: true, policy };
  }
}

// Instancia singleton para uso directo
export const commissionService = new CommissionService();


