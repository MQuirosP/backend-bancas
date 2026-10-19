// src/utils/restrictionCompiledCache.ts
import { CacheService } from '../core/cache.service';
import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import { ResilienceService } from '../core/resilience.service';
import logger from '../core/logger';
import { SingleFlight } from './concurrency';

/**
 * Cache de reglas de restricción "compiladas" por (banca, ventana, vendedor).
 *
 * Arquitectura de Alto Rendimiento y Resiliencia:
 * - Redis L2 como fuente distribuida + Micro-caché L1 en RAM (15s) para absorber ráfagas
 *   sin generar latencia de red ni saturar libuv en contenedores de 0.5 vCPU.
 * - SingleFlight Coalescing: Múltiples peticiones concurrentes para la misma versión o
 *   lista de reglas comparten una única promesa en vuelo (Zero Thundering Herd).
 * - Invalidación por VERSIÓN: la clave incluye la versión global y la de banca.
 *   Mutar una regla => INCR de la versión en Redis e invalidación inmediata de L1 local.
 */

const COMPILED_TTL_SECONDS = 600;
const L1_CACHE_TTL_MS = 15_000; // 15 segundos en RAM local
const VERSION_TAG_L1_TTL_MS = 3_000; // 3 segundos en RAM para la etiqueta de versión
export const RESTRICTIONS_GLOBAL_VERSION_KEY = 'restrictions:compiled:version:global';
export const restrictionsBancaVersionKey = (bancaId: string) => `banca:${bancaId}:restrictions_version`;

// Micro-caché L1 en memoria para tags de versión (reduce 99% round-trips a Redis)
interface VersionTagEntry {
  tag: string;
  expiresAt: number;
}
const versionTagL1Cache = new Map<string, VersionTagEntry>();
// Última versión válida conocida por clave (fallback de emergencia si Redis tiene lag transitorio)
const lastKnownVersionTags = new Map<string, string>();

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
 * Lee las versiones (global + banca) con micro-caché L1 (3s) y SingleFlight.
 * Retorna fallback defensivo si Redis tiene timeout transitorio para no forzar
 * un bypass destructivo a PostgreSQL.
 */
export async function readVersionTag(bancaId?: string | null): Promise<string | null> {
  const cacheKey = bancaId || 'global';
  const now = Date.now();

  // 1. Revisar L1 micro-cache
  const cached = versionTagL1Cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.tag;
  }

  // 2. Coalescing mediante SingleFlight
  return SingleFlight.do(`ver:${cacheKey}`, async () => {
    // Doble verificación dentro del coalescing
    const doubleCheck = versionTagL1Cache.get(cacheKey);
    if (doubleCheck && doubleCheck.expiresAt > Date.now()) {
      return doubleCheck.tag;
    }

    if (!isRedisAvailable()) {
      return lastKnownVersionTags.get(cacheKey) ?? null;
    }

    const fetchTagFromRedis = async (): Promise<string | null> => {
      const redis = getRedisClient();
      if (!redis) return null;
      if (bancaId && bancaId !== 'global') {
        const mgetFn = typeof redis.mget === 'function' ? redis.mget.bind(redis) : null;
        if (mgetFn) {
          const [g, b] = await mgetFn(RESTRICTIONS_GLOBAL_VERSION_KEY, restrictionsBancaVersionKey(bancaId));
          return `${g ?? '0'}.${b ?? '0'}`;
        }
        const g = await redis.get(RESTRICTIONS_GLOBAL_VERSION_KEY);
        return `${g ?? '0'}`;
      } else {
        const g = await redis.get(RESTRICTIONS_GLOBAL_VERSION_KEY);
        return `${g ?? '0'}`;
      }
    };

    try {
      let tag: string | null = null;
      try {
        tag = await ResilienceService.runRedis<string | null>(
          `rcc:ver:${cacheKey}`,
          fetchTagFromRedis,
          0 // sin memoización oculta de opossum
        );
      } catch (cbErr: any) {
        // En tests o entornos donde ResilienceService no fue inicializado con init(), ejecutar fetch directo
        if (cbErr?.message?.includes('ResilienceService must be initialized')) {
          tag = await fetchTagFromRedis();
        } else {
          throw cbErr;
        }
      }

      if (tag !== null) {
        versionTagL1Cache.set(cacheKey, { tag, expiresAt: Date.now() + VERSION_TAG_L1_TTL_MS });
        lastKnownVersionTags.set(cacheKey, tag);
        return tag;
      }

      // Si Redis retornó null sin error, usar fallback de última conocida
      return lastKnownVersionTags.get(cacheKey) ?? null;
    } catch {
      // Si Redis lanzó excepción o timeout del breaker (150ms), usar última versión conocida
      // para evitar que la petición salte en masa a PostgreSQL.
      const fallback = lastKnownVersionTags.get(cacheKey);
      if (fallback) {
        logger.debug({
          layer: 'cache',
          action: 'RESTRICTIONS_VERSION_FALLBACK_USED',
          payload: { bancaId: bancaId ?? null, fallbackTag: fallback },
        });
        return fallback;
      }
      return null;
    }
  });
}

