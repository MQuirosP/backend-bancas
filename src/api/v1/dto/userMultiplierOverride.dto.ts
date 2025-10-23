// ========================================================
// UserMultiplierOverride DTOs (corregidos)
// ========================================================

export interface CreateUserMultiplierOverrideDTO {
  /** ID del usuario al que se aplica el multiplicador personalizado */
  userId: string;

  /** ID de la lotería para la cual se aplica el override */
  loteriaId: string;

  /** Tipo de multiplicador (ej. "Base", "Reventado", etc.) */
  multiplierType: string;

  /** Valor del multiplicador personalizado */
  baseMultiplierX: number; // <-- corregido (antes: baseMuliplierX)
}

export interface UpdateUserMultiplierOverrideDTO {
  /** Nuevo valor del multiplicador (opcional) */
  baseMultiplierX?: number;
}
