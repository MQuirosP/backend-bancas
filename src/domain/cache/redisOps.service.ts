import prisma from '../../core/prismaClient';
import { getRedisClient, isRedisAvailable, initRedisClient } from '../../core/redisClient';
import { CacheService } from '../../core/cache.service';
import logger from '../../core/logger';
import { Role } from '../../generated/prisma/client';
import { AppError } from '../../core/errors';

export interface RedisKeyItem {
  key: string;            // Clave sin prefijo (ej: "auth:session:uuid")
  rawKey: string;         // Clave tal como está en Redis con prefijo (ej: "prod:auth:session:uuid")
  type: string;           // string, hash, set, zset, etc.
  ttl: number;            // Segundos restantes (-1 = sin expiración, -2 = no existe)
  category: RedisKeyCategory;
  description: string;
}

export type RedisKeyCategory =
  | 'SESION'
  | 'CREDITO'
  | 'RESUMEN'
  | 'COMISION'
  | 'CUTOFF'
  | 'RESTRICCION'
  | 'MULTIPLICADOR'
  | 'ESTADO_CUENTA'
  | 'FLAG_SORTEO'
  | 'TAG'
  | 'OTRO';

export function categorizeRedisKey(key: string): { category: RedisKeyCategory; description: string } {
  if (key.startsWith('auth:session:')) {
    return { category: 'SESION', description: 'Sesión activa JWT y estado de autenticación' };
  }
  if (key.includes(':credit:') || key.startsWith('vendedor:') && key.includes(':credit')) {
    if (key.endsWith(':cfg')) return { category: 'CREDITO', description: 'Configuración de tope de crédito' };
    if (key.endsWith(':base')) return { category: 'CREDITO', description: 'Saldo base acumulado de caja' };
    if (key.endsWith(':open_by_sorteo')) return { category: 'CREDITO', description: 'Ventas en sorteos abiertos' };
    if (key.endsWith(':lock')) return { category: 'CREDITO', description: 'Lock de hidratación de crédito' };
    return { category: 'CREDITO', description: 'Datos de límite de crédito y caja' };
  }
  if (key.includes(':summary:') || key.startsWith('banca:') && key.includes(':vendedor:') || key.startsWith('dashboard:')) {
    return { category: 'RESUMEN', description: 'Resumen de ventas y comisiones (evaluatedSummary / dashboard)' };
  }
  if (key.includes('comm_policy') || key.includes('commissions:policy')) {
    return { category: 'COMISION', description: 'Política de comisiones del vendedor' };
  }
  if (key.startsWith('cutoff:') || key.includes(':cutoff:')) {
    return { category: 'CUTOFF', description: 'Hora de corte y cierre de ventas' };
  }
  if (key.startsWith('restrictions:') || key.includes('restrictions')) {
    return { category: 'RESTRICCION', description: 'Topes de números y reglas de restricción' };
  }
  if (key.startsWith('multiplier:')) {
    return { category: 'MULTIPLICADOR', description: 'Multiplicadores resueltos para el vendedor' };
  }
  if (key.startsWith('account:')) {
    return { category: 'ESTADO_CUENTA', description: 'Caché de estados de cuenta y balances' };
  }
  if (key.includes('sales_flags:')) {
    return { category: 'FLAG_SORTEO', description: 'Contadores y flags de tickets de sorteos abiertos' };
  }
  if (key.startsWith('tag:')) {
    return { category: 'TAG', description: 'Set de claves dependientes para invalidación reactiva' };
  }
  return { category: 'OTRO', description: 'Clave general vinculada al vendedor' };
}

export class RedisOpsService {
  /**
   * Garantiza que el cliente Redis esté conectado y disponible
   */
  private static async getReadyClient() {
    let redis = getRedisClient();
    if (!isRedisAvailable() || !redis) {
      await initRedisClient();
      redis = getRedisClient();
    }
    if (!redis) {
      throw new AppError('El servicio de Redis no está disponible o no está configurado.', 503, 'REDIS_UNAVAILABLE');
    }
    return redis;
  }