export function buildCompiledKey(ctx: VendorRulesContext, versionTag: string): string {
  return `restrictions:compiled:${ctx.bancaId}:v${versionTag}:${ctx.ventanaId || 'null'}:${ctx.vendorId}`;
}

/**
 * Cache para listados de reglas (ej. GET /restrictions con filtros estándar de prefetch).
 * Clave versionada por banca o global => O(1) de invalidación.
 * Protegido con L1 RAM (15s) y SingleFlight Coalescing que engloba toda la resolución.
 */
export async function getOrSetRestrictionsListCache<T>(
  bancaId: string | null | undefined,
  cacheKeySuffix: string,
  fetchFn: () => Promise<T>,
  ttlSeconds = 300
): Promise<T> {
  const flightKey = `list:${bancaId || 'global'}:${cacheKeySuffix}`;

  // Coalescing: Si varias peticiones concurrentes piden la misma lista, una sola resuelve el tag y ejecuta fetchFn
  return SingleFlight.do(flightKey, async () => {
    const versionTag = await readVersionTag(bancaId);
    if (versionTag === null) return fetchFn();

    const key = `restrictions:list:${bancaId || 'global'}:v${versionTag}:${cacheKeySuffix}`;

    // 1. Intentar obtener de caché con L1 RAM habilitado (15s)
    const cached = await CacheService.get<T>(key, true, L1_CACHE_TTL_MS);
    if (cached) return cached;

    const result = await fetchFn();
    await CacheService.set(key, result, ttlSeconds, [], true, L1_CACHE_TTL_MS).catch(() => {});
    return result;
  });
}

/**
 * Cache-aside sobre Redis L2 y L1 RAM (15s) con Coalescing completo.
 * Ante cualquier fallo de Redis cae directo al compilador (PostgreSQL).
 */
export async function getOrCompileVendorRules(
  ctx: VendorRulesContext,
  compile: () => Promise<CompiledVendorRules>
): Promise<CompiledVendorRules> {
  const flightKey = `compile:${ctx.bancaId}:${ctx.ventanaId || 'null'}:${ctx.vendorId}`;

  // Coalescing completo para no compilar concurrentemente para el mismo vendedor
  return SingleFlight.do(flightKey, async () => {
    const versionTag = await readVersionTag(ctx.bancaId);
    if (versionTag === null) return compile();

    const key = buildCompiledKey(ctx, versionTag);

    // 1. Intentar obtener de L1 RAM / Redis L2
    const cached = await CacheService.get<CompiledVendorRules>(key, true, L1_CACHE_TTL_MS);
    if (cached) return reviveCompiled(cached);

    const compiled = await compile();
    await CacheService.set(key, compiled, COMPILED_TTL_SECONDS, [], true, L1_CACHE_TTL_MS).catch(() => {});
    return compiled;
  });
}

/**
 * Invalida las reglas compiladas incrementando la versión (O(1), no bloqueante).
 * Limpia inmediatamente el micro-cache L1 local de versiones.
 * - Sin bancaId: versión global (reglas globales/ventana/usuario con bancaId nulo).
 * - Con bancaId: solo esa banca.
 */
export async function bumpRestrictionsVersion(bancaId?: string | null): Promise<void> {
  const cacheKey = bancaId || 'global';
  versionTagL1Cache.delete(cacheKey);

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

