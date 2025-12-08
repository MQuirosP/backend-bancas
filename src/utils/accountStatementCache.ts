import { CacheService } from '../core/cache.service';
import logger from '../core/logger';

/**
 * ✅ OPTIMIZACIÓN: Caché de estados de cuenta
 * 
 * TTL configurables por variable de entorno:
 * - CACHE_TTL_ACCOUNT_STATEMENT (default: 300s = 5 min)
 * - CACHE_TTL_ACCOUNT_DAY_STATEMENT (default: 180s = 3 min)
 * 
 * Si Redis no está disponible, las funciones retornan null y el sistema
 * funciona normalmente consultando la base de datos.
 */

const STATEMENT_TTL = parseInt(process.env.CACHE_TTL_ACCOUNT_STATEMENT || '300'); // 5 min
const DAY_STATEMENT_TTL = parseInt(process.env.CACHE_TTL_ACCOUNT_DAY_STATEMENT || '180'); // 3 min

/**
 * Generar clave de caché para estado de cuenta (mes/período)
 */
function getStatementCacheKey(params: {
    month?: string;
    date?: string;
    fromDate?: string;
    toDate?: string;
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
    userRole?: string;
    sort?: string;
}): string {
    const parts = [
        'account:statement',
        params.month || 'null',
        params.date || 'null',
        params.fromDate || 'null',
        params.toDate || 'null',
        params.dimension,
        params.ventanaId || 'null',
        params.vendedorId || 'null',
        params.bancaId || 'null',
        params.userRole || 'ADMIN',
        params.sort || 'desc',
    ];
    return parts.join(':');
}

/**
 * Generar clave de caché para estado de cuenta de un día específico
 */
function getDayStatementCacheKey(params: {
    date: string; // YYYY-MM-DD
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
    userRole?: string;
}): string {
    const parts = [
        'account:day',
        params.date,
        params.dimension,
        params.ventanaId || 'null',
        params.vendedorId || 'null',
        params.bancaId || 'null',
        params.userRole || 'ADMIN',
    ];
    return parts.join(':');
}

/**
 * Generar patrón de claves para invalidar cachés de un día específico
 * Nota: Redis keys() con patrones puede ser lento en producción, pero es necesario para invalidación precisa
 */
function getDayStatementCachePattern(params: {
    date: string; // YYYY-MM-DD
    ventanaId?: string | null;
    vendedorId?: string | null;
}): string {
    // Patrón para estado de cuenta del día específico
    return `account:day:${params.date}:*`;
}

/**
 * Obtener estado de cuenta del caché
 * @returns Estado de cuenta cacheado o null si no existe/Redis no disponible
 */
export async function getCachedStatement<T>(params: {
    month?: string;
    date?: string;
    fromDate?: string;
    toDate?: string;
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
    userRole?: string;
    sort?: string;
}): Promise<T | null> {
    const key = getStatementCacheKey(params);
    return await CacheService.get<T>(key);
}

/**
 * Guardar estado de cuenta en caché
 */
export async function setCachedStatement<T>(
    params: {
        month?: string;
        date?: string;
        fromDate?: string;
        toDate?: string;
        dimension: string;
        ventanaId?: string | null;
        vendedorId?: string | null;
        bancaId?: string | null;
        userRole?: string;
        sort?: string;
    },
    value: T
): Promise<void> {
    const key = getStatementCacheKey(params);
    await CacheService.set(key, value, STATEMENT_TTL);
}

/**
 * Obtener estado de cuenta de un día del caché
 * @returns Estado de cuenta del día cacheado o null si no existe/Redis no disponible
 */
export async function getCachedDayStatement<T>(params: {
    date: string; // YYYY-MM-DD
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
    userRole?: string;
}): Promise<T | null> {
    const key = getDayStatementCacheKey(params);
    return await CacheService.get<T>(key);
}

/**
 * Guardar estado de cuenta de un día en caché
 */
export async function setCachedDayStatement<T>(
    params: {
        date: string; // YYYY-MM-DD
        dimension: string;
        ventanaId?: string | null;
        vendedorId?: string | null;
        bancaId?: string | null;
        userRole?: string;
    },
    value: T
): Promise<void> {
    const key = getDayStatementCacheKey(params);
    await CacheService.set(key, value, DAY_STATEMENT_TTL);
}

/**
 * Invalidar cachés de estados de cuenta para un día específico
 * Se llama cuando se registra o revierte un pago/cobro
 */
export async function invalidateAccountStatementCache(params: {
    date: string; // YYYY-MM-DD
    ventanaId?: string | null;
    vendedorId?: string | null;
}): Promise<void> {
    try {
        // Invalidar estado del día específico (account:day:YYYY-MM-DD:*)
        const dayPattern = `account:day:${params.date}:*`;
        await CacheService.delPattern(dayPattern);

        // Invalidar períodos que incluyan este día (account:statement:*)
        // Como es difícil saber qué períodos incluyen esta fecha, invalidamos todos los statements
        // Esto es seguro porque los statements tienen TTL corto (5 min)
        const statementPattern = `account:statement:*`;
        await CacheService.delPattern(statementPattern);

        logger.info({
            layer: 'cache',
            action: 'INVALIDATE_ACCOUNT_STATEMENT',
            payload: { date: params.date, ventanaId: params.ventanaId, vendedorId: params.vendedorId }
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_ERROR',
            payload: { error: (error as Error).message }
        });
    }
}

/**
 * Invalidar todos los cachés de estados de cuenta
 * Útil para limpieza completa o cuando hay cambios masivos
 */
export async function invalidateAllAccountStatementCache(): Promise<void> {
    try {
        await CacheService.delPattern('account:*');
        logger.info({
            layer: 'cache',
            action: 'INVALIDATE_ALL_ACCOUNT_STATEMENTS'
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_ALL_ERROR',
            payload: { error: (error as Error).message }
        });
    }
}