  /**
   * Lista todas las bancas activas
   */
  static async listBancas(): Promise<Array<{ id: string; name: string }>> {
    return await prisma.banca.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Lista vendedores pertenecientes a una banca (o global si bancaId es null)
   */
  static async listVendors(query?: string, bancaId?: string | null): Promise<any[]> {
    const where: any = {
      role: Role.VENDEDOR,
      deletedAt: null,
    };

    if (bancaId) {
      where.OR = [
        { bancaId },
        { ventana: { bancaId } },
      ];
    }

    if (query && query.trim()) {
      const q = query.trim();
      const textConditions = [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { code: { contains: q, mode: 'insensitive' } },
      ];

      if (where.OR) {
        where.AND = [
          { OR: where.OR },
          { OR: textConditions },
        ];
        delete where.OR;
      } else {
        where.OR = textConditions;
      }
    }

    const vendors = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        username: true,
        code: true,
        isActive: true,
        role: true,
        bancaId: true,
        ventanaId: true,
        ventana: {
          select: {
            id: true,
            name: true,
            bancaId: true,
            banca: { select: { id: true, name: true } },
          },
        },
        banca: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return vendors.map((v) => ({
      id: v.id,
      name: v.name,
      username: v.username,
      code: v.code,
      isActive: v.isActive,
      bancaId: v.ventana?.bancaId || v.bancaId,
      bancaName: v.ventana?.banca?.name || v.banca?.name || 'Sin Banca',
      ventanaId: v.ventanaId,
      ventanaName: v.ventana?.name || 'Sin Ventana',
    }));
  }

  /**
   * Escanea y recopila todas las claves existentes en Redis asociadas a un vendedor
   */
  static async listVendorKeys(vendedorId: string): Promise<{
    vendor: { id: string; name: string; username: string; code: string | null; bancaName: string; ventanaName: string };
    totalKeys: number;
    keys: RedisKeyItem[];
  }> {
    const vendor = await prisma.user.findUnique({
      where: { id: vendedorId },
      select: {
        id: true,
        name: true,
        username: true,
        code: true,
        bancaId: true,
        ventanaId: true,
        ventana: {
          select: {
            name: true,
            banca: { select: { name: true } },
          },
        },
        banca: { select: { name: true } },
      },
    });

    if (!vendor) {
      throw new AppError('Vendedor no encontrado', 404, 'VENDOR_NOT_FOUND');
    }

    const redis = await this.getReadyClient();
    const keyPrefix = (redis as any).options?.keyPrefix || '';

    // Patrones de búsqueda específicos y globales para este vendedor
    const patterns = [
      `*${vendor.id}*`,
    ];
    if (vendor.username && vendor.username !== vendor.id) {
      patterns.push(`*${vendor.username}*`);
    }

    const rawFoundKeys = new Set<string>();

    for (const pattern of patterns) {
      let cursor = '0';
      do {
        // En ioredis, SCAN con MATCH devuelve las claves con o sin prefijo según configuración
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;
        for (const k of keys) {
          rawFoundKeys.add(k);
        }
      } while (cursor !== '0');
    }

    // Normalizar claves (remover el prefijo si ioredis lo incluyó)
    const cleanKeyMap = new Map<string, string>(); // cleanKey -> rawKey
    for (const rawKey of Array.from(rawFoundKeys)) {
      let cleanKey = rawKey;
      if (keyPrefix && rawKey.startsWith(keyPrefix)) {
        cleanKey = rawKey.slice(keyPrefix.length);
      }
      cleanKeyMap.set(cleanKey, rawKey);
    }

    const cleanKeys = Array.from(cleanKeyMap.keys());
    const items: RedisKeyItem[] = [];

    if (cleanKeys.length > 0) {
      // Pipeline para obtener tipo y TTL de todas las claves en 1 solo round-trip
      const pipeline = redis.pipeline();
      for (const k of cleanKeys) {
        pipeline.type(k);
        pipeline.ttl(k);
      }
      const results = await pipeline.exec();

      if (results) {
        for (let i = 0; i < cleanKeys.length; i++) {
          const cleanKey = cleanKeys[i];
          const rawKey = cleanKeyMap.get(cleanKey) || cleanKey;
          const typeErr = results[i * 2]?.[0];
          const typeVal = results[i * 2]?.[1] as string || 'unknown';
          const ttlErr = results[i * 2 + 1]?.[0];
          const ttlVal = typeof results[i * 2 + 1]?.[1] === 'number' ? results[i * 2 + 1][1] as number : -1;

          if (!typeErr && typeVal !== 'none') {
            const { category, description } = categorizeRedisKey(cleanKey);
            items.push({
              key: cleanKey,
              rawKey,
              type: typeVal,
              ttl: ttlVal,
              category,
              description,
            });
          }
        }
      }
    }

    // Ordenar por categoría y luego por clave
    items.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.key.localeCompare(b.key);
    });

