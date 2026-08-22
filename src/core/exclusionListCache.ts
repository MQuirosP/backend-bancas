import prisma from './prismaClient';
import logger from './logger';
import { getRedisClient, isRedisAvailable } from './redisClient';

const EXCLUSION_IS_EMPTY_KEY = 'exclusions:is_empty';
const EXCLUSION_IS_EMPTY_TTL_SECONDS = 5 * 60; // 5 minutos (300s)

/**
 * Devuelve true si sorteo_lista_exclusion está vacía (0 filas).
 * El resultado se cachea en Redis durante 5 minutos.
 * En caso de error o indisponibilidad de Redis, consulta DB o asume que NO está vacía (fail-safe).
 *
 * Uso: if (await isExclusionListEmpty()) { ... omitir filtro ... }
 */
export async function isExclusionListEmpty(): Promise<boolean> {
  // 1. Intentar leer desde Redis si está disponible
  if (isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      if (redis) {
        const cached = await redis.get(EXCLUSION_IS_EMPTY_KEY);
        if (cached !== null) {
          return cached === '1';
        }
      }
    } catch (redisError) {
      logger.warn({
        layer: 'core',
        action: 'EXCLUSION_LIST_CACHE_REDIS_GET_ERROR',
        requestId: null,
        meta: {
          error:
            redisError instanceof Error
              ? redisError.message
              : String(redisError),
        },
      });
    }
  }

  // 2. Cache miss o fallo de Redis: consultar DB
  try {
    const count = await prisma.sorteoListaExclusion.count();
    const isEmpty = count === 0;

    // Guardar en Redis de forma asíncrona y segura
    if (isRedisAvailable()) {
      try {
        const redis = getRedisClient();
        if (redis) {
          await redis.set(
            EXCLUSION_IS_EMPTY_KEY,
            isEmpty ? '1' : '0',
            'EX',
            EXCLUSION_IS_EMPTY_TTL_SECONDS
          );
        }
      } catch (setError) {
        logger.warn({
          layer: 'core',
          action: 'EXCLUSION_LIST_CACHE_REDIS_SET_ERROR',
          requestId: null,
          meta: {
            error:
              setError instanceof Error ? setError.message : String(setError),
          },
        });
      }
    }

    return isEmpty;
  } catch (dbError) {
    logger.warn({
      layer: 'core',
      action: 'EXCLUSION_LIST_CACHE_ERROR',
      requestId: null,
      meta: {
        error:
          dbError instanceof Error ? dbError.message : String(dbError),
      },
    });
    return false; // fail-safe: asumir NO vacío para no omitir exclusiones reales
  }
}

/**
 * Invalida el cache inmediatamente en Redis.
 * Llamar cuando se crea o elimina un registro en sorteo_lista_exclusion.
 */
export function invalidateExclusionListCache(): void {
  if (isRedisAvailable()) {
    try {
      const redis = getRedisClient();
      if (redis) {
        redis.del(EXCLUSION_IS_EMPTY_KEY).catch((delError) => {
          logger.warn({
            layer: 'core',
            action: 'EXCLUSION_LIST_CACHE_INVALIDATE_ERROR',
            payload: {
              error:
                delError instanceof Error
                  ? delError.message
                  : String(delError),
            },
          });
        });
      }
    } catch (error) {
      logger.warn({
        layer: 'core',
        action: 'EXCLUSION_LIST_CACHE_INVALIDATE_ERROR',
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
