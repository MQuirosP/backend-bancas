// src/utils/commissionCache.ts
import { CommissionPolicy } from '../services/commission/types/CommissionTypes';
import { parseCommissionPolicy } from '../services/commission/utils/PolicyParser';
import logger from '../core/logger';

/**
 * Cache de políticas de comisión parseadas con límite de tamaño (LRU)
 * TTL: 5 minutos
 * MAX SIZE: 1000 entradas (suficiente para ~100 ventanas + ~500 vendedores + bancas)
 */
interface CachedPolicy {
  policy: CommissionPolicy | null;
  expiresAt: number;
  lastAccessed: number; // Para LRU eviction
}

const commissionPolicyCache = new Map<string, CachedPolicy>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const MAX_CACHE_SIZE = 1000; // Máximo 1000 entradas
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Evict LRU entries cuando el cache excede el límite
 */
function evictLRUIfNeeded(): void {
  if (commissionPolicyCache.size < MAX_CACHE_SIZE) {
    return;
  }

  // Encontrar la entrada menos recientemente usada
  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, cached] of commissionPolicyCache.entries()) {
    if (cached.lastAccessed < oldestTime) {
      oldestTime = cached.lastAccessed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    commissionPolicyCache.delete(oldestKey);
    logger.debug({
      layer: 'cache',
      action: 'COMMISSION_CACHE_LRU_EVICT',
      payload: {
        evictedKey: oldestKey,
        cacheSize: commissionPolicyCache.size,
        lastAccessed: new Date(oldestTime).toISOString()
      },
    });
  }
}

/**
 * Limpia entradas expiradas del cache
 */
function cleanupExpiredPolicies(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];

  for (const [key, cached] of commissionPolicyCache.entries()) {
    if (cached.expiresAt <= now) {
      keysToDelete.push(key);
    }
  }

  keysToDelete.forEach((key) => commissionPolicyCache.delete(key));

  if (keysToDelete.length > 0) {
    logger.debug({
      layer: 'cache',
      action: 'COMMISSION_CACHE_CLEANUP',
      payload: {
        cleaned: keysToDelete.length,
        remaining: commissionPolicyCache.size,
        maxSize: MAX_CACHE_SIZE
      },
    });
  }
}

/**
 * Obtiene una política de comisión desde el cache o la parsea y cachea
 */
export function getCachedCommissionPolicy(
  entityType: 'USER' | 'VENTANA' | 'BANCA',
  entityId: string,
  policyJson: any
): CommissionPolicy | null {
  const cacheKey = `${entityType}:${entityId}`;
  const cached = commissionPolicyCache.get(cacheKey);

  // Si hay cache válido, retornarlo
  if (cached && cached.expiresAt > Date.now()) {
    // Actualizar lastAccessed para LRU
    cached.lastAccessed = Date.now();
    return cached.policy;
  }

  // Cache expirado o no existe - eliminar si existe
  if (cached) {
    commissionPolicyCache.delete(cacheKey);
  }

  // Evict LRU si es necesario antes de agregar nueva entrada
  evictLRUIfNeeded();

  // Parsear política usando el nuevo parser
  const policy = parseCommissionPolicy(policyJson, entityType);

  const now = Date.now();

  // Cachear resultado
  commissionPolicyCache.set(cacheKey, {
    policy,
    expiresAt: now + CACHE_TTL_MS,
    lastAccessed: now,
  });

  // Log de advertencia si nos acercamos al límite
  if (commissionPolicyCache.size > MAX_CACHE_SIZE * 0.9) {
    logger.warn({
      layer: 'cache',
      action: 'COMMISSION_CACHE_NEAR_LIMIT',
      payload: {
        size: commissionPolicyCache.size,
        maxSize: MAX_CACHE_SIZE,
        utilizationPercent: Math.round((commissionPolicyCache.size / MAX_CACHE_SIZE) * 100)
      },
    });
  }

  return policy;
}

/**
 * Limpia el cache (útil para testing o cuando se actualizan políticas)
 */
export function clearCommissionCache(entityType?: 'USER' | 'VENTANA' | 'BANCA', entityId?: string) {
  if (entityType && entityId) {
    const cacheKey = `${entityType}:${entityId}`;
    const deleted = commissionPolicyCache.delete(cacheKey);

    if (deleted) {
      logger.info({
        layer: 'cache',
        action: 'COMMISSION_CACHE_CLEARED_SINGLE',
        payload: { entityType, entityId },
      });
    }
  } else {
    const size = commissionPolicyCache.size;
    commissionPolicyCache.clear();

    logger.info({
      layer: 'cache',
      action: 'COMMISSION_CACHE_CLEARED_ALL',
      payload: { cleared: size },
    });
  }
}

/**
 * Obtiene estadísticas del cache (útil para debugging)
 */
export function getCommissionCacheStats() {
  const now = Date.now();
  let valid = 0;
  let expired = 0;

  for (const cached of commissionPolicyCache.values()) {
    if (cached.expiresAt > now) {
      valid++;
    } else {
      expired++;
    }
  }

  return {
    total: commissionPolicyCache.size,
    valid,
    expired,
    maxSize: MAX_CACHE_SIZE,
    utilizationPercent: Math.round((commissionPolicyCache.size / MAX_CACHE_SIZE) * 100),
  };
}

/**
 * Inicia el proceso de cleanup periódico
 * Debe llamarse explícitamente (por ejemplo, en server startup)
 */
export function startCommissionCacheCleanup(): void {
  if (cleanupInterval) {
    logger.warn({
      layer: 'cache',
      action: 'COMMISSION_CACHE_CLEANUP_ALREADY_RUNNING',
      payload: { message: 'Cleanup interval already running' },
    });
    return;
  }

  // Cleanup cada 1 minuto (más frecuente que sorteo cache por TTL más corto)
  cleanupInterval = setInterval(cleanupExpiredPolicies, 60 * 1000);

  logger.info({
    layer: 'cache',
    action: 'COMMISSION_CACHE_CLEANUP_STARTED',
    payload: {
      intervalSeconds: 60,
      maxCacheSize: MAX_CACHE_SIZE,
      ttlSeconds: CACHE_TTL_MS / 1000
    },
  });
}

/**
 * Detiene el proceso de cleanup periódico
 * Debe llamarse en graceful shutdown
 */
export function stopCommissionCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;

    logger.info({
      layer: 'cache',
      action: 'COMMISSION_CACHE_CLEANUP_STOPPED',
    });
  }
}
