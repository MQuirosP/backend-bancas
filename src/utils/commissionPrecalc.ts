// src/utils/commissionPrecalc.ts
// ⚠️ DEPRECATED: Este archivo está deprecado. Usar CommissionService de src/services/commission/CommissionService.ts
// Se mantiene por compatibilidad durante la migración

import { commissionService } from '../services/commission/CommissionService';
import { CommissionSnapshot, CommissionMatchInput } from '../services/commission/types/CommissionTypes';
import { CommissionContext } from '../services/commission/types/CommissionContext';

/**
 * @deprecated Usar CommissionService.prepareContext() en su lugar
 */
export async function prepareCommissionContext(
  userId: string | null,
  ventanaId: string,
  bancaId: string,
  userPolicyJson: any,
  ventanaPolicyJson: any,
  bancaPolicyJson: any,
  listeroPolicyJson: any = null
): Promise<CommissionContext> {
  return commissionService.prepareContext(
    userId,
    ventanaId,
    bancaId,
    userPolicyJson,
    ventanaPolicyJson,
    bancaPolicyJson,
    listeroPolicyJson
  );
}

/**
 * @deprecated Usar CommissionService.calculateCommissionForJugada() en su lugar
 */
export function resolveCommissionFast(
  input: CommissionMatchInput,
  context: CommissionContext
): CommissionSnapshot {
  return commissionService.calculateCommissionForJugada(input, context);
}

/**
 * @deprecated Usar CommissionService.calculateCommissionsForJugadas() en su lugar
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
  return commissionService.calculateCommissionsForJugadas(jugadas, loteriaId, context);
}

// Re-exportar tipos para compatibilidad
export type { CommissionContext };
