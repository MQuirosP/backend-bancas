import { CacheService } from '../core/cache.service';

export class ReportCache {
  /**
   * Obtiene un reporte desde Redis Render o lo calcula con protección Single-Flight (Anti-Stampede).
   * Integra automáticamente asociación con Tags para invalidación reactiva inmediata (ej: 'dashboard').
   * Si Redis falla o no está disponible, realiza fallback silencioso a la función de cálculo (PostgreSQL).
   * 
   * @param cacheKey Clave única de caché para el reporte
   * @param ttlSeconds Tiempo de vida en segundos para Redis (ej: 15s para live, 300s/3600s para histórico)
   * @param computeFn Función asíncrona de cálculo (consulta SQL/Prisma)
   * @param tags Conjunto de tags para invalidación proactiva (por defecto: ['dashboard'])
   */
  static async getOrCompute<T>(
    cacheKey: string,
    ttlSeconds: number,
    computeFn: () => Promise<T>,
    tags: string[] = ['dashboard']
  ): Promise<T> {
    return CacheService.wrap<T>(cacheKey, computeFn, ttlSeconds, tags, false);
  }
}
