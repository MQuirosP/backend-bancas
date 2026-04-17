import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import logger from '../core/logger';
import crypto from 'crypto';
import prisma from '../core/prismaClient';

export interface IdempotencyResponse {
  payloadHash: string;
  data: any;
}

/**
 * Resultado expandido de start():
 *  - ACQUIRED    : Redis ok, lock adquirido. Proceder y luego llamar commit().
 *  - HIT         : Petición duplicada (desde Redis). Retornar cachedData.
 *  - CONFLICT    : Mismo key, payload distinto → 409.
 *  - LOCKED      : Otra instancia procesa → 429.
 *  - DB_HIT      : Duplicado confirmado desde DB (Redis caído). Retornar cachedData.
 *  - DB_CONFLICT : Mismo key en DB, payload distinto → 409.
 *  - DB_FALLBACK : Redis caído + llave nueva en DB → proceder sin lock Redis.
 *  - ERROR       : Fallo irrecuperable (ya no produce 503).
 */
export type IdempotencyStatus =
  | 'ACQUIRED'
  | 'HIT'
  | 'CONFLICT'
  | 'LOCKED'
  | 'DB_HIT'
  | 'DB_CONFLICT'
  | 'DB_FALLBACK'
  | 'ERROR';

export class IdempotencyService {
  private static LOCK_TTL     = 60000; // 60s en ms (PX en Lua)
  private static RESPONSE_TTL = 86400; // 24h en s

