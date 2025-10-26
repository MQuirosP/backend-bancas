// ========================================================
// MultiplierOverride DTOs
// ========================================================

export type OverrideScope = "USER" | "VENTANA";

export interface CreateMultiplierOverrideDTO {
  /** Scope type: USER or VENTANA */
  scope: OverrideScope;

  /** ID of the user or ventana (depending on scope) */
  scopeId: string;

  /** ID of the loteria for which the override applies */
  loteriaId: string;

  /** Type of multiplier (e.g., "NUMERO", "REVENTADO", etc.) */
  multiplierType: string;

  /** Custom multiplier value */
  baseMultiplierX: number;
}

export interface UpdateMultiplierOverrideDTO {
  /** New multiplier value (optional) */
  baseMultiplierX?: number;

  /** Active status (optional) */
  isActive?: boolean;
}

export interface ListMultiplierOverrideQueryDTO {
  /** Filter by scope type */
  scope?: OverrideScope;

  /** Filter by scopeId (userId or ventanaId) */
  scopeId?: string;

  /** Filter by loteria ID */
  loteriaId?: string;

  /** Filter by multiplier type */
  multiplierType?: string;

  /** Filter by active status */
  isActive?: boolean;

  /** Page number for pagination */
  page?: number;

  /** Page size for pagination */
  pageSize?: number;
}
