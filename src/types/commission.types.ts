export type BetType = 'NUMERO' | 'REVENTADO';

export type CommissionOrigin = 'USER';

export interface CommissionResolutionInput {
  userId: string;
  loteriaId: string;
  betType: BetType;
  finalMultiplierX?: number | null;
}

export interface CommissionResolution {
  percent: number; // 0..100
  origin: CommissionOrigin; // always 'USER'
  ruleId?: string | null;
}

export interface CommissionPolicyV1 {
  version: 1;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  defaultPercent: number; // 0..100
  rules: Array<{
    id: string; // uuid
    betType: BetType;
    percent: number; // 0..100
    loteriaId?: string | null;
    multiplierRange?: { min: number; max: number };
  }>;
}

