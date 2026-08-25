import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import logger from '../core/logger';

// Mapa de promesas en vuelo para Request Coalescing (Single-Flight Anti-Stampede)
const inFlightReports = new Map<string, Promise<any>>();

export class ReportCache {
  /**
   * Obtiene un reporte desde Upstash Redis o lo calcula con protección Single-Flight (Anti-Stampede).
   * Si Redis falla o no está disponible, realiza fallback silencioso a la función de cálculo (PostgreSQL).
   * 
   * @param cacheKey Clave única de caché para el reporte
   * @param ttlSeconds Tiempo de vida en segundos para Redis (ej: 10s para live, 24h para histórico)
   * @param computeFn Función asíncrona de cálculo (consulta SQL/Prisma)
   */
  static async getOrCompute<T>(
    cacheKey: string,
    ttlSeconds: number,
    computeFn: () => Promise<T>
  ): Promise<T> {
    // 1. Intentar lectura desde Redis si está disponible
    if (isRedisAvailable()) {
      const redis = getRedisClient();
      if (redis) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            return JSON.parse(cached) as T;
          }
        } catch (err: any) {
          logger.warn({
            layer: 'cache',
            action: 'REPORT_CACHE_GET_ERROR',
            payload: { cacheKey, error: err.message },
          });
        }
      }
    }

    // 2. Request Coalescing (Single-Flight): Si ya hay un cálculo en vuelo para esta misma clave, reutilizar la promesa existente
    const inFlight = inFlightReports.get(cacheKey);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    // 3. Ejecutar función de cálculo y guardar resultado en Redis
    const promise = (async () => {
      try {
        const result = await computeFn();

        if (isRedisAvailable()) {
          const redis = getRedisClient();
          if (redis) {
            try {
              await redis.set(cacheKey, JSON.stringify(result), 'EX', ttlSeconds);
            } catch (err: any) {
              logger.warn({
                layer: 'cache',
                action: 'REPORT_CACHE_SET_ERROR',
                payload: { cacheKey, error: err.message },
              });
            }
          }
        }

        return result;
      } finally {
        inFlightReports.delete(cacheKey);
      }
    })();

    inFlightReports.set(cacheKey, promise);
    return promise;
  }
}