  static generateHash(payload: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  // ────────────────────────────────────────────────────────────────────────
  // Script Lua atómico: consolida GET + SET NX + GET en 1 round-trip Redis.
  // ────────────────────────────────────────────────────────────────────────
  private static readonly START_LUA = `
    local resKey    = KEYS[1]
    local lockKey   = KEYS[2]
    local ownerId   = ARGV[1]
    local lockPxTtl = ARGV[2]

    -- 1. ¿Ya hay respuesta cacheada?
    local cached = redis.call('GET', resKey)
    if cached then
      return {'CACHED', cached}
    end

    -- 2. Intentar adquirir el lock (NX = solo si no existe)
    local acquired = redis.call('SET', lockKey, ownerId, 'PX', lockPxTtl, 'NX')
    if acquired then
      return {'ACQUIRED'}
    end

    -- 3. Segunda oportunidad: otra instancia puede haber completado justo antes
    local secondChance = redis.call('GET', resKey)
    if secondChance then
      return {'CACHED', secondChance}
    end

    return {'LOCKED'}
  `;

  // ────────────────────────────────────────────────────────────────────────
  // Fallback DB: cuando Redis está saturado, la DB es la fuente de verdad.
  // Busca el ticket por idempotencyKey y determina el estado real.
  // ────────────────────────────────────────────────────────────────────────
  private static async startFromDb(key: string, currentHash: string): Promise<{
    status: IdempotencyStatus;
    ownerId: string;
    cachedData?: any;
  }> {
    try {
      const existing = await prisma.ticket.findFirst({
        where: { idempotencyKey: key, deletedAt: null },
        select: {
          id: true,
          idempotencyKey: true,
          jugadas: true,
          status: true,
          totalAmount: true,
          createdAt: true,
        },
      });

      if (!existing) {
        // Llave nueva → proceder sin lock Redis
        logger.warn({
          layer: 'idempotency',
          action: 'DB_FALLBACK_NEW_KEY',
          payload: { key, message: 'Redis no disponible. Llave nueva en DB → procesando.' },
        });
        return { status: 'DB_FALLBACK', ownerId: '' };
      }

      // Llave existente → verificar hash del payload si el campo existe en el schema.
      // NOTA: idempotencyPayloadHash no existe aún en el schema de Ticket.
      // Por ahora, cualquier ticket existente con esa key se trata como HIT seguro.
      // Para habilitar detección de CONFLICT via DB, agregar el campo al schema y migrar.
      const storedHash: string | null = (existing as any).idempotencyPayloadHash ?? null;

      if (storedHash && storedHash !== currentHash) {
        logger.warn({
          layer: 'idempotency',
          action: 'DB_FALLBACK_CONFLICT',
          payload: { key, storedHash, currentHash },
        });
        return { status: 'DB_CONFLICT', ownerId: '' };
      }

      // Hash coincide (o no hay hash guardado) → HIT desde DB
      logger.info({
        layer: 'idempotency',
        action: 'DB_FALLBACK_HIT',
        payload: { key, ticketId: existing.id },
      });
      return { status: 'DB_HIT', ownerId: '', cachedData: existing };

    } catch (dbErr: any) {
      logger.error({
        layer: 'idempotency',
        action: 'DB_FALLBACK_ERROR',
        payload: { key, error: dbErr.message },
      });
      // Si la DB también falla: soft-fail total, dejar pasar
      return { status: 'DB_FALLBACK', ownerId: '' };
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // start(): intenta Redis primero; si falla, cae a DB.
  // Nunca retorna ERROR que produzca un 503.
  // ────────────────────────────────────────────────────────────────────────
  static async start(key: string, currentHash: string): Promise<{
    status: IdempotencyStatus;
    ownerId: string;
    cachedData?: any;
  }> {
    const redis = getRedisClient();

    // ── Camino Redis ──────────────────────────────────────────────────────
    if (isRedisAvailable() && redis) {
      const lockKey = `idemp:lock:${key}`;
      const resKey  = `idemp:res:${key}`;
      const ownerId = crypto.randomUUID();

      try {
        const result = await redis.eval(
          this.START_LUA,
          2,
          resKey,
          lockKey,
          ownerId,
          String(this.LOCK_TTL),
        ) as string[];

        const outcome = result[0];

        if (outcome === 'ACQUIRED') return { status: 'ACQUIRED', ownerId };

        if (outcome === 'CACHED') {
          const parsed = JSON.parse(result[1]) as IdempotencyResponse;
          if (parsed.payloadHash !== currentHash) return { status: 'CONFLICT', ownerId };
          return { status: 'HIT', ownerId, cachedData: parsed.data };
        }

        // outcome === 'LOCKED'
        return { status: 'LOCKED', ownerId };

      } catch (redisErr: any) {
        // Redis respondió con error (quota, timeout, ECONNRESET, etc.) → fallback DB
        logger.warn({
          layer: 'idempotency',
          action: 'REDIS_ERROR_FALLING_BACK_TO_DB',
          payload: {
            key,
            error: redisErr.message,
            fallback: 'Consultando DB para resolver idempotencia',
          },
        });
        // Cae al bloque de fallback DB debajo
      }
    } else {
      logger.warn({
        layer: 'idempotency',
        action: 'REDIS_UNAVAILABLE_FALLING_BACK_TO_DB',
        payload: { key, fallback: 'Redis no disponible → consultando DB' },
      });
    }

    // ── Camino DB (fallback cuando Redis falla) ───────────────────────────
    return this.startFromDb(key, currentHash);
  }

  // ────────────────────────────────────────────────────────────────────────
  // commit(): persiste la respuesta en Redis (best-effort).
  // Si Redis no está disponible, el unique constraint de DB garantiza idempotencia.
  // ────────────────────────────────────────────────────────────────────────
  static async commit(key: string, ownerId: string, data: any, payloadHash: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return; // Sin Redis → DB unique constraint es la garantía

    const lockKey = `idemp:lock:${key}`;
    const resKey  = `idemp:res:${key}`;
    const value   = JSON.stringify({ payloadHash, data });

    const luaScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        redis.call("SETEX", KEYS[2], ARGV[2], ARGV[3])
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    try {
      const result = await redis.eval(luaScript, 2, lockKey, resKey, ownerId, this.RESPONSE_TTL, value);
      if (result === 0) {
        logger.warn({
          layer: 'idempotency',
          action: 'COMMIT_SKIPPED_NOT_OWNER',
          payload: { key, ownerId, responseSize: value.length },
        });
      }
    } catch (err: any) {
      // Best-effort: ticket ya persistido en DB → consistencia garantizada
      logger.warn({
        layer: 'idempotency',
        action: 'COMMIT_REDIS_ERROR',
        payload: { key, error: err.message, note: 'DB ya tiene el registro.' },
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // rollback(): libera el lock en Redis. Si no hay ownerId, no hay lock Redis.
  // ────────────────────────────────────────────────────────────────────────
  static async rollback(key: string, ownerId: string): Promise<void> {
    if (!ownerId) return; // DB_FALLBACK / DB_HIT → no hay lock Redis que liberar

    const redis = getRedisClient();
    if (!redis) return;

    const lockKey = `idemp:lock:${key}`;
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    try {
      await redis.eval(luaScript, 1, lockKey, ownerId);
    } catch (err: any) {
      logger.warn({
        layer: 'idempotency',
        action: 'ROLLBACK_REDIS_ERROR',
        payload: { key, error: err.message },
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // autoRepair(): recupera respuesta para ticket con P2002 en idempotencyKey.
  // ────────────────────────────────────────────────────────────────────────
  static async autoRepair(key: string, payloadHash: string, fetcher: () => Promise<any>): Promise<any> {
    // Si Redis no está disponible, ir directamente a la DB
    if (!isRedisAvailable()) return await fetcher();

    const redis = getRedisClient();
    if (!redis) return await fetcher();

    const resKey = `idemp:res:${key}`;

    try {
      // Doble chequeo en Redis primero para evitar thundering herd
      const fastCheck = await redis.get(resKey);
      if (fastCheck) {
        const parsed = JSON.parse(fastCheck) as IdempotencyResponse;
        if (parsed.payloadHash === payloadHash) return parsed.data;
      }
    } catch {
      // Si Redis falla en autoRepair, caer a fetcher(DB)
    }

    const data = await fetcher();
    if (data) {
      try {
        const value = JSON.stringify({ payloadHash, data });
        await redis.setex(resKey, this.RESPONSE_TTL, value);
      } catch {
        // best-effort write-back
      }
    }
    return data;
  }
}
