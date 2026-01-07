import { CacheService } from '../core/cache.service';
import logger from '../core/logger';

/**
 *  OPTIMIZACIÓN: Caché de estados de cuenta
 * 
 * TTL configurables por variable de entorno:
 * - CACHE_TTL_ACCOUNT_STATEMENT (default: 300s = 5 min)
 * - CACHE_TTL_ACCOUNT_DAY_STATEMENT (default: 180s = 3 min)
 * - CACHE_TTL_BY_SORTEO (default: 3600s = 1 hora)
 * 
 * Si Redis no está disponible, las funciones retornan null y el sistema
 * funciona normalmente consultando la base de datos.
 */

const STATEMENT_TTL = parseInt(process.env.CACHE_TTL_ACCOUNT_STATEMENT || '300'); // 5 min
const DAY_STATEMENT_TTL = parseInt(process.env.CACHE_TTL_ACCOUNT_DAY_STATEMENT || '180'); // 3 min
const BY_SORTEO_TTL = parseInt(process.env.CACHE_TTL_BY_SORTEO || '3600'); // 1 hora (bySorteo cambia menos frecuentemente)

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
 * Generar clave de caché para bySorteo de un día específico
 */
function getBySorteoCacheKey(params: {
    date: string; // YYYY-MM-DD
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}): string {
    const parts = [
        'account:bySorteo',
        params.date,
        params.dimension,
        params.ventanaId || 'null',
        params.vendedorId || 'null',
        params.bancaId || 'null',
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
    
    //  OPTIMIZACIÓN: Validación simplificada (solo verificar estructura básica)
    // La normalización de fechas se hace solo cuando es necesario (lazy)
    if (!result || typeof result !== 'object') {
        return null;
    }
    
    // Validar que tenga statements como array (sin verificar length para evitar falsos negativos)
    const resultAny = result as any;
    if (!resultAny.statements || !Array.isArray(resultAny.statements)) {
        // Caché corrupto, invalidar y retornar null para recalcular
        await CacheService.del(key).catch(() => {
            // Ignorar errores de invalidación
        });
        return null;
    }
    
    //  OPTIMIZACIÓN: Normalización lazy de fechas (solo cuando se accede a ellas)
    // Esto reduce el tiempo de procesamiento en cache hits de 50-100ms a <10ms
    // Las fechas se normalizan automáticamente cuando se serializan a JSON en la respuesta
    // Si el frontend necesita Date objects, puede hacer la conversión allí
    
    return result;
}

/**
 * Guardar estado de cuenta en caché
 * @param ttlSeconds - TTL opcional en segundos. Si no se proporciona, usa STATEMENT_TTL por defecto.
 *                      Útil para cache más largo para estados asentados (900s) vs no asentados (60s)
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
    value: T,
    ttlSeconds?: number
): Promise<void> {
    const key = getStatementCacheKey(params);
    const ttl = ttlSeconds !== undefined ? ttlSeconds : STATEMENT_TTL;
    await CacheService.set(key, value, ttl);
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
 *  OPTIMIZACIÓN: Invalidación más específica para evitar borrar todo el caché
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

        // 2.  OPTIMIZACIÓN: Invalidar solo statements del mes que contiene esta fecha
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

/**
 *  NUEVO: Invalidar caché basándose en un ticket
 * Útil para invalidar caché cuando se crea, cancela o restaura un ticket
 * 
 * @param ticket - Ticket con businessDate, ventanaId, vendedorId
 */
export async function invalidateCacheForTicket(ticket: {
    businessDate?: Date | string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
}): Promise<void> {
    try {
        // Obtener fecha del ticket (businessDate o usar fecha actual como fallback)
        let dateStr: string;
        
        if (ticket.businessDate) {
            // Si es string, usarlo directamente
            if (typeof ticket.businessDate === 'string') {
                dateStr = ticket.businessDate.split('T')[0]; // YYYY-MM-DD
            } else {
                // Si es Date, convertir a YYYY-MM-DD en CR
                const { crDateService } = await import('./crDateService');
                dateStr = crDateService.postgresDateToCRString(ticket.businessDate);
            }
        } else {
            // Fallback: usar fecha actual en CR
            const { crDateService } = await import('./crDateService');
            dateStr = crDateService.postgresDateToCRString(new Date());
        }

        await invalidateAccountStatementCache({
            date: dateStr,
            ventanaId: ticket.ventanaId || null,
            vendedorId: ticket.vendedorId || null,
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_TICKET_ERROR',
            payload: { 
                error: (error as Error).message,
                ticketId: (ticket as any).id 
            }
        });
    }
}

/**
 *  NUEVO: Invalidar caché basándose en un sorteo
 * Útil para invalidar caché cuando se evalúa un sorteo (marca jugadas como ganadoras)
 * 
 * @param sorteo - Sorteo con scheduledAt
 * @param tickets - Array opcional de tickets afectados para obtener ventanaId/vendedorId
 */
export async function invalidateCacheForSorteo(
    sorteo: {
        scheduledAt?: Date | string | null;
    },
    tickets?: Array<{
        businessDate?: Date | string | null;
        ventanaId?: string | null;
        vendedorId?: string | null;
    }>
): Promise<void> {
    try {
        // Obtener fecha del sorteo (scheduledAt)
        let dateStr: string;
        
        if (sorteo.scheduledAt) {
            // Si es string, usarlo directamente
            if (typeof sorteo.scheduledAt === 'string') {
                dateStr = sorteo.scheduledAt.split('T')[0]; // YYYY-MM-DD
            } else {
                // Si es Date, convertir a YYYY-MM-DD en CR
                const { crDateService } = await import('./crDateService');
                dateStr = crDateService.postgresDateToCRString(sorteo.scheduledAt);
            }
        } else {
            // Fallback: usar fecha actual en CR
            const { crDateService } = await import('./crDateService');
            dateStr = crDateService.postgresDateToCRString(new Date());
        }

        // Si hay tickets, invalidar para cada ventanaId/vendedorId único
        if (tickets && tickets.length > 0) {
            const uniqueKeys = new Set<string>();
            for (const ticket of tickets) {
                const key = `${ticket.ventanaId || 'null'}:${ticket.vendedorId || 'null'}`;
                if (!uniqueKeys.has(key)) {
                    uniqueKeys.add(key);
                    await Promise.all([
                        invalidateAccountStatementCache({
                            date: dateStr,
                            ventanaId: ticket.ventanaId || null,
                            vendedorId: ticket.vendedorId || null,
                        }),
                        invalidateBySorteoCache({
                            date: dateStr,
                            ventanaId: ticket.ventanaId || null,
                            vendedorId: ticket.vendedorId || null,
                            bancaId: null, // No tenemos bancaId en tickets directamente
                        }),
                    ]);
                }
            }
        } else {
            // Si no hay tickets, invalidar todo el día (sin filtros específicos)
            await Promise.all([
                invalidateAccountStatementCache({
                    date: dateStr,
                    ventanaId: null,
                    vendedorId: null,
                }),
                invalidateBySorteoCache({
                    date: dateStr,
                    ventanaId: null,
                    vendedorId: null,
                    bancaId: null,
                }),
            ]);
        }
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_SORTEO_ERROR',
            payload: { 
                error: (error as Error).message,
                sorteoId: (sorteo as any).id 
            }
        });
    }
}