    return {
      vendor: {
        id: vendor.id,
        name: vendor.name,
        username: vendor.username,
        code: vendor.code,
        bancaName: vendor.ventana?.banca?.name || vendor.banca?.name || 'Sin Banca',
        ventanaName: vendor.ventana?.name || 'Sin Ventana',
      },
      totalKeys: items.length,
      keys: items,
    };
  }

  /**
   * Elimina una lista de claves de Redis y limpia la memoria local L1
   */
  static async deleteKeys(keys: string[], vendedorId?: string): Promise<{
    deletedCount: number;
    deletedKeys: string[];
  }> {
    if (!keys || keys.length === 0) {
      return { deletedCount: 0, deletedKeys: [] };
    }

    const redis = await this.getReadyClient();
    const keyPrefix = (redis as any).options?.keyPrefix || '';

    // Normalizar claves asegurando no duplicar prefijos
    const cleanKeys = keys.map((k) => (keyPrefix && k.startsWith(keyPrefix) ? k.slice(keyPrefix.length) : k));

    // Borrado no bloqueante con UNLINK en lotes
    const BATCH_SIZE = 100;
    let totalUnlinked = 0;

    for (let i = 0; i < cleanKeys.length; i += BATCH_SIZE) {
      const batch = cleanKeys.slice(i, i + BATCH_SIZE);
      const unlinked = await redis.unlink(...batch);
      totalUnlinked += unlinked;

      // Notificar al bus Pub/Sub de invalidación de caché L1
      for (const k of batch) {
        await CacheService.del(k).catch(() => {});
      }
    }

    // Si se pasó vendedorId, purgar la entrada L1 del usuario
    if (vendedorId) {
      await CacheService.del(`auth:session:${vendedorId}`).catch(() => {});
      await CacheService.invalidateTag(`user:${vendedorId}`).catch(() => {});
    }

    logger.info({
      layer: 'ops',
      action: 'REDIS_KEYS_DELETED_MANUAL',
      payload: {
        vendedorId,
        keysCount: cleanKeys.length,
        unlinkedCount: totalUnlinked,
        sampleKeys: cleanKeys.slice(0, 5),
      },
    });

    return {
      deletedCount: totalUnlinked,
      deletedKeys: cleanKeys,
    };
  }

  /**
   * Purga todas las claves de un vendedor en Redis
   */
  static async deleteAllVendorKeys(vendedorId: string): Promise<{
    deletedCount: number;
    deletedKeys: string[];
  }> {
    const { keys } = await this.listVendorKeys(vendedorId);
    const keyNames = keys.map((k) => k.key);
    return await this.deleteKeys(keyNames, vendedorId);
  }
}
