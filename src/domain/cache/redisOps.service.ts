import prisma from '../../core/prismaClient';
import { getRedisClient, isRedisAvailable, initRedisClient } from '../../core/redisClient';
import { CacheService } from '../../core/cache.service';
import logger from '../../core/logger';
import { Role } from '../../generated/prisma/client';
import { AppError } from '../../core/errors';
import { config } from '../../config';

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
  private static directClient: any = null;

  /**
   * Garantiza un cliente Redis conectado con timeout generoso para CLI y Render
   */
  private static async getReadyClient() {
    // 1. Si ya hay un cliente general disponible en el servidor, reutilizarlo
    const existing = getRedisClient();
    if (existing && isRedisAvailable()) {
      return existing;
    }

    // 2. Si ya instanciamos un cliente directo en esta sesión CLI y sigue activo
    if (this.directClient && this.directClient.status === 'ready') {
      return this.directClient;
    }

    // 3. Obtener URL de Redis de .env.local o .env
    const redisUrl = process.env.REDIS_URL || config.redis.url;
    if (!redisUrl) {
      throw new AppError('REDIS_URL no está configurado en las variables de entorno (.env o .env.local).', 503, 'REDIS_NOT_CONFIGURED');
    }

    // 4. Instanciar cliente directo sin prefijo forzado para visibilidad total de prod: y local:
    const Redis = (await import('ioredis')).default;
    this.directClient = new Redis(redisUrl, {
      password: process.env.REDIS_TOKEN || config.redis.token || undefined,
      connectTimeout: 15000,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });

    try {
      await this.directClient.connect();
      return this.directClient;
    } catch (err: any) {
      this.directClient = null;
      throw new AppError(`No se pudo conectar a Redis (${err.message}). Verifique la conexión a internet y el REDIS_URL.`, 503, 'REDIS_CONNECTION_FAILED');
    }
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

    // Normalizar claves (remover prefijos prod: / local: para visualización amigable)
    const cleanKeyMap = new Map<string, string>(); // cleanKey -> rawKey
    for (const rawKey of Array.from(rawFoundKeys)) {
      let cleanKey = rawKey;
      if (keyPrefix && rawKey.startsWith(keyPrefix)) {
        cleanKey = rawKey.slice(keyPrefix.length);
      } else if (rawKey.startsWith('prod:')) {
        cleanKey = rawKey.slice(5);
      } else if (rawKey.startsWith('local:')) {
        cleanKey = rawKey.slice(6);
      }
      cleanKeyMap.set(cleanKey, rawKey);
    }

    const items: RedisKeyItem[] = [];
    const entries = Array.from(cleanKeyMap.entries());

    if (entries.length > 0) {
      // Pipeline para obtener tipo y TTL de todas las claves en 1 solo round-trip usando la clave real en Redis
      const pipeline = redis.pipeline();
      for (const [, rawKey] of entries) {
        pipeline.type(rawKey);
        pipeline.ttl(rawKey);
      }
      const results = await pipeline.exec();

      if (results) {
        for (let i = 0; i < entries.length; i++) {
          const [cleanKey, rawKey] = entries[i];
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

    // Normalizar variantes de claves para garantizar borrado tanto con prod: como con local: y raw
    const allKeysToUnlink = new Set<string>();
    for (const k of keys) {
      allKeysToUnlink.add(k);
      if (k.startsWith('prod:')) {
        allKeysToUnlink.add(k.slice(5));
      } else if (k.startsWith('local:')) {
        allKeysToUnlink.add(k.slice(6));
      } else {
        allKeysToUnlink.add(`prod:${k}`);
        allKeysToUnlink.add(`local:${k}`);
      }
    }

    const unlinkedTargets = Array.from(allKeysToUnlink);

    // Borrado no bloqueante con UNLINK en lotes
    const BATCH_SIZE = 100;
    let totalUnlinked = 0;

    for (let i = 0; i < unlinkedTargets.length; i += BATCH_SIZE) {
      const batch = unlinkedTargets.slice(i, i + BATCH_SIZE);
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
        keysCount: unlinkedTargets.length,
        unlinkedCount: totalUnlinked,
        sampleKeys: unlinkedTargets.slice(0, 5),
      },
    });

    return {
      deletedCount: totalUnlinked,
      deletedKeys: unlinkedTargets,
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
