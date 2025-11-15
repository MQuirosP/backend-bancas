// src/utils/commissionCache.ts
import { CommissionPolicy } from '../services/commission.resolver';
import logger from '../core/logger';

/**
 * Cache de políticas de comisión parseadas
 * TTL: 5 minutos
 */
interface CachedPolicy {
  policy: CommissionPolicy | null;
  expiresAt: number;
}

const commissionPolicyCache = new Map<string, CachedPolicy>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

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
    return cached.policy;
  }

  // Parsear política (usar función del resolver)
  const { parseCommissionPolicy } = require('../services/commission.resolver');
  const policy = parseCommissionPolicy(policyJson, entityType);

  // Cachear resultado
  commissionPolicyCache.set(cacheKey, {
    policy,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return policy;
}

/**
 * Limpia el cache (útil para testing o cuando se actualizan políticas)
 */
export function clearCommissionCache(entityType?: 'USER' | 'VENTANA' | 'BANCA', entityId?: string) {
  if (entityType && entityId) {
    const cacheKey = `${entityType}:${entityId}`;
    commissionPolicyCache.delete(cacheKey);
  } else {
    commissionPolicyCache.clear();
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
  };
}

