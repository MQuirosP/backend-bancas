import { CacheService } from '../core/cache.service';

/**
 *  OPTIMIZACIÓN: Caché de restricciones y cutoff
 * 
 * TTL configurables por variable de entorno:
 * - CACHE_TTL_CUTOFF (default: 300s = 5 min)
 * - CACHE_TTL_RESTRICTIONS (default: 300s = 5 min)
 * 
 * Si Redis no está disponible, las funciones retornan null y el sistema
 * funciona normalmente consultando la base de datos.
 */

const CUTOFF_TTL = parseInt(process.env.CACHE_TTL_CUTOFF || '300'); // 5 min
const RESTRICTIONS_TTL = parseInt(process.env.CACHE_TTL_RESTRICTIONS || '300'); // 5 min

/**
 * Generar clave de caché para cutoff
 */
function getCutoffCacheKey(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
}): string {
    return `cutoff:${params.bancaId}:${params.ventanaId || 'null'}:${params.userId || 'null'}`;
}

/**
 * Generar clave de caché para restricciones
 */
function getRestrictionsCacheKey(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    number?: string | null;
}): string {
    return `restrictions:${params.bancaId}:${params.ventanaId || 'null'}:${params.userId || 'null'}:${params.number || 'null'}`;
}

/**
 * Obtener cutoff del caché
 * @returns Cutoff cacheado o null si no existe/Redis no disponible
 */
export async function getCachedCutoff(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
}): Promise<{ minutes: number; source: "USER" | "VENTANA" | "BANCA" | "DEFAULT" } | null> {
    const key = getCutoffCacheKey(params);
    return await CacheService.get(key);
}

/**
 * Guardar cutoff en caché
 */
export async function setCachedCutoff(
    params: { bancaId: string; ventanaId?: string | null; userId?: string | null },
    value: { minutes: number; source: "USER" | "VENTANA" | "BANCA" | "DEFAULT" }
): Promise<void> {
    const key = getCutoffCacheKey(params);
    await CacheService.set(key, value, CUTOFF_TTL);
}

/**
 * Obtener restricciones del caché
 * @returns Restricciones cacheadas o null si no existen/Redis no disponible
 */
export async function getCachedRestrictions(params: {
    bancaId: string;
    ventanaId?: string | null;
    userId?: string | null;
    number?: string | null;
}): Promise<any | null> {
    const key = getRestrictionsCacheKey(params);
    return await CacheService.get(key);
}

/**
 * Guardar restricciones en caché
 */
export async function setCachedRestrictions(
    params: { bancaId: string; ventanaId?: string | null; userId?: string | null; number?: string | null },
    value: any
): Promise<void> {
    const key = getRestrictionsCacheKey(params);
    await CacheService.set(key, value, RESTRICTIONS_TTL);
}

/**
 * Invalidar cachés de restricciones para una banca/ventana/usuario
 * Se llama cuando se crea/actualiza/elimina una restricción
 */
export async function invalidateRestrictionCaches(params: {
    bancaId?: string;
    ventanaId?: string;
    userId?: string;
}): Promise<void> {
    const patterns: string[] = [];

    if (params.bancaId) {
        patterns.push(`cutoff:${params.bancaId}:*`);
        patterns.push(`restrictions:${params.bancaId}:*`);
    }
    if (params.ventanaId) {
        patterns.push(`cutoff:*:${params.ventanaId}:*`);
        patterns.push(`restrictions:*:${params.ventanaId}:*`);
    }
    if (params.userId) {
        patterns.push(`cutoff:*:*:${params.userId}`);
        patterns.push(`restrictions:*:*:${params.userId}:*`);
    }

    // Invalidar todos los patrones
    for (const pattern of patterns) {
        await CacheService.delPattern(pattern);
    }
}