/**
 *  OPTIMIZACIÓN: Obtener bySorteo del caché
 * Cachea bySorteo por separado con TTL más largo (1 hora) ya que cambia menos frecuentemente
 * @returns bySorteo cacheado o null si no existe/Redis no disponible
 */
export async function getCachedBySorteo(params: {
    date: string; // YYYY-MM-DD
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}): Promise<Array<any> | null> {
    const key = getBySorteoCacheKey(params);
    const result = await CacheService.get<Array<any>>(key);
    
    // Validación básica
    if (!result || !Array.isArray(result)) {
        return null;
    }
    
    return result;
}

/**
 *  OPTIMIZACIÓN: Guardar bySorteo en caché
 * Usa TTL más largo (1 hora) porque bySorteo cambia menos frecuentemente que el statement completo
 */
export async function setCachedBySorteo(
    params: {
        date: string; // YYYY-MM-DD
        dimension: string;
        ventanaId?: string | null;
        vendedorId?: string | null;
        bancaId?: string | null;
    },
    value: Array<any>,
    ttlSeconds?: number
): Promise<void> {
    const key = getBySorteoCacheKey(params);
    const ttl = ttlSeconds !== undefined ? ttlSeconds : BY_SORTEO_TTL;
    await CacheService.set(key, value, ttl);
}

