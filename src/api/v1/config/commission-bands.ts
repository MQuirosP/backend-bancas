/**
 * Definición de bandas de comisión para Cierre Operativo
 * Mapea rangos de multiplicadores a bandas (80/85/90/92 y 200 para Reventado)
 */

export type BandaMultiplicador = 80 | 85 | 90 | 92 | 200;

export interface BandaRange {
  banda: BandaMultiplicador;
  min: number;
  max: number;
  description: string;
}

/**
 * Configuración de bandas para BetType=NUMERO
 * Los rangos deben coincidir con los multiplierRange de CommissionPolicy
 */
export const NUMERO_BANDS: BandaRange[] = [
  {
    banda: 80,
    min: 1,
    max: 80,
    description: 'Banda 80 (multiplicador 1-80x)',
  },
  {
    banda: 85,
    min: 81,
    max: 85,
    description: 'Banda 85 (multiplicador 81-85x)',
  },
  {
    banda: 90,
    min: 86,
    max: 90,
    description: 'Banda 90 (multiplicador 86-90x)',
  },
  {
    banda: 92,
    min: 91,
    max: 92,
    description: 'Banda 92 (multiplicador 91-92x)',
  },
];

/**
 * Banda especial para BetType=REVENTADO (siempre 200)
 */
export const REVENTADO_BANDA: BandaMultiplicador = 200;

/**
 * Lista de todas las bandas en orden de presentación
 */
export const ALL_BANDS: BandaMultiplicador[] = [80, 85, 90, 92, 200];

/**
 * Determina la banda basándose en el tipo de apuesta y multiplicador
 * @param betType - Tipo de apuesta (NUMERO o REVENTADO)
 * @param multiplier - Multiplicador final (finalMultiplierX)
 * @returns Banda asignada (80/85/90/92/200)
 */
export function getBandaForJugada(
  betType: 'NUMERO' | 'REVENTADO',
  multiplier: number
): BandaMultiplicador {
  // Reventado siempre va a banda 200
  if (betType === 'REVENTADO') {
    return REVENTADO_BANDA;
  }

  // Para NUMERO, buscar en rangos
  for (const range of NUMERO_BANDS) {
    if (multiplier >= range.min && multiplier <= range.max) {
      return range.banda;
    }
  }

  // Si no coincide con ninguna banda, asignar a la más cercana
  // (casos edge: multiplicadores fuera de rango)
  if (multiplier < NUMERO_BANDS[0].min) {
    return NUMERO_BANDS[0].banda; // 80
  }

  // Si es mayor que el máximo, asignar a la banda más alta de NUMERO
  return NUMERO_BANDS[NUMERO_BANDS.length - 1].banda; // 92
}

/**
 * Obtiene la descripción de una banda
 */
export function getBandaDescription(banda: BandaMultiplicador): string {
  if (banda === REVENTADO_BANDA) {
    return 'Banda 200 (Reventado)';
  }

  const range = NUMERO_BANDS.find((r) => r.banda === banda);
  return range?.description || `Banda ${banda}`;
}

/**
 * Validador de banda
 */
export function isValidBanda(banda: any): banda is BandaMultiplicador {
  return ALL_BANDS.includes(banda as BandaMultiplicador);
}
