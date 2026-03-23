import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import logger from '../core/logger';
import crypto from 'crypto';

export interface IdempotencyResponse {
  payloadHash: string;
  data: any;
}

export class IdempotencyService {
  private static LOCK_TTL = 60000; // 60 segundos
  private static RESPONSE_TTL = 86400; // 24 horas

  static generateHash(payload: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  static async start(key: string, currentHash: string): Promise<{ 
    status: 'ACQUIRED' | 'HIT' | 'CONFLICT' | 'LOCKED' | 'ERROR'; 
    ownerId: string; 
    cachedData?: any 
  }> {
    const redis = getRedisClient();
    if (!isRedisAvailable() || !redis) return { status: 'ERROR', ownerId: '' };

    const lockKey = `idemp:lock:${key}`;
    const resKey = `idemp:res:${key}`;
    const ownerId = crypto.randomUUID();

    const cached = await redis.get(resKey);
    if (cached) {
      const parsed = JSON.parse(cached) as IdempotencyResponse;
      if (parsed.payloadHash !== currentHash) return { status: 'CONFLICT', ownerId };
      return { status: 'HIT', ownerId, cachedData: parsed.data };
    }

    const acquired = await redis.set(lockKey, ownerId, 'PX', this.LOCK_TTL, 'NX');
    if (acquired === 'OK') return { status: 'ACQUIRED', ownerId };

    const secondChance = await redis.get(resKey);
    if (secondChance) {
      const parsed = JSON.parse(secondChance) as IdempotencyResponse;
      if (parsed.payloadHash !== currentHash) return { status: 'CONFLICT', ownerId };
      return { status: 'HIT', ownerId, cachedData: parsed.data };
    }

    return { status: 'LOCKED', ownerId };
  }

  /**
   * FIX 1: Script LUA corregido -> Valida ownership ANTES de escribir en cache
   */
  static async commit(key: string, ownerId: string, data: any, payloadHash: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const lockKey = `idemp:lock:${key}`;
    const resKey = `idemp:res:${key}`;
    const value = JSON.stringify({ payloadHash, data });

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
          payload: {
            key,
            ownerId,
            responseSize: value.length,
            lockTTL: this.LOCK_TTL
          }
        });
      }
    } catch (err: any) {
      logger.error({ layer: 'idempotency', action: 'COMMIT_FAILED', payload: { key, error: err.message } });
    }
  }

  static async rollback(key: string, ownerId: string): Promise<void> {
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
      logger.error({ layer: 'idempotency', action: 'ROLLBACK_FAILED', payload: { key, error: err.message } });
    }
  }

  /**
   * FIX 3: Optimización de Auto-Repair -> Verifica cache ANTES de ir a DB
   */
  static async autoRepair(key: string, payloadHash: string, fetcher: () => Promise<any>): Promise<any> {
    if (!isRedisAvailable()) return await fetcher();
    
    const redis = getRedisClient();
    if (!redis) return await fetcher();

    const resKey = `idemp:res:${key}`;
    
    // 1. Doble chequeo en Redis para evitar thundering herd en SELECTs de DB
    const fastCheck = await redis.get(resKey);
    if (fastCheck) {
      const parsed = JSON.parse(fastCheck) as IdempotencyResponse;
      
      // FIX 1: Validar hash antes de devolver cache
      if (parsed.payloadHash === payloadHash) {
        return parsed.data;
      }
    }

    // 2. Solo si no está en Redis, vamos a la DB
    const data = await fetcher();
    if (data) {
      const value = JSON.stringify({ payloadHash, data });
      await redis.setex(resKey, this.RESPONSE_TTL, value);
    }
    return data;
  }
}
