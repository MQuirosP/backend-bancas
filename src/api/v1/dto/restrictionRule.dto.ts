export type CreateRestrictionRuleInput = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;
  isActive?: boolean;
  number?: string | string[];  // "00".."99" o array de strings (legacy: string, nuevo: string[])
  maxAmount?: number;       // > 0
  maxTotal?: number;        // > 0
  salesCutoffMinutes?: number,
  appliesToDate?: Date;     // coaccionado por schema
  appliesToHour?: number;   // 0..23
  loteriaId?: string;
  multiplierId?: string;
  message?: string | null;
};

export type UpdateRestrictionRuleInput = Partial<CreateRestrictionRuleInput>;
