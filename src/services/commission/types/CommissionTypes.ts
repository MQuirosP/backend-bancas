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
  } | null;
  percent: number; // 0..100
}

/**
 * Input data for commission matching
 */
export interface CommissionMatchInput {
  loteriaId: string;
  betType: BetType;
  finalMultiplierX: number | null;
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
 * Commission resolution result (for internal use)
 */
export interface CommissionResolution {
  percent: number; // 0..100
  origin: "USER" | "VENTANA" | "BANCA";
  ruleId: string | null;
}

/**
 * Input for resolving commission from policy only (no hierarchy)
 */
export interface CommissionResolutionInput {
  userId?: string;
  loteriaId: string;
  betType: BetType;
  finalMultiplierX?: number | null;
}

/**
 * Policy origin type
 */
export type CommissionPolicyOrigin = "USER" | "VENTANA" | "BANCA";

/**
 * Matching result
 */
export interface MatchingResult {
  percent: number;
  ruleId: string | null;
}

