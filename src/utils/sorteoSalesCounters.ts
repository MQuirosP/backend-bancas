// src/utils/sorteoSalesCounters.ts
import { getRedisClient, isRedisAvailable } from '../core/redisClient';
import { ResilienceService } from '../core/resilience.service';
import logger from '../core/logger';
import { Role, Prisma } from '../generated/prisma/client';
import prisma from '../core/prismaClient';

/**
 * HASH `sorteos:open:sales_flags:{sorteoId}` (Redis L2):
 *   __ready        -> "1" cuando el hash fue hidratado desde PostgreSQL (misma vida útil que los contadores)
 *   v:{vendedorId} -> nº de tickets activos del vendedor
 *   w:{ventanaId}  -> nº de tickets activos de la ventana
 *   a              -> nº de tickets activos del sorteo
 * hasSales = contador > 0. Reemplaza las subconsultas correlacionadas EXISTS/COUNT sobre "Ticket".
 *
 * Los incrementos por venta pueden crear el hash antes de hidratarlo (Redis en frío): sin `__ready`
 * el hash se considera parcial y se reconstruye completo desde PostgreSQL (rehydrateSalesCounters).
 */
export const salesFlagsKey = (sorteoId: string) => `sorteos:open:sales_flags:${sorteoId}`;

export const SALES_READY_FIELD = '__ready';
export const SALES_FIELD_ALL = 'a';
export const salesFieldVendedor = (id: string) => `v:${id}`;
export const salesFieldVentana = (id: string) => `w:${id}`;

/** Campo del hash que corresponde al alcance RBAC del usuario (idéntico al filtro del SQL original). */
export function resolveSalesField(role?: Role | string, userId?: string, ventanaId?: string | null): string {
  if (role === Role.VENDEDOR && userId) return salesFieldVendedor(userId);
  if (role === Role.VENTANA && ventanaId) return salesFieldVentana(ventanaId);
  return SALES_FIELD_ALL;
}

/** Agrega a un pipeline ioredis el incremento/decremento de contadores de un ticket. */
export function appendSalesCounterOps(
  pipeline: any,
  p: { sorteoId: string; vendedorId?: string | null; ventanaId?: string | null; delta: number; ttlSeconds: number }
): void {
  const key = salesFlagsKey(p.sorteoId);
  pipeline.hincrby(key, SALES_FIELD_ALL, p.delta);
  if (p.vendedorId) pipeline.hincrby(key, salesFieldVendedor(p.vendedorId), p.delta);
  if (p.ventanaId) pipeline.hincrby(key, salesFieldVentana(p.ventanaId), p.delta);
  pipeline.expire(key, p.ttlSeconds);
}

type ReadResult = { values: number[]; cold: string[] };

/**
 * Lee los contadores de varios sorteos en un único pipeline.
 * Si algún sorteo no está hidratado (Redis en frío) lo rehidrata desde PostgreSQL primero.
 * Retorna null ante cualquier fallo de Redis => el llamador degrada a PostgreSQL.
 */
export async function getSorteoTicketCounts(
  sorteoIds: string[],
  field: string,
  rehydrate: (sorteoId: string) => Promise<void>
): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  if (sorteoIds.length === 0) return counts;
  if (!isRedisAvailable()) return null;

  const read = (): Promise<ReadResult | null> =>
    ResilienceService.runRedis<ReadResult | null>(
      `sales:counts:${field}:${sorteoIds.join(',')}`,
      async () => {
        const redis = getRedisClient();
        if (!redis) return null;
        const pipeline = redis.pipeline();
        for (const id of sorteoIds) pipeline.hmget(salesFlagsKey(id), SALES_READY_FIELD, field);
        const res = await pipeline.exec();
        if (!res) return null;
        const values: number[] = [];
        const cold: string[] = [];
        sorteoIds.forEach((id, i) => {
          const [err, row] = res[i] as [Error | null, Array<string | null>];
          if (err) throw err;
          if (!row[0]) cold.push(id);
          values.push(Math.max(0, parseInt(row[1] ?? '0', 10) || 0));
        });
        return { values, cold };
      },
      0 // sin memoización local (Zero-L1)
    );

  try {
    let result = await read();
    if (!result) return null;

    if (result.cold.length > 0) {
      await Promise.all(result.cold.map((id) => rehydrate(id)));
      result = await read();
      if (!result || result.cold.length > 0) return null; // no se pudo hidratar => DB
    }

    const final = result;
    sorteoIds.forEach((id, i) => counts.set(id, final.values[i]));
    return counts;
  } catch (err: any) {
    logger.warn({
      layer: 'cache',
      action: 'SORTEO_SALES_COUNTS_FALLBACK_TO_DB',
      payload: { error: err?.message },
    });
    return null;
  }
}

