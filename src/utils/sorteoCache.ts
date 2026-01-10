// src/utils/sorteoCache.ts
import logger from '../core/logger';

/**
 * Cache de listados de sorteos con límite de tamaño (LRU)
 * TTL: 30 segundos (sorteos cambian poco pero necesitamos datos relativamente frescos)
 * MAX SIZE: 500 entradas para evitar memory leaks
 */
interface CachedSorteoList {
  data: any[];
  meta: any;
  expiresAt: number;
  lastAccessed: number; // Para LRU eviction
}

const sorteoListCache = new Map<string, CachedSorteoList>();

const CACHE_TTL_MS = 30 * 1000; // 30 segundos
const MAX_CACHE_SIZE = 500; // Máximo 500 entradas
let cleanupInterval: NodeJS.Timeout | null = null;

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
 * Evict LRU entries cuando el cache excede el límite
 */
function evictLRUIfNeeded(): void {
  if (sorteoListCache.size < MAX_CACHE_SIZE) {
    return;
  }

  // Encontrar la entrada menos recientemente usada
  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, cached] of sorteoListCache.entries()) {
    if (cached.lastAccessed < oldestTime) {
      oldestTime = cached.lastAccessed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    sorteoListCache.delete(oldestKey);
    logger.debug({
      layer: 'cache',
      action: 'SORTEO_CACHE_LRU_EVICT',
      payload: {
        evictedKey: oldestKey,
        cacheSize: sorteoListCache.size,
        lastAccessed: new Date(oldestTime).toISOString()
      },
    });
  }
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
    // Actualizar lastAccessed para LRU
    cached.lastAccessed = Date.now();
    return { data: cached.data, meta: cached.meta };
  }

  // Cache expirado o no existe
  if (cached) {
    sorteoListCache.delete(cacheKey);
  }

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
  // Evict LRU si es necesario antes de agregar nueva entrada
  evictLRUIfNeeded();

  const cacheKey = generateCacheKey(params);
  const now = Date.now();

  sorteoListCache.set(cacheKey, {
    data,
    meta,
    expiresAt: now + CACHE_TTL_MS,
    lastAccessed: now,
  });

  // Log de advertencia si nos acercamos al límite
  if (sorteoListCache.size > MAX_CACHE_SIZE * 0.9) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_CACHE_NEAR_LIMIT',
      payload: {
        size: sorteoListCache.size,
        maxSize: MAX_CACHE_SIZE,
        utilizationPercent: Math.round((sorteoListCache.size / MAX_CACHE_SIZE) * 100)
      },
    });
  }
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
      payload: {
        cleaned: keysToDelete.length,
        remaining: sorteoListCache.size,
        maxSize: MAX_CACHE_SIZE
      },
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
    maxSize: MAX_CACHE_SIZE,
    utilizationPercent: Math.round((sorteoListCache.size / MAX_CACHE_SIZE) * 100),
  };
}

/**
 * Inicia el proceso de cleanup periódico
 * Debe llamarse explícitamente (por ejemplo, en server startup)
 */
export function startSorteoCacheCleanup(): void {
  if (cleanupInterval) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEANUP_ALREADY_RUNNING',
      payload: { message: 'Cleanup interval already running' },
    });
    return;
  }

  cleanupInterval = setInterval(cleanupExpiredSorteoCache, 5 * 60 * 1000);

  logger.info({
    layer: 'cache',
    action: 'SORTEO_CACHE_CLEANUP_STARTED',
    payload: {
      intervalMinutes: 5,
      maxCacheSize: MAX_CACHE_SIZE,
      ttlSeconds: CACHE_TTL_MS / 1000
    },
  });
}

/**
 * Detiene el proceso de cleanup periódico
 * Debe llamarse en graceful shutdown
 */
export function stopSorteoCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;

    logger.info({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEANUP_STOPPED',
    });
  }
}
