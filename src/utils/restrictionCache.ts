import { CacheService, L1_TTL_RESTRICTIONS_MS, L1_TTL_CUTOFF_MS } from '../core/cache.service';
import logger from '../core/logger';

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
    // useL1: true + 60s TTL para cutoffs (más estables que restricciones de número)
    const result = await CacheService.get<{ minutes: number; source: "USER" | "VENTANA" | "BANCA" | "DEFAULT" }>(key, true, L1_TTL_CUTOFF_MS);
    if (!result) {
        logger.warn({
            layer: 'restrictionCache',
            action: 'REDIS_FALLBACK_TRIGGERED',
            payload: {
                key,
                reason: 'Cache miss o Redis no disponible en getCachedCutoff()',
                fallback: 'Sistema consultará DB para resolver cutoff',
            },
        });
    }
    return result;
}

/**
 * Guardar cutoff en caché
 */
export async function setCachedCutoff(
    params: { bancaId: string; ventanaId?: string | null; userId?: string | null },
    value: { minutes: number; source: "USER" | "VENTANA" | "BANCA" | "DEFAULT" }
): Promise<void> {
    const key = getCutoffCacheKey(params);
    // useL1: true + 60s TTL para cutoffs
    await CacheService.set(key, value, CUTOFF_TTL, [], true, L1_TTL_CUTOFF_MS);
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
    // useL1: true + 30s TTL para restricciones de vendedor (bloqueos de números deben propagarse rápido)
    const result = await CacheService.get<any>(key, true, L1_TTL_RESTRICTIONS_MS);
    if (!result) {
        logger.warn({
            layer: 'restrictionCache',
            action: 'REDIS_FALLBACK_TRIGGERED',
            payload: {
                key,
                reason: 'Cache miss o Redis no disponible en getCachedRestrictions()',
                fallback: 'Sistema consultará DB para resolver restricciones',
            },
        });
    }
    return result;
}

/**
 * Guardar restricciones en caché
 */
export async function setCachedRestrictions(
    params: { bancaId: string; ventanaId?: string | null; userId?: string | null; number?: string | null },
    value: any
): Promise<void> {
    const key = getRestrictionsCacheKey(params);
    // useL1: true + 30s TTL para restricciones
    await CacheService.set(key, value, RESTRICTIONS_TTL, [], true, L1_TTL_RESTRICTIONS_MS);
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
