import { CommissionRule, CommissionMatchInput, MatchingResult, CommissionPolicy } from "../types/CommissionTypes";

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
): MatchingResult | null {
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
 * Matching específico para tipo NUMERO
 * Prioriza reglas con rango explícito, luego genéricas
 */
export function matchNumero(
  policy: CommissionPolicy,
  loteriaId: string,
  finalMultiplierX?: number | null
): MatchingResult {
  const rules = policy.rules.filter(
    (r) => r.betType === "NUMERO" && (!r.loteriaId || r.loteriaId === loteriaId)
  );
  
  if (rules.length === 0) {
    return { percent: policy.defaultPercent, ruleId: null };
  }

  if (typeof finalMultiplierX === "number") {
    // Primero, buscar por rango explícito
    for (const r of rules) {
      const range = r.multiplierRange;
      if (range && finalMultiplierX >= range.min && finalMultiplierX <= range.max) {
        return { percent: r.percent, ruleId: r.id };
      }
    }
  }
  
  // Regla genérica para lotería (sin rango)
  const generic = rules.find((r) => !r.multiplierRange);
  if (generic) {
    return { percent: generic.percent, ruleId: generic.id };
  }

  return { percent: policy.defaultPercent, ruleId: null };
}

/**
 * Matching específico para tipo REVENTADO
 * Prioriza reglas con rango más estrecho primero, luego genéricas
 */
export function matchReventado(
  policy: CommissionPolicy,
  loteriaId: string
): MatchingResult {
  const rules = policy.rules.filter(
    (r) => r.betType === "REVENTADO" && (!r.loteriaId || r.loteriaId === loteriaId)
  );
  
  if (rules.length === 0) {
    return { percent: policy.defaultPercent, ruleId: null };
  }

  // Preferir regla con rango (más específica), ordenar por rango más estrecho primero
  const ranged = rules
    .filter((r) => !!r.multiplierRange)
    .sort((a, b) => {
      const aw = (a.multiplierRange!.max - a.multiplierRange!.min);
      const bw = (b.multiplierRange!.max - b.multiplierRange!.min);
      if (aw !== bw) return aw - bw; // más estrecho primero
      return (a.multiplierRange!.min - b.multiplierRange!.min);
    });
  
  if (ranged.length > 0) {
    return { percent: ranged[0].percent, ruleId: ranged[0].id };
  }

  const generic = rules.find((r) => !r.multiplierRange);
  if (generic) {
    return { percent: generic.percent, ruleId: generic.id };
  }

  return { percent: policy.defaultPercent, ruleId: null };
}

