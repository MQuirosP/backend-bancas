// src/utils/restrictionCompiledCache.ts
import { CacheService } from '../core/cache.service';
import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import { ResilienceService } from '../core/resilience.service';
import logger from '../core/logger';

/**
 * Cache de reglas de restricción "compiladas" por (banca, ventana, vendedor).
 *
 * Reglas de arquitectura:
 * - SOLO Redis L2 (useL1 = false). Prohibida la RAM local para datos compartidos.
 * - Invalidación por VERSIÓN: la clave incluye la versión global y la de banca.
 *   Mutar una regla => INCR de la versión => las claves viejas quedan huérfanas y
 *   expiran por TTL. NO se usa DEL con comodines ni KEYS (comandos bloqueantes).
 */

const COMPILED_TTL_SECONDS = 600;
export const RESTRICTIONS_GLOBAL_VERSION_KEY = 'restrictions:compiled:version:global';
export const restrictionsBancaVersionKey = (bancaId: string) => `banca:${bancaId}:restrictions_version`;

const DATE_FIELDS = ['createdAt', 'updatedAt', 'appliesToDate', 'deletedAt'] as const;

export interface CompiledVendorRules {
  general: any[];
  vendorSpecific: any[];
}

export interface VendorRulesContext {
  bancaId: string;
  ventanaId: string | null;
  vendorId: string;
}

/** Restaura los campos Date que JSON.stringify convirtió en string. */
function reviveRule(rule: any): any {
  if (!rule || typeof rule !== 'object') return rule;
  const out = { ...rule };
  for (const f of DATE_FIELDS) {
    if (typeof out[f] === 'string') out[f] = new Date(out[f]);
  }
  return out;
}

export function reviveCompiled(value: CompiledVendorRules): CompiledVendorRules {
  return {
    general: (value.general || []).map(reviveRule),
    vendorSpecific: (value.vendorSpecific || []).map(reviveRule),
  };
}

/**
 * Lee las versiones (global + banca) en UN solo round-trip.
 * Retorna null si Redis no está disponible o excede el timeout del breaker.
 */
export async function readVersionTag(bancaId?: string | null): Promise<string | null> {
  if (!isRedisAvailable()) return null;
  try {
    return await ResilienceService.runRedis<string | null>(
      `rcc:ver:${bancaId || 'global'}`,
      async () => {
        const redis = getRedisClient();
        if (!redis) return null;
        if (bancaId && bancaId !== 'global') {
          const [g, b] = await redis.mget(RESTRICTIONS_GLOBAL_VERSION_KEY, restrictionsBancaVersionKey(bancaId));
          return `${g ?? '0'}.${b ?? '0'}`;
        } else {
          const g = await redis.get(RESTRICTIONS_GLOBAL_VERSION_KEY);
          return `${g ?? '0'}`;
        }
      },
      0 // sin memoización local
    );
  } catch {
    return null;
  }
}

export function buildCompiledKey(ctx: VendorRulesContext, versionTag: string): string {
  return `restrictions:compiled:${ctx.bancaId}:v${versionTag}:${ctx.ventanaId || 'null'}:${ctx.vendorId}`;
}

/**
 * Cache para listados de reglas (ej. GET /restrictions con filtros estándar de prefetch).
 * Clave versionada por banca o global => O(1) de invalidación.
 */
export async function getOrSetRestrictionsListCache<T>(
  bancaId: string | null | undefined,
  cacheKeySuffix: string,
  fetchFn: () => Promise<T>,
  ttlSeconds = 300
): Promise<T> {
  const versionTag = await readVersionTag(bancaId);
  if (versionTag === null) return fetchFn();

  const key = `restrictions:list:${bancaId || 'global'}:v${versionTag}:${cacheKeySuffix}`;
  const cached = await CacheService.get<T>(key, false);
  if (cached) return cached;

  const result = await fetchFn();
  await CacheService.set(key, result, ttlSeconds, [], false).catch(() => {});
  return result;
}

/**
 * Cache-aside sobre Redis L2. Ante cualquier fallo de Redis cae directo al compilador (PostgreSQL).
 */
export async function getOrCompileVendorRules(
  ctx: VendorRulesContext,
  compile: () => Promise<CompiledVendorRules>
): Promise<CompiledVendorRules> {
  const versionTag = await readVersionTag(ctx.bancaId);
  if (versionTag === null) return compile();

  const key = buildCompiledKey(ctx, versionTag);
  const cached = await CacheService.get<CompiledVendorRules>(key, false);
  if (cached) return reviveCompiled(cached);

  const compiled = await compile();
  await CacheService.set(key, compiled, COMPILED_TTL_SECONDS, [], false).catch(() => {});
  return compiled;
}

/**
 * Invalida las reglas compiladas incrementando la versión (O(1), no bloqueante).
 * - Sin bancaId: versión global (reglas globales/ventana/usuario con bancaId nulo).
 * - Con bancaId: solo esa banca.
 */
export async function bumpRestrictionsVersion(bancaId?: string | null): Promise<void> {
  if (!isRedisAvailable()) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.incr(bancaId ? restrictionsBancaVersionKey(bancaId) : RESTRICTIONS_GLOBAL_VERSION_KEY);
  } catch (err: any) {
    logger.warn({
      layer: 'cache',
      action: 'RESTRICTIONS_VERSION_BUMP_ERROR',
      payload: { bancaId: bancaId ?? null, error: err?.message },
    });
  }
}