/**
 * Descarta los contadores de un sorteo (UNLINK exacto, no bloqueante).
 * La próxima lectura rehidrata desde PostgreSQL. Usar cuando cambia el estado de tickets
 * por fuera del flujo incremental (exclusión / inclusión de listas).
 */
export async function invalidateSorteoSalesCounts(sorteoId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.unlink(salesFlagsKey(sorteoId));
  } catch (err: any) {
    logger.warn({ layer: 'cache', action: 'SORTEO_SALES_COUNTS_INVALIDATE_ERROR', payload: { sorteoId, error: err?.message } });
  }
}

const inFlightRehydrations = new Map<string, Promise<void>>();

/**
 * Rehidrata el hash de contadores de tickets de un sorteo desde PostgreSQL.
 * Es invocado automáticamente en frío cuando un sorteo carece de la marca __ready
 * o de forma masiva desde rehydrateRedisAccumulated.
 * Incluye Coalescing/SingleFlight para evitar estampidas en lecturas frías concurrentes.
 */
export async function rehydrateSorteoSalesCounters(sorteoId: string, tx?: any): Promise<void> {
  const existing = inFlightRehydrations.get(sorteoId);
  if (existing) return existing;

  const promise = (async () => {
    if (!isRedisAvailable()) return;
    const redis = getRedisClient();
    if (!redis) return;

    try {
      const client = tx || prisma;
      const rows = (await client.$queryRaw(
        Prisma.sql`
          SELECT 
            COUNT(*)::int as count,
            "vendedorId",
            "ventanaId"
          FROM "Ticket"
          WHERE "sorteoId" = ${sorteoId}::uuid
            AND "status" NOT IN ('CANCELLED', 'EXCLUDED')
            AND "deletedAt" IS NULL
          GROUP BY "vendedorId", "ventanaId"
        `
      )) as Array<{ count: number; vendedorId: string | null; ventanaId: string | null }>;

      let totalTickets = 0;
      const vendorCounts = new Map<string, number>();
      const ventanaCounts = new Map<string, number>();

      for (const r of rows) {
        const c = Number(r.count) || 0;
        totalTickets += c;
        if (r.vendedorId) {
          vendorCounts.set(r.vendedorId, (vendorCounts.get(r.vendedorId) || 0) + c);
        }
        if (r.ventanaId) {
          ventanaCounts.set(r.ventanaId, (ventanaCounts.get(r.ventanaId) || 0) + c);
        }
      }

      const hashData: Record<string, string> = {
        [SALES_READY_FIELD]: '1',
        [SALES_FIELD_ALL]: String(totalTickets),
      };
      for (const [vId, count] of vendorCounts) {
        hashData[salesFieldVendedor(vId)] = String(count);
      }
      for (const [wId, count] of ventanaCounts) {
        hashData[salesFieldVentana(wId)] = String(count);
      }

      // TTL de 12 horas o hasta el momento del sorteo
      const sorteo = await client.sorteo.findUnique({
        where: { id: sorteoId },
        select: { scheduledAt: true },
      });
      let ttlSeconds = 43200;
      if (sorteo?.scheduledAt) {
        const msToDraw = new Date(sorteo.scheduledAt).getTime() - Date.now();
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const calculatedTtl = Math.ceil((msToDraw + twoHoursMs) / 1000);
        ttlSeconds = Math.max(7200, Math.min(calculatedTtl, 86400));
      }

      const key = salesFlagsKey(sorteoId);
      const pipeline = redis.pipeline();
      pipeline.unlink(key);
      pipeline.hset(key, hashData);
      pipeline.expire(key, ttlSeconds);
      await pipeline.exec();

      logger.debug({
        layer: 'cache',
        action: 'SORTEO_SALES_COUNTERS_HYDRATED',
        payload: { sorteoId, totalTickets, vendorsWithSales: vendorCounts.size },
      });
    } catch (err: any) {
      logger.warn({
        layer: 'cache',
        action: 'SORTEO_SALES_COUNTERS_HYDRATE_ERROR',
        payload: { sorteoId, error: err?.message },
      });
    }
  })().finally(() => {
    inFlightRehydrations.delete(sorteoId);
  });

  inFlightRehydrations.set(sorteoId, promise);
  return promise;
}

