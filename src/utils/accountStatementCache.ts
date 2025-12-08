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
    const result = await CacheService.get<T>(key);
    
    // ✅ CRÍTICO: Validar que el resultado tenga la estructura correcta
    if (!result || typeof result !== 'object') {
        return null;
    }
    
    // Validar que tenga statements como array y que tenga datos
    const resultAny = result as any;
    if (!resultAny.statements || !Array.isArray(resultAny.statements) || resultAny.statements.length === 0) {
        // Caché corrupto o vacío, invalidar y retornar null para recalcular
        await CacheService.del(key);
        return null;
    }
    
    // ✅ CRÍTICO: Normalizar objetos Date que vienen como strings del caché
    if (resultAny.statements && Array.isArray(resultAny.statements)) {
        resultAny.statements = resultAny.statements.map((stmt: any) => {
            if (stmt.date && typeof stmt.date === 'string') {
                stmt.date = new Date(stmt.date);
            }
            if (stmt.createdAt && typeof stmt.createdAt === 'string') {
                stmt.createdAt = new Date(stmt.createdAt);
            }
            if (stmt.updatedAt && typeof stmt.updatedAt === 'string') {
                stmt.updatedAt = new Date(stmt.updatedAt);
            }
            // Normalizar Date en movements si existen
            if (stmt.movements && Array.isArray(stmt.movements)) {
                stmt.movements = stmt.movements.map((mov: any) => {
                    if (mov.date && typeof mov.date === 'string') {
                        mov.date = new Date(mov.date);
                    }
                    if (mov.createdAt && typeof mov.createdAt === 'string') {
                        mov.createdAt = new Date(mov.createdAt);
                    }
                    if (mov.updatedAt && typeof mov.updatedAt === 'string') {
                        mov.updatedAt = new Date(mov.updatedAt);
                    }
                    return mov;
                });
            }
            return stmt;
        });
    }
    
    return result;
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
 * 
 * ✅ OPTIMIZACIÓN: Invalidación más específica para evitar borrar todo el caché
 * Solo invalida statements del mes y statements con períodos que incluyan esta fecha
 */
export async function invalidateAccountStatementCache(params: {
    date: string; // YYYY-MM-DD
    ventanaId?: string | null;
    vendedorId?: string | null;
}): Promise<void> {
    try {
        const month = params.date.substring(0, 7); // YYYY-MM
        const patterns: string[] = [];
        let totalKeysDeleted = 0;

        // 1. Invalidar estado del día específico (account:day:YYYY-MM-DD:*)
        const dayPattern = `account:day:${params.date}:*`;
        const dayKeys = await CacheService.delPattern(dayPattern);
        totalKeysDeleted += dayKeys?.length || 0;

        // 2. ✅ OPTIMIZACIÓN: Invalidar solo statements del mes que contiene esta fecha
        // Esto es más específico que invalidar todos los statements
        const monthPattern = `account:statement:${month}:*`;
        const monthKeys = await CacheService.delPattern(monthPattern);
        totalKeysDeleted += monthKeys?.length || 0;

        // 3. Invalidar statements con períodos (fromDate/toDate) que incluyan esta fecha
        // Los patrones deben coincidir con la estructura de la clave:
        // account:statement:month:date:fromDate:toDate:dimension:ventanaId:vendedorId:bancaId:userRole:sort
        // Solo invalidamos statements con períodos que incluyan esta fecha específica
        patterns.push(`account:statement:*:null:${params.date}:*`); // fromDate = fecha
        patterns.push(`account:statement:*:null:*:${params.date}:*`); // toDate = fecha

        // Si hay ventanaId o vendedorId específicos, invalidar solo esos (más específico)
        if (params.ventanaId) {
            patterns.push(`account:statement:*:*:*:*:*:${params.ventanaId}:*`);
        }
        if (params.vendedorId) {
            patterns.push(`account:statement:*:*:*:*:*:*:${params.vendedorId}:*`);
        }

        // Invalidar todos los patrones y contar claves eliminadas
        for (const pattern of patterns) {
            const deleted = await CacheService.delPattern(pattern);
            totalKeysDeleted += deleted?.length || 0;
        }

        logger.info({
            layer: 'cache',
            action: 'INVALIDATE_ACCOUNT_STATEMENT',
            payload: { 
                date: params.date, 
                month,
                ventanaId: params.ventanaId, 
                vendedorId: params.vendedorId,
                patternsInvalidated: [dayPattern, monthPattern, ...patterns],
                keysDeleted: totalKeysDeleted
            }
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_ERROR',
            payload: { 
                error: (error as Error).message, 
                stack: (error as Error).stack,
                date: params.date 
            }
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

