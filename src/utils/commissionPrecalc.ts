// src/utils/commissionPrecalc.ts
import { CommissionSnapshot, CommissionMatchInput, findMatchingRule } from '../services/commission.resolver';
import { getCachedCommissionPolicy } from './commissionCache';
import logger from '../core/logger';

/**
 * Contexto de políticas de comisión ya parseadas y cacheadas
 */
export interface CommissionContext {
  userPolicy: any;
  ventanaPolicy: any;
  bancaPolicy: any;
}

/**
 * Pre-calcula comisiones para múltiples jugadas usando políticas ya parseadas
 * Versión optimizada que evita parsing repetitivo
 */
export function resolveCommissionFast(
  input: CommissionMatchInput,
  context: CommissionContext
): CommissionSnapshot {
  // Intentar resolver desde USER
  if (context.userPolicy) {
    const match = findMatchingRule(context.userPolicy, input);
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
  if (context.ventanaPolicy) {
    const match = findMatchingRule(context.ventanaPolicy, input);
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
  if (context.bancaPolicy) {
    const match = findMatchingRule(context.bancaPolicy, input);
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
  return {
    commissionPercent: 0,
    commissionAmount: 0,
    commissionOrigin: null,
    commissionRuleId: null,
  };
}

/**
 * Prepara el contexto de comisiones parseando y cacheando políticas
 */
export async function prepareCommissionContext(
  userId: string,
  ventanaId: string,
  bancaId: string,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any
): Promise<CommissionContext> {
  const userPolicy = getCachedCommissionPolicy('USER', userId, userPolicyJson);
  const ventanaPolicy = getCachedCommissionPolicy('VENTANA', ventanaId, ventanaPolicyJson);
  const bancaPolicy = getCachedCommissionPolicy('BANCA', bancaId, bancaPolicyJson);

  return {
    userPolicy,
    ventanaPolicy,
    bancaPolicy,
  };
}

/**
 * Pre-calcula comisiones para todas las jugadas antes de entrar a la transacción
 */
export function preCalculateCommissions(
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
    const commission = resolveCommissionFast(
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

