import prisma from './prismaClient';
import logger from './logger';

let _isEmpty: boolean | null = null;
let _lastChecked = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Devuelve true si sorteo_lista_exclusion está vacía (0 filas).
 * El resultado se cachea 5 minutos. En caso de error asume que NO está vacía (fail-safe).
 *
 * Uso: if (await isExclusionListEmpty()) { ... omitir filtro ... }
 */
export async function isExclusionListEmpty(): Promise<boolean> {
  const now = Date.now();
  if (_isEmpty !== null && now - _lastChecked < CACHE_TTL_MS) {
    return _isEmpty;
  }
  try {
    const count = await prisma.sorteoListaExclusion.count();
    _isEmpty = count === 0;
    _lastChecked = now;
    return _isEmpty;
  } catch (error: any) {
    logger.warn({
      layer: 'core',
      action: 'EXCLUSION_LIST_CACHE_ERROR',
      requestId: null,
      meta: { error: error instanceof Error ? error.message : String(error) },
    });
    return false; // fail-safe: asumir NO vacío para no omitir exclusiones reales
  }
}

/**
 * Invalida el cache inmediatamente.
 * Llamar cuando se crea o elimina un registro en sorteo_lista_exclusion.
 */
export function invalidateExclusionListCache(): void {
  _isEmpty = null;
  _lastChecked = 0;
}
