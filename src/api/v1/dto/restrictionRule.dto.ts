export type CreateRestrictionRuleInput = {
  bancaId?: string;
  ventanaId?: string;
  userId?: string;
  isActive?: boolean;
  isAutoDate?: boolean;     // Si true, el campo number se actualiza automáticamente al día del mes
  number?: string | string[];  // "00".."99" o array de strings (legacy: string, nuevo: string[])
  maxAmount?: number;       // > 0
  maxTotal?: number;        // > 0
  baseAmount?: number;     // Monto base para restricciones por porcentaje (>= 0)
  salesPercentage?: number; // Porcentaje de ventas permitido (0-100)
  appliesToVendedor?: boolean; // Si aplica por vendedor (true) o globalmente (false)
  salesCutoffMinutes?: number,
  appliesToDate?: Date;     // coaccionado por schema
  appliesToHour?: number;   // 0..23
  loteriaId?: string;
  multiplierId?: string;
  message?: string | null;
};

export type UpdateRestrictionRuleInput = Partial<CreateRestrictionRuleInput>;
