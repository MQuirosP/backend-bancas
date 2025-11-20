// src/utils/sorteoCache.ts
import logger from '../core/logger';

/**
 * Cache de listados de sorteos
 * TTL: 30 segundos (sorteos cambian poco pero necesitamos datos relativamente frescos)
 */
interface CachedSorteoList {
  data: any[];
  meta: any;
  expiresAt: number;
}

const sorteoListCache = new Map<string, CachedSorteoList>();

const CACHE_TTL_MS = 30 * 1000; // 30 segundos

/**
 * Genera una clave de cache basada en los parámetros de filtro
 */
function generateCacheKey(params: {
  loteriaId?: string;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  isActive?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  groupBy?: string;
}): string {
  const parts = [
    params.loteriaId || 'all',
    params.page || 1,
    params.pageSize || 10,
    params.status || 'all',
    params.search || '',
    params.isActive !== undefined ? String(params.isActive) : 'all',
    params.dateFrom?.toISOString() || '',
    params.dateTo?.toISOString() || '',
    params.groupBy || 'none',
  ];
  return `sorteos:${parts.join(':')}`;
}

/**
 * Obtiene un listado de sorteos desde el cache o retorna null si no existe o expiró
 */
export function getCachedSorteoList(params: {
  loteriaId?: string;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  isActive?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  groupBy?: string;
}): { data: any[]; meta: any } | null {
  const cacheKey = generateCacheKey(params);
  const cached = sorteoListCache.get(cacheKey);

  // Si hay cache válido, retornarlo
  if (cached && cached.expiresAt > Date.now()) {
    logger.debug({
      layer: 'cache',
      action: 'SORTEO_LIST_CACHE_HIT',
      payload: { cacheKey },
    });
    return { data: cached.data, meta: cached.meta };
  }

  // Cache expirado o no existe
  if (cached) {
    sorteoListCache.delete(cacheKey);
  }

  logger.debug({
    layer: 'cache',
    action: 'SORTEO_LIST_CACHE_MISS',
    payload: { cacheKey },
  });

  return null;
}

/**
 * Guarda un listado de sorteos en el cache
 */
export function setCachedSorteoList(
  params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    search?: string;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: string;
  },
  data: any[],
  meta: any
): void {
  const cacheKey = generateCacheKey(params);
  sorteoListCache.set(cacheKey, {
    data,
    meta,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  logger.debug({
    layer: 'cache',
    action: 'SORTEO_LIST_CACHE_SET',
    payload: { cacheKey },
  });
}

/**
 * Limpia el cache de sorteos
 * Útil cuando se crea/actualiza/evalúa un sorteo
 */
export function clearSorteoCache(pattern?: string) {
  if (pattern) {
    // Limpiar entradas que coincidan con el patrón
    const keysToDelete: string[] = [];
    for (const key of sorteoListCache.keys()) {
      if (key.includes(pattern)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => sorteoListCache.delete(key));
    logger.info({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEARED_PATTERN',
      payload: { pattern, cleared: keysToDelete.length },
    });
  } else {
    // Limpiar todo el cache
    const size = sorteoListCache.size;
    sorteoListCache.clear();
    logger.info({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEARED_ALL',
      payload: { cleared: size },
    });
  }
}

/**
 * Limpia entradas expiradas del cache (cleanup periódico)
 */
export function cleanupExpiredSorteoCache() {
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (const [key, cached] of sorteoListCache.entries()) {
    if (cached.expiresAt <= now) {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach((key) => sorteoListCache.delete(key));

  if (keysToDelete.length > 0) {
    logger.debug({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEANUP',
      payload: { cleaned: keysToDelete.length },
    });
  }
}

/**
 * Obtiene estadísticas del cache (útil para debugging)
 */
export function getSorteoCacheStats() {
  const now = Date.now();
  let valid = 0;
  let expired = 0;

  for (const cached of sorteoListCache.values()) {
    if (cached.expiresAt > now) {
      valid++;
    } else {
      expired++;
    }
  }

  return {
    total: sorteoListCache.size,
    valid,
    expired,
  };
}

// Limpiar cache expirado cada 5 minutos
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpiredSorteoCache, 5 * 60 * 1000);
}

