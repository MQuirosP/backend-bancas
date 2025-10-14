// contrato para servicios (sin Zod)

export type CreateRestrictionRuleInput = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;

  number?: string;          // "0".."999"
  maxAmount?: number;       // > 0
  maxTotal?: number;        // > 0
  appliesToDate?: Date;     // coaccionado por schema
  appliesToHour?: number;   // 0..23
};

export type UpdateRestrictionRuleInput = Partial<CreateRestrictionRuleInput>;
