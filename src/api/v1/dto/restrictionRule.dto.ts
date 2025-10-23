export type CreateRestrictionRuleInput = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;
  isActive?: boolean;
  number?: string;          // "0".."999"
  maxAmount?: number;       // > 0
  maxTotal?: number;        // > 0
  salesCutoffMinutes?: number,
  appliesToDate?: Date;     // coaccionado por schema
  appliesToHour?: number;   // 0..23
};

export type UpdateRestrictionRuleInput = Partial<CreateRestrictionRuleInput>;
