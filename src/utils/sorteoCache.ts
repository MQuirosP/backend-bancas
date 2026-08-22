// src/utils/sorteoCache.ts
import logger from '../core/logger';
import { getRedisClient, isRedisAvailable } from '../core/redisClient';

export interface SorteoCacheParams {
  loteriaId?: string;
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
  isActive?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  groupBy?: string;
  role?: string;
  ventanaId?: string | null;
  bancaId?: string;
  userId?: string;
}

export interface CachedSorteoPayload<T = unknown> {
  data: T[];
  meta: unknown;
}

const SORTEO_CACHE_TTL_SECONDS = 30; // 30 segundos

/**
 * Genera una clave de cache en Redis basada en los parámetros de filtro
 */
export function generateSorteoCacheKey(params: SorteoCacheParams): string {
  const parts = [
    params.role || 'PUBLIC',
    params.bancaId || 'GLOBAL_BANCA',
    params.ventanaId || 'GLOBAL_VENTANA',
    params.userId || 'GLOBAL_USER',
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
  return `sorteos:list:${parts.join(':')}`;
}

/**
 * Obtiene un listado de sorteos desde Redis (Cache-Aside)
 * Retorna null si no existe, si expiró o si Redis no está disponible
 */
export async function getCachedSorteoList<T = unknown>(
  params: SorteoCacheParams
): Promise<CachedSorteoPayload<T> | null> {
  if (!isRedisAvailable()) {
    return null;
  }

  const cacheKey = generateSorteoCacheKey(params);

  try {
    const redis = getRedisClient();
    if (!redis) return null;

    const cached = await redis.get(cacheKey);
    if (!cached) {
      return null;
    }

    const parsed = JSON.parse(cached) as CachedSorteoPayload<T>;
    return parsed;
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_CACHE_GET_FALLBACK',
      payload: {
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
        fallback: 'Retornando null — el sistema consultará DB directamente',
      },
    });
    return null;
  }
}

/**
 * Guarda un listado de sorteos en Redis con TTL explícito
 */
export async function setCachedSorteoList<T = unknown>(
  params: SorteoCacheParams,
  data: T[],
  meta: unknown,
  ttlSeconds: number = SORTEO_CACHE_TTL_SECONDS
): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }

  const cacheKey = generateSorteoCacheKey(params);

  try {
    const redis = getRedisClient();
    if (!redis) return;

    const payload: CachedSorteoPayload<T> = { data, meta };
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_CACHE_SET_ERROR',
      payload: {
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Limpia claves de caché de sorteos en Redis
 * Permite limpiar por patrón (ej. sorteoId o bancaId) o todo el espacio de nombres 'sorteos:*'
 */
export async function clearSorteoCache(pattern?: string): Promise<void> {
  if (!isRedisAvailable()) {
    return;
  }

  try {
    const redis = getRedisClient();
    if (!redis) return;

    const searchPattern = pattern ? `*sorteos*${pattern}*` : '*sorteos*';
    const allKeys: string[] = [];
    let cursor = '0';

    do {
      const [newCursor, keys] = await redis.scan(cursor, 'MATCH', searchPattern, 'COUNT', 100);
      cursor = newCursor;
      allKeys.push(...keys);
    } while (cursor !== '0');

    if (allKeys.length > 0) {
      const prefix = (redis as any).options?.keyPrefix || '';
      const cleanKeys = allKeys.map((k) =>
        prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k
      );

      const BATCH_SIZE = 100;
      for (let i = 0; i < cleanKeys.length; i += BATCH_SIZE) {
        const batch = cleanKeys.slice(i, i + BATCH_SIZE);
        await redis.del(...batch);
      }

      logger.info({
        layer: 'cache',
        action: pattern ? 'SORTEO_CACHE_CLEARED_PATTERN' : 'SORTEO_CACHE_CLEARED_ALL',
        payload: {
          pattern: searchPattern,
          cleared: cleanKeys.length,
        },
      });
    }
  } catch (error) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_CACHE_CLEAR_ERROR',
      payload: {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Obtiene el estado del caché de sorteos en Redis
 */
export function getSorteoCacheStats(): {
  isRedisAvailable: boolean;
  ttlSeconds: number;
} {
  return {
    isRedisAvailable: isRedisAvailable(),
    ttlSeconds: SORTEO_CACHE_TTL_SECONDS,
  };
}

/**
 * Stubs no-op para mantener retrocompatibilidad sin timers en memoria
 */
export function startSorteoCacheCleanup(): void {
  // No-op: Redis gestiona la expiración mediante TTL sin consumir CPU en el Event Loop
}

export function stopSorteoCacheCleanup(): void {
  // No-op: No hay timers activos que detener
}