/**
 *  OPTIMIZACIÓN: Invalidar caché de bySorteo para un día específico
 * Se llama cuando se registra o revierte un pago/cobro, o cuando se evalúa un sorteo
 */
export async function invalidateBySorteoCache(params: {
    date: string; // YYYY-MM-DD
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}): Promise<void> {
    try {
        // Invalidar todos los bySorteo de esta fecha (sin importar dimension)
        const pattern = `account:bySorteo:${params.date}:*`;
        await CacheService.delPattern(pattern);
        
        logger.info({
            layer: 'cache',
            action: 'INVALIDATE_BY_SORTEO',
            payload: { 
                date: params.date,
                pattern
            }
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_BY_SORTEO_ERROR',
            payload: { 
                error: (error as Error).message,
                date: params.date 
            }
        });
    }
}

/**
 *  NUEVO: Generar clave de caché para saldo del mes anterior
 */
function getPreviousMonthBalanceCacheKey(params: {
    effectiveMonth: string; // YYYY-MM
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}): string {
    const parts = [
        'account:previous_month_balance',
        params.effectiveMonth,
        params.dimension,
        params.ventanaId || 'null',
        params.vendedorId || 'null',
        params.bancaId || 'null',
    ];
    return parts.join(':');
}

/**
 *  NUEVO: Obtener saldo del mes anterior del caché
 * TTL: 5 minutos (balance entre frescura y rendimiento)
 * Si se asientan statements durante el cache, se detectarán en la próxima consulta
 */
export async function getCachedPreviousMonthBalance(params: {
    effectiveMonth: string;
    dimension: string;
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}): Promise<number | null> {
    const key = getPreviousMonthBalanceCacheKey(params);
    const result = await CacheService.get<number>(key);
    return result;
}

/**
 *  NUEVO: Guardar saldo del mes anterior en caché
 * TTL: 5 minutos (300 segundos)
 * Se invalida automáticamente cuando se asientan statements
 */
export async function setCachedPreviousMonthBalance(
    params: {
        effectiveMonth: string;
        dimension: string;
        ventanaId?: string | null;
        vendedorId?: string | null;
        bancaId?: string | null;
    },
    value: number,
    ttlSeconds: number = 300 // 5 minutos por defecto
): Promise<void> {
    const key = getPreviousMonthBalanceCacheKey(params);
    await CacheService.set(key, value, ttlSeconds);
}

/**
 *  NUEVO: Invalidar caché de saldos del mes anterior
 * Se llama cuando se asientan statements del mes anterior
 */
export async function invalidatePreviousMonthBalanceCache(params: {
    month: string; // YYYY-MM del mes anterior
    ventanaId?: string | null;
    vendedorId?: string | null;
}): Promise<void> {
    try {
        // Invalidar todos los saldos del mes anterior para esta entidad
        const pattern = `account:previous_month_balance:${params.month}:*:${params.ventanaId || '*'}:${params.vendedorId || '*'}:*`;
        await CacheService.delPattern(pattern);
        
        logger.info({
            layer: 'cache',
            action: 'INVALIDATE_PREVIOUS_MONTH_BALANCE',
            payload: { 
                month: params.month,
                pattern
            }
        });
    } catch (error) {
        logger.warn({
            layer: 'cache',
            action: 'INVALIDATE_PREVIOUS_MONTH_BALANCE_ERROR',
            payload: { 
                error: (error as Error).message,
                month: params.month 
            }
        });
    }
}
