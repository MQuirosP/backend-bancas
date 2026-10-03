/**
 * Dimensiones y cálculos métricos para impresión térmica (58mm / 88mm).
 * Utilidad matemática pura sin dependencias nativas gráficas ni de Canvas.
 */

/**
 * Convierte ancho de papel en mm a píxeles (a 96 DPI estándar de impresora térmica)
 * - 58mm -> 220px
 * - 88mm -> 340px
 */
export function mmToPixels(widthMm: number | null): number {
  if (!widthMm) {
    return 220; // Default: 58mm (220px)
  }

  if (widthMm === 58) {
    return 220;
  } else if (widthMm === 88) {
    return 340;
  }

  // Fallback: calcular proporcionalmente
  return Math.round(widthMm * 3.779527559);
}
