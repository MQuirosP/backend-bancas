/**
 * Constantes canónicas para la coordinación y ejecución de warmup de sorteos evaluados.
 * Fuente única de verdad (Single Source of Truth) para WarmupCoordinator y SorteoService.
 */

/**
 * Tamaño de bloque para el post-procesamiento en memoria de vendedores (acumulados/ordenamiento).
 * En entornos con CPU compartida (0.5 vCPU), un valor de 6 a 8 previene picos de Event Loop lag.
 */
export const WARMUP_CHUNK_SIZE = Number(process.env.WARMUP_CHUNK_SIZE) || 8;

/**
 * Tamaño de bloque con el que el orquestador despacha entradas a CacheService.setBatch.
 * 20 entradas equivalen a ~10 vendedores (summaryOnly: true + false).
 */
export const WARMUP_CACHE_DISPATCH_SIZE = Number(process.env.WARMUP_CACHE_DISPATCH_SIZE) || 20;

/**
 * Ventana mínima de cooldown (ms) entre warmups consecutivos de la misma banca.
 */
export const WARMUP_COOLDOWN_MS = Number(process.env.WARMUP_COOLDOWN_MS) || 1000;

/**
 * TTL del distributed lock en Redis para evitar ejecuciones concurrentes del mismo sorteo.
 */
export const WARMUP_LOCK_TTL_MS = Number(process.env.WARMUP_LOCK_TTL_MS) || 45000;
