// src/repositories/helpers/ticket-restriction.helper.ts
import { Prisma } from "../../generated/prisma/client";
import logger from "../../core/logger";
import { AppError } from "../../core/errors";
import { getCRLocalComponents } from "../../utils/businessDate";
import { restrictionCacheV2 } from "../../utils/restrictionCacheV2";
import { getRedisClient, isRedisAvailable, markRedisError } from "../../core/redisClient";
import prisma from "../../core/prismaClient";

/**
 * Intenta adquirir un lock distribuido en Redis.
 * Retorna true si se adquirió, false en caso contrario.
 */
export async function acquireLock(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const redis = getRedisClient();
  if (!redis) return false;

  try {
    const result = await redis.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  } catch (err: any) {
    logger.error({
      layer: "redis-lock",
      action: "ACQUIRE_LOCK_ERROR",
      payload: { key, error: err.message },
    });
    return false;
  }
}

/**
 * Libera un lock distribuido de forma segura usando un script Lua.
 * Compara el valor actual con el proporcionado antes de eliminar.
 */
export async function releaseLock(key: string, value: string): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const redis = getRedisClient();
  if (!redis) return false;

  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    const result = await redis.eval(luaScript, 1, key, value);
    return result === 1;
  } catch (err: any) {
    logger.error({
      layer: "redis-lock",
      action: "RELEASE_LOCK_ERROR",
      payload: { key, error: err.message },
    });
    return false;
  }
}

/**
 * Caché interno para optimizar validaciones durante una transacción de creación de ticket.
 * Evita repetir queries agregadas (SUM) para el mismo ámbito o números.
 */
export interface ScopeCache {
  // Totales de venta por sorteo (para calculateDynamicLimit)
  // Key: "scopeType:scopeId" (ej: "USER:uuid", "VENTANA:uuid")
  salesTotals: Map<string, number>;

  // Acumulados por número y alcance (para validateMaxTotal)
  // Key: "scopeType:scopeId:sorteoId:multiplierKey"
  // multiplierKey = multiplierId | "REVENTADO" | "NONE"
  numberTotals: Map<string, Map<string, number>>;
}

/**
 * Calcula los acumulados del sorteo para múltiples números y alcance en una sola query
 * ️ IMPORTANTE: El acumulado es independiente por sorteo, no se mezcla entre sorteos diferentes
 * 
 *  OPTIMIZACIÓN: Calcula todos los acumulados en una sola query para mejor rendimiento
 * 
 * Incluye:
 * - Jugadas tipo NUMERO con el número específico
 * - Jugadas tipo REVENTADO con reventadoNumber igual al número específico
 * 
 * @param tx Transacción de Prisma
 * @param params Parámetros de cálculo
 * @returns Map con número como clave y acumulado como valor
 */
export async function calculateAccumulatedByNumbersAndScope(
  tx: Prisma.TransactionClient,
  params: {
    numbers: string[];          // Array de números (ej: ["15", "20"])
    scopeType: 'USER' | 'VENTANA' | 'BANCA';
    scopeId: string;            // userId, ventanaId, o bancaId
    sorteoId: string;           // ️ CRÍTICO: Acumulado es por sorteo
    multiplierFilter?: { id: string; kind: 'NUMERO' | 'REVENTADO' } | null;
    cache?: ScopeCache;
  }
): Promise<Map<string, number>> {
  const { numbers, scopeType, scopeId, sorteoId, multiplierFilter, cache } = params;

  // Si no hay números, retornar map vacío
  if (numbers.length === 0) {
    return new Map();
  }

  // 1. Intentar obtener de caché si existe
  const multiplierId = multiplierFilter ? (multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : multiplierFilter.id) : 'NONE';
  const cacheKey = `${scopeType}:${scopeId}:${sorteoId}:${multiplierId}`;
  
  if (cache) {
    const cachedMap = cache.numberTotals.get(cacheKey);
    if (cachedMap) {
      const result = new Map<string, number>();
      let allCached = true;
      for (const num of numbers) {
        if (cachedMap.has(num)) {
          result.set(num, cachedMap.get(num)!);
        } else {
          allCached = false;
          break;
        }
      }
      if (allCached) return result;
    }
  }

  // 2. Intentar obtener de Redis si está disponible
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    if (redis) {
      try {
        // Asegurar que el sorteo esté hidratado
        const hydratedKey = `sorteo:${sorteoId}:hydrated`;
        const isHydrated = await redis.get(hydratedKey);
        if (!isHydrated) {
          await rehydrateRedisAccumulated(sorteoId, tx);
        }

        // Construir clave
        let redisKey = `sorteo:${sorteoId}:scope:${scopeId}:acumulados`;
        if (multiplierFilter) {
          const multId = multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : multiplierFilter.id;
          redisKey = `sorteo:${sorteoId}:scope:${scopeId}:multiplier:${multId}:acumulados`;
        }

        // HMGET
        const values = await redis.hmget(redisKey, ...numbers);

        const accumulatedMap = new Map<string, number>();
        for (let i = 0; i < numbers.length; i++) {
          const num = numbers[i];
          const val = parseFloat(values[i] || '0');
          accumulatedMap.set(num, val);
        }

        // Guardar en caché local si existe
        if (cache) {
          let cachedMap = cache.numberTotals.get(cacheKey);
          if (!cachedMap) {
            cachedMap = new Map<string, number>();
            cache.numberTotals.set(cacheKey, cachedMap);
          }
          for (const [num, total] of accumulatedMap) {
            cachedMap.set(num, total);
          }
        }

        logger.debug({
          layer: 'redis-validation',
          action: 'ACCUMULATED_BY_NUMBERS_SCOPE_REDIS_READ',
          payload: {
            scope: `${scopeType}:${scopeId}`,
            sorteoId,
            redisKey,
            numerosCount: numbers.length,
          },
        });

        return accumulatedMap;
      } catch (redisErr: any) {
        markRedisError('calculateAccumulatedByNumbersAndScope');
        logger.warn({
          layer: 'redis-validation',
          action: 'REDIS_READ_ERROR_FALLBACK_TO_DB',
          payload: {
            scope: `${scopeType}:${scopeId}`,
            sorteoId,
            error: redisErr.message,
          },
        });
      }
    }
  }

  try {
    // Construir WHERE según alcance usando SQL directo para mejor rendimiento y seguridad
    let scopeCondition: Prisma.Sql;

    if (scopeType === 'USER') {
      scopeCondition = Prisma.sql`t."vendedorId" = ${scopeId}::uuid`;
    } else if (scopeType === 'VENTANA') {
      scopeCondition = Prisma.sql`t."ventanaId" = ${scopeId}::uuid`;
    } else if (scopeType === 'BANCA') {
      scopeCondition = Prisma.sql`v."bancaId" = ${scopeId}::uuid`;
    } else {
      throw new Error(`Invalid scopeType: ${scopeType}`);
    }

    //  Construir condición de multiplicador
    let multiplierCondition = Prisma.sql``;
    if (multiplierFilter) {
      if (multiplierFilter.kind === 'REVENTADO') {
        // Para REVENTADO, filtramos por tipo de jugada (jugadas reventadas no tienen multiplierId)
        multiplierCondition = Prisma.sql`AND j."type" = 'REVENTADO'`;
      } else {
        // Para NUMERO, filtramos por el ID del multiplicador específico
        multiplierCondition = Prisma.sql`AND j."multiplierId" = ${multiplierFilter.id}::uuid`;
      }
    }

    //  OPTIMIZACIÓN: Si se consultan muchos números (ej. el grid completo), es mucho más rápido 
    //  traer todos los acumulados del sorteo y mapear en memoria en vez de inyectar 200 ORs.
    const useFullScan = numbers.length > 30;
    let whereNumberClause = Prisma.sql``;

    if (!useFullScan) {
      const numberConditions: Prisma.Sql[] = [];
      for (const num of numbers) {
        // Validar que el número sea válido (solo dígitos, 0-999)
        if (!/^\d{1,3}$/.test(num)) {
          logger.warn({
            layer: 'repository',
            action: 'INVALID_NUMBER_IN_QUERY',
            payload: { number: num, numbers },
          });
          continue; // Saltar números inválidos
        }

        numberConditions.push(
          Prisma.sql`j."number" = ${num}`
        );
      }

      // Si no hay condiciones válidas, retornar map vacío
      if (numberConditions.length === 0) {
        return new Map();
      }
      whereNumberClause = Prisma.sql`AND (${Prisma.join(numberConditions, ' OR ')})`;
    }

    const result = await tx.$queryRaw<Array<{ number: string; total: number }>>(
      Prisma.sql`
        SELECT 
          j."number" as number,
          COALESCE(SUM(j.amount), 0)::numeric as total
        FROM "Ticket" t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
        ${scopeType === 'BANCA'
          ? Prisma.sql`INNER JOIN "Ventana" v ON v.id = t."ventanaId"`
          : Prisma.sql``
        }
        WHERE 
          ${scopeCondition}
          AND t."sorteoId" = ${sorteoId}::uuid
          AND t."status" != 'CANCELLED'
          AND t."isActive" = true  --  Exclusivo activos
          AND t."deletedAt" IS NULL
          AND j."isActive" = true  --  Exclusivo activas
          AND j."deletedAt" IS NULL
          ${multiplierCondition}   --  Inyectar filtro de multiplicador
          ${whereNumberClause}
        GROUP BY j."number"
      `
    );

    // Convertir resultado a Map
    const accumulatedMap = new Map<string, number>();
    for (const row of result) {
      accumulatedMap.set(row.number, Number(row.total ?? 0));
    }

    // Asegurar que todos los números tengan entrada (aunque sea 0)
    for (const num of numbers) {
      if (!accumulatedMap.has(num)) {
        accumulatedMap.set(num, 0);
      }
    }

    logger.debug({
      layer: 'repository',
      action: 'ACCUMULATED_BY_NUMBERS_SCOPE_CALCULATED',
      payload: {
        scope: `${scopeType}:${scopeId}`,
        sorteoId,
        numeros: Object.fromEntries(accumulatedMap),
      },
    });

    // Guardar en caché si existe
    if (cache) {
      let cachedMap = cache.numberTotals.get(cacheKey);
      if (!cachedMap) {
        cachedMap = new Map<string, number>();
        cache.numberTotals.set(cacheKey, cachedMap);
      }
      for (const [num, total] of accumulatedMap) {
        cachedMap.set(num, total);
      }
    }

    return accumulatedMap;
  } catch (error: any) {
    logger.error({
      layer: 'repository',
      action: 'ACCUMULATED_BY_NUMBERS_SCOPE_ERROR',
      payload: {
        scope: `${scopeType}:${scopeId}`,
        sorteoId,
        numeros: numbers,
        error: error.message,
      },
    });
    throw error;
  }
}

/**
 * Calcula los acumulados del sorteo para múltiples ámbitos (scopes) y números en una sola consulta masiva
 *
 * @param tx Transacción de Prisma
 * @param params Parámetros de cálculo masivo
 */
export async function calculateAccumulatedForMultipleScopes(
  tx: Prisma.TransactionClient,
  params: {
    numbers: string[];
    sorteoId: string;
    scopes: Array<{
      scopeType: 'USER' | 'VENTANA' | 'BANCA';
      scopeId: string;
      multiplierFilter?: { id: string; kind: 'NUMERO' | 'REVENTADO' } | null;
    }>;
    cache?: ScopeCache;
  }
): Promise<void> {
  const { numbers, sorteoId, scopes, cache } = params;

  if (numbers.length === 0 || scopes.length === 0) {
    return;
  }

  // 1. Filtrar scopes que ya están en caché (para no volver a consultarlos si ya se pre-cargaron)
  const scopesToQuery: typeof scopes = [];
  for (const sc of scopes) {
    const multiplierId = sc.multiplierFilter
      ? (sc.multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : sc.multiplierFilter.id)
      : 'NONE';
    const cacheKey = `${sc.scopeType}:${sc.scopeId}:${sorteoId}:${multiplierId}`;
    
    let isCached = false;
    if (cache) {
      const cachedMap = cache.numberTotals.get(cacheKey);
      if (cachedMap) {
        let allCached = true;
        for (const num of numbers) {
          if (!cachedMap.has(num)) {
            allCached = false;
            break;
          }
        }
        if (allCached) {
          isCached = true;
        }
      }
    }

    if (!isCached) {
      scopesToQuery.push(sc);
    }
  }

  if (scopesToQuery.length === 0) {
    return;
  }

  // 1.5 Intentar obtener de Redis en lote
  if (isRedisAvailable()) {
    const redis = getRedisClient();
    if (redis) {
      try {
        // Asegurar hidratación
        const hydratedKey = `sorteo:${sorteoId}:hydrated`;
        const isHydrated = await redis.get(hydratedKey);
        if (!isHydrated) {
          await rehydrateRedisAccumulated(sorteoId, tx);
        }

        const pipeline = redis.pipeline();
        
        // Encolar llamadas HMGET para cada scope
        for (const sc of scopesToQuery) {
          let redisKey = `sorteo:${sorteoId}:scope:${sc.scopeId}:acumulados`;
          if (sc.multiplierFilter) {
            const multId = sc.multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : sc.multiplierFilter.id;
            redisKey = `sorteo:${sorteoId}:scope:${sc.scopeId}:multiplier:${multId}:acumulados`;
          }
          pipeline.hmget(redisKey, ...numbers);
        }

        const pipelineResults = await pipeline.exec();

        // Procesar los resultados
        if (pipelineResults) {
          for (let idx = 0; idx < scopesToQuery.length; idx++) {
            const sc = scopesToQuery[idx];
            const pipelineRes = pipelineResults[idx];
            
            // ioredis pipeline exec returns [err, result] pairs
            const err = pipelineRes[0];
            const values = pipelineRes[1] as string[] | null;

            if (err) throw err;

            const multiplierId = sc.multiplierFilter
              ? (sc.multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : sc.multiplierFilter.id)
              : 'NONE';
            const cacheKey = `${sc.scopeType}:${sc.scopeId}:${sorteoId}:${multiplierId}`;

            const accumulatedMap = new Map<string, number>();
            for (let i = 0; i < numbers.length; i++) {
              const num = numbers[i];
              const val = parseFloat((values && values[i]) || '0');
              accumulatedMap.set(num, val);
            }

            if (cache) {
              let cachedMap = cache.numberTotals.get(cacheKey);
              if (!cachedMap) {
                cachedMap = new Map<string, number>();
                cache.numberTotals.set(cacheKey, cachedMap);
              }
              for (const [num, total] of accumulatedMap) {
                cachedMap.set(num, total);
              }
            }
          }

          logger.debug({
            layer: 'redis-validation',
            action: 'ACCUMULATED_FOR_MULTIPLE_SCOPES_REDIS_READ',
            payload: {
              sorteoId,
              scopesCount: scopesToQuery.length,
              numerosCount: numbers.length,
            },
          });

          return; // Retorno exitoso
        }
      } catch (redisErr: any) {
        markRedisError('calculateAccumulatedForMultipleScopes');
        logger.warn({
          layer: 'redis-validation',
          action: 'REDIS_BATCH_READ_ERROR_FALLBACK_TO_DB',
          payload: {
            sorteoId,
            scopesCount: scopesToQuery.length,
            error: redisErr.message,
          },
        });
      }
    }
  }

  // 2. Construir el WHERE dinámico de scopes con ORs
  const scopeConditions: Prisma.Sql[] = [];
  for (const sc of scopesToQuery) {
    let scopeCond: Prisma.Sql;
    if (sc.scopeType === 'USER') {
      scopeCond = Prisma.sql`t."vendedorId" = ${sc.scopeId}::uuid`;
    } else if (sc.scopeType === 'VENTANA') {
      scopeCond = Prisma.sql`t."ventanaId" = ${sc.scopeId}::uuid`;
    } else if (sc.scopeType === 'BANCA') {
      scopeCond = Prisma.sql`v."bancaId" = ${sc.scopeId}::uuid`;
    } else {
      continue;
    }

    let multCond = Prisma.sql``;
    if (sc.multiplierFilter) {
      if (sc.multiplierFilter.kind === 'REVENTADO') {
        multCond = Prisma.sql`AND j."type" = 'REVENTADO'`;
      } else {
        multCond = Prisma.sql`AND j."multiplierId" = ${sc.multiplierFilter.id}::uuid`;
      }
    }

    scopeConditions.push(Prisma.sql`(${scopeCond} ${multCond})`);
  }

  let whereScopesClause = Prisma.empty;
  if (scopeConditions.length > 0) {
    whereScopesClause = Prisma.sql`AND (${Prisma.join(scopeConditions, ' OR ')})`;
  }

  // 3. Construir el WHERE dinámico de números
  const useFullScan = numbers.length > 30;
  let whereNumberClause = Prisma.empty;

  if (!useFullScan) {
    const numberConditions: Prisma.Sql[] = [];
    for (const num of numbers) {
      if (!/^\d{1,3}$/.test(num)) {
        continue;
      }
      numberConditions.push(Prisma.sql`j."number" = ${num}`);
    }
    if (numberConditions.length > 0) {
      whereNumberClause = Prisma.sql`AND (${Prisma.join(numberConditions, ' OR ')})`;
    }
  }

  try {
    // 4. Ejecutar la query masiva
    const result = await tx.$queryRaw<
      Array<{
        number: string;
        vendedorId: string | null;
        ventanaId: string | null;
        bancaId: string | null;
        jugadaType: string;
        multiplierId: string | null;
        total: string | number;
      }>
    >(
      Prisma.sql`
        SELECT 
          j."number" as number,
          t."vendedorId" as "vendedorId",
          t."ventanaId" as "ventanaId",
          v."bancaId" as "bancaId",
          j."type" as "jugadaType",
          j."multiplierId" as "multiplierId",
          COALESCE(SUM(j.amount), 0)::numeric as total
        FROM "Ticket" t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
        INNER JOIN "Ventana" v ON v.id = t."ventanaId"
        WHERE 
          t."sorteoId" = ${sorteoId}::uuid
          AND t."status" != 'CANCELLED'
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."deletedAt" IS NULL
          ${whereNumberClause}
          ${whereScopesClause}
        GROUP BY j."number", t."vendedorId", t."ventanaId", v."bancaId", j."type", j."multiplierId"
      `
    );

    // 5. Agrupar/mapear los resultados en memoria para cada scope solicitado
    for (const sc of scopesToQuery) {
      const multiplierId = sc.multiplierFilter
        ? (sc.multiplierFilter.kind === 'REVENTADO' ? 'REVENTADO' : sc.multiplierFilter.id)
        : 'NONE';
      const cacheKey = `${sc.scopeType}:${sc.scopeId}:${sorteoId}:${multiplierId}`;

      const accumulatedMap = new Map<string, number>();

      // Inicializar todos los números solicitados con 0
      for (const num of numbers) {
        accumulatedMap.set(num, 0);
      }

      // Filtrar y sumar las filas correspondientes a este scope
      for (const row of result) {
        // Verificar si la fila pertenece al scope actual
        let scopeMatches = false;
        if (sc.scopeType === 'USER') {
          scopeMatches = row.vendedorId === sc.scopeId;
        } else if (sc.scopeType === 'VENTANA') {
          scopeMatches = row.ventanaId === sc.scopeId;
        } else if (sc.scopeType === 'BANCA') {
          scopeMatches = row.bancaId === sc.scopeId;
        }

        if (!scopeMatches) continue;

        // Verificar si la fila pertenece al multiplicador actual
        let multiplierMatches = false;
        if (!sc.multiplierFilter) {
          // multiplierFilter null/NONE -> sumamos todo (tanto NUMERO como REVENTADO)
          multiplierMatches = true;
        } else if (sc.multiplierFilter.kind === 'REVENTADO') {
          multiplierMatches = row.jugadaType === 'REVENTADO';
        } else {
          multiplierMatches = row.jugadaType === 'NUMERO' && row.multiplierId === sc.multiplierFilter.id;
        }

        if (!multiplierMatches) continue;

        // Sumar al número correspondiente
        const totalAmount = Number(row.total ?? 0);
        if (accumulatedMap.has(row.number)) {
          accumulatedMap.set(row.number, accumulatedMap.get(row.number)! + totalAmount);
        }
      }

      // Guardar en caché si existe
      if (cache) {
        let cachedMap = cache.numberTotals.get(cacheKey);
        if (!cachedMap) {
          cachedMap = new Map<string, number>();
          cache.numberTotals.set(cacheKey, cachedMap);
        }
        for (const [num, total] of accumulatedMap) {
          cachedMap.set(num, total);
        }
      }
    }
  } catch (error: any) {
    logger.error({
      layer: 'repository',
      action: 'ACCUMULATED_FOR_MULTIPLE_SCOPES_ERROR',
      payload: {
        sorteoId,
        scopes: scopesToQuery,
        error: error.message,
      },
    });
    throw error;
  }
}

/**
 * Calcula el acumulado del sorteo para un número específico y alcance
 * ️ IMPORTANTE: El acumulado es independiente por sorteo, no se mezcla entre sorteos diferentes
 * 
 *  OPTIMIZACIÓN: Usa calculateAccumulatedByNumbersAndScope internamente para mejor rendimiento
 * 
 * Incluye:
 * - Jugadas tipo NUMERO con el número específico
 * - Jugadas tipo REVENTADO con reventadoNumber igual al número específico
 * 
 * @param tx Transacción de Prisma
 * @param params Parámetros de cálculo
 * @returns Monto acumulado del sorteo para el número y alcance
 */
export async function calculateAccumulatedByNumberAndScope(
  tx: Prisma.TransactionClient,
  params: {
    number: string;              // Número específico (ej: "15")
    scopeType: 'USER' | 'VENTANA' | 'BANCA';
    scopeId: string;            // userId, ventanaId, o bancaId
    sorteoId: string;           // ️ CRÍTICO: Acumulado es por sorteo
    multiplierFilter?: {        //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
    cache?: ScopeCache;
  }
): Promise<number> {
  //  OPTIMIZACIÓN: Usar función optimizada que calcula múltiples números en una query
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: [params.number],
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    sorteoId: params.sorteoId,
    multiplierFilter: params.multiplierFilter,
    cache: params.cache, // Propagar caché si existe
  });

  return accumulatedMap.get(params.number) ?? 0;
}

/**
 * Determina el número a validar basado en la regla de restricción
 * Maneja casos de isAutoDate, arrays, strings únicos, y null/undefined
 * 
 * @param rule Regla de restricción
 * @param at Fecha/hora actual (para isAutoDate)
 * @returns Array de números a validar (puede estar vacío si no hay números específicos)
 */
export function resolveNumbersToValidate(
  rule: {
    number?: string | string[] | null;
    isAutoDate?: boolean | null;
  },
  at: Date = new Date()
): string[] {
  const numbers: string[] = [];

  // Si isAutoDate = true, calcular número automático según día del mes (CR timezone)
  if (rule.isAutoDate === true) {
    const crComponents = getCRLocalComponents(at);
    const autoNumber = String(crComponents.day).padStart(2, '0');
    numbers.push(autoNumber);

    logger.debug({
      layer: 'repository',
      action: 'AUTO_DATE_NUMBER_RESOLVED',
      payload: {
        dayOfMonth: crComponents.day,
        autoNumber,
        at: at.toISOString(),
      },
    });

    return numbers;
  }

  // Si no hay número específico, retornar array vacío (se validarán todos los números del ticket)
  if (!rule.number) {
    return [];
  }

  // Si es array, agregar todos los números
  if (Array.isArray(rule.number)) {
    // Filtrar valores válidos y eliminar duplicados
    const uniqueNumbers = [...new Set(rule.number.filter(n => n && typeof n === 'string' && n.trim()))];
    numbers.push(...uniqueNumbers);

    logger.debug({
      layer: 'repository',
      action: 'ARRAY_NUMBERS_RESOLVED',
      payload: {
        numbers: uniqueNumbers,
        originalLength: rule.number.length,
      },
    });

    return numbers;
  }

  // Si es string único
  if (typeof rule.number === 'string' && rule.number.trim()) {
    numbers.push(rule.number.trim());
    return numbers;
  }

  // Caso por defecto: sin números específicos
  return [];
}

/**
 * Valida maxTotal para múltiples números contra el acumulado del sorteo
 *  OPTIMIZACIÓN: Calcula todos los acumulados en una sola query
 * 
 * ️ CRÍTICO: 
 * - maxTotal es acumulado por número INDIVIDUAL en el sorteo
 * - NO se valida sobre total del ticket
 * - NO se valida sobre total diario
 * - Cada número se valida independientemente
 * 
 * @param tx Transacción de Prisma
 * @param params Parámetros de validación
 * @returns void si todos son válidos, lanza error si alguno excede el límite
 */
export async function validateMaxTotalForNumbers(
  tx: Prisma.TransactionClient,
  params: {
    numbers: Array<{ number: string; amountForNumber: number }>; // Array de números y sus montos
    rule: {
      maxTotal: number;
      userId?: string | null;
      ventanaId?: string | null;
      bancaId?: string | null;
      isAutoDate?: boolean | null;
      appliesToVendedor?: boolean | null; //  AHORA EXPLÍCITO
      id?: string;
      baseAmount?: number | null; //  NUEVO: crédito inicial que absorbe ventas sin consumir el límite
    };
    sorteoId: string;
    vendedorId?: string | null;   //  NUEVO: Para appliesToVendedor=true
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
    multiplierFilter?: {          //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
    cache?: ScopeCache;
  }
): Promise<void> {
  const { numbers, rule, sorteoId, dynamicLimit, multiplierFilter, cache } = params;

  // Si no hay números, no validar
  if (numbers.length === 0) {
    return;
  }

  // Determinar alcance
  const isPerVendedor = !!rule.appliesToVendedor;
  const scopeType = isPerVendedor ? 'USER'
    : rule.userId ? 'USER'
      : rule.ventanaId ? 'VENTANA'
        : rule.bancaId ? 'BANCA'
          : null;

  if (!scopeType) {
    // Sin alcance específico: no validar (fallback a comportamiento legacy)
    logger.debug({
      layer: 'repository',
      action: 'MAXTOTAL_VALIDATION_SKIPPED_NO_SCOPE',
      payload: { ruleId: rule.id },
    });
    return;
  }

  const scopeId = (isPerVendedor ? (params.vendedorId || rule.userId)
    : (rule.userId || rule.ventanaId || rule.bancaId)) as string;

  if (!scopeId) {
    logger.warn({
      layer: 'repository',
      action: 'MAXTOTAL_VALIDATION_ERROR_NO_SCOPE_ID',
      payload: { scopeType, ruleId: rule.id },
    });
    return;
  }

  // Calcular límite efectivo (considerar límite dinámico si existe)
  const staticMaxTotal = rule.maxTotal ?? Infinity;
  const effectiveMaxTotal = dynamicLimit != null
    ? Math.min(staticMaxTotal, dynamicLimit)
    : staticMaxTotal;

  //  OPTIMIZACIÓN: Calcular todos los acumulados en una sola query
  const numberStrings = numbers.map(n => n.number);
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: numberStrings,
    scopeType,
    scopeId,
    sorteoId,
    multiplierFilter, //  Pasar filtro al cálculo
    cache,            //  Propagar caché
  });

  //  CRÍTICO: Validar cada número INDIVIDUALMENTE (no por total del ticket)
  for (const { number, amountForNumber } of numbers) {
    //  ROBUSTEZ: Validar que amountForNumber sea un número válido
    if (!Number.isFinite(amountForNumber) || amountForNumber <= 0) {
      logger.warn({
        layer: 'repository',
        action: 'INVALID_AMOUNT_FOR_NUMBER',
        payload: { number, amountForNumber, ruleId: rule },
      });
      continue; // Saltar números con montos inválidos
    }

    //  CRÍTICO: accumulatedInSorteo es el acumulado SOLO de este número específico en el sorteo
    const accumulatedInSorteo = accumulatedMap.get(number) ?? 0;
    
    //  ROBUSTEZ: Validar que accumulatedInSorteo sea un número válido
    if (!Number.isFinite(accumulatedInSorteo) || accumulatedInSorteo < 0) {
      logger.error({
        layer: 'repository',
        action: 'INVALID_ACCUMULATED_IN_SORTEO',
        payload: { number, accumulatedInSorteo, sorteoId },
      });
      throw new AppError(
        `Error al obtener acumulado del número ${number}. Contacte al administrador.`,
        500,
        'CALCULATION_ERROR'
      );
    }

    //  ROBUSTEZ: Validar que effectiveMaxTotal sea un número válido
    if (effectiveMaxTotal == null || !Number.isFinite(effectiveMaxTotal)) {
      logger.error({
        layer: 'repository',
        action: 'INVALID_EFFECTIVE_MAX_TOTAL',
        payload: { number, effectiveMaxTotal, ruleId: rule },
      });
      throw new AppError(
        `Error en configuración de límite para el número ${number}. Contacte al administrador.`,
        500,
        'CONFIGURATION_ERROR'
      );
    }

    //  baseAmount actúa como crédito inicial: ventas hasta baseAmount no consumen el límite
    // dynamicLimit ya incorpora el base como piso (max(base, pct)), no hay que deducirlo del acumulado
    const newAccumulated = accumulatedInSorteo + amountForNumber;

    if (newAccumulated > effectiveMaxTotal) {
      const available = Math.max(0, effectiveMaxTotal - accumulatedInSorteo);
      const scopeLabel = rule.userId ? "personal"
        : rule.ventanaId ? "de ventana"
          : rule.bancaId ? "de banca"
            : "global";

      const isAutoDateLabel = rule.isAutoDate ? " (restricción automática por fecha)" : "";

      logger.warn({
        layer: 'repository',
        action: 'MAXTOTAL_EXCEEDED',
        payload: {
          numero: number,
          scope: `${scopeType}:${scopeId}`,
          sorteoId,
          limite: `₡${effectiveMaxTotal.toFixed(2)}`,
          ya_vendido: `₡${accumulatedInSorteo.toFixed(2)}`,
          intento: `₡${amountForNumber.toFixed(2)}`,
          disponible: `₡${available.toFixed(2)}`,
          calculo: `₡${effectiveMaxTotal.toFixed(2)} − ₡${accumulatedInSorteo.toFixed(2)} = ₡${available.toFixed(2)}`,
        },
      });

      const typeSuffix = multiplierFilter ? ` (${multiplierFilter.kind})` : '';
      const userMessage = available > 0
        ? `El número ${number}${isAutoDateLabel}${typeSuffix}: Disponible ₡${available.toFixed(2)}`
        : `El número ${number}${isAutoDateLabel}${typeSuffix}: Agotado para este sorteo`;

      throw new AppError(
        userMessage,
        400,
        {
          code: "NUMBER_MAXTOTAL_EXCEEDED",
          number,
          scopeType,
          scope: scopeLabel,
          sorteoId,
          accumulatedInSorteo,
          amountForNumber,
          effectiveMaxTotal,
          available,
        }
      );
    }
  }
}

/**
 * Valida maxTotal para un número específico contra el acumulado del sorteo
 *  OPTIMIZACIÓN: Usa validateMaxTotalForNumbers internamente
 * 
 * @param tx Transacción de Prisma
 * @param params Parámetros de validación
 * @returns void si es válido, lanza error si excede el límite
 */
export async function validateMaxTotalForNumber(
  tx: Prisma.TransactionClient,
  params: {
    number: string;
    amountForNumber: number;     // Monto del ticket para este número específico
    rule: {
      maxTotal: number;
      userId?: string | null;
      ventanaId?: string | null;
      bancaId?: string | null;
      isAutoDate?: boolean | null;
      appliesToVendedor?: boolean | null;
    };
    sorteoId: string;
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
    multiplierFilter?: {          //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
    cache?: ScopeCache;
  }
): Promise<void> {
  return validateMaxTotalForNumbers(tx, {
    numbers: [{ number: params.number, amountForNumber: params.amountForNumber }],
    rule: params.rule,
    sorteoId: params.sorteoId,
    dynamicLimit: params.dynamicLimit,
    multiplierFilter: params.multiplierFilter,
    cache: params.cache,
  });
}

/**
 *  PARALLEL VALIDATION SYSTEM
 *
 * Valida múltiples reglas de restricción en paralelo para mejorar rendimiento.
 * Las validaciones independientes se ejecutan concurrentemente mientras que
 * las dependientes se ejecutan secuencialmente.
 */

interface ValidationTask {
  ruleId: string;
  rule: any;
  numbersToValidate: string[];
  dynamicLimit?: number | null;
  priority: number;
  dependencies: string[]; // IDs de reglas que deben ejecutarse antes
}

interface ValidationResult {
  ruleId: string;
  success: boolean;
  error?: Error;
  executionTime: number;
  numbersValidated: number;
}

/**
 * Determina si dos reglas pueden validarse en paralelo
 * Reglas independientes pueden ejecutarse concurrentemente
 */
function canValidateInParallel(ruleA: any, ruleB: any): boolean {
  // Reglas del mismo scope no pueden ser paralelas (comparten acumulados)
  if (ruleA.userId === ruleB.userId && ruleA.ventanaId === ruleB.ventanaId && ruleA.bancaId === ruleB.bancaId) {
    return false;
  }

  // Reglas con diferentes multiplicadores pueden ser paralelas
  if (ruleA.multiplierId !== ruleB.multiplierId) {
    return true;
  }

  // Reglas con números específicos diferentes pueden ser paralelas
  const numbersA = resolveNumbersToValidate(ruleA, new Date());
  const numbersB = resolveNumbersToValidate(ruleB, new Date());

  if (numbersA.length > 0 && numbersB.length > 0) {
    // Si no hay overlap en números, pueden ser paralelas
    const overlap = numbersA.some(num => numbersB.includes(num));
    if (!overlap) {
      return true;
    }
  }

  // Por defecto, asumir secuencial para seguridad
  return false;
}

/**
 * Organiza reglas en grupos paralelos y secuenciales
 */
function organizeValidationTasks(rules: any[]): {
  parallelGroups: ValidationTask[][];
  sequentialTasks: ValidationTask[];
} {
  const tasks: ValidationTask[] = rules.map((rule, index) => ({
    ruleId: rule.id,
    rule,
    numbersToValidate: resolveNumbersToValidate(rule, new Date()),
    priority: index, // Mantener orden original como fallback
    dependencies: [],
  }));

  const parallelGroups: ValidationTask[][] = [];
  const processed = new Set<string>();

  // Algoritmo simple: agrupar reglas que no comparten scope
  for (const task of tasks) {
    if (processed.has(task.ruleId)) continue;

    const group: ValidationTask[] = [task];
    processed.add(task.ruleId);

    // Buscar reglas compatibles para este grupo
    for (const otherTask of tasks) {
      if (processed.has(otherTask.ruleId)) continue;

      // Verificar si puede unirse al grupo
      const canJoin = group.every(existingTask =>
        canValidateInParallel(existingTask.rule, otherTask.rule)
      );

      if (canJoin) {
        group.push(otherTask);
        processed.add(otherTask.ruleId);
      }
    }

    parallelGroups.push(group);
  }

  return {
    parallelGroups,
    sequentialTasks: [], // Todas las reglas pueden ser paralelas en este caso
  };
}

/**
 * Ejecuta una tarea de validación individual
 */
async function executeValidationTask(
  tx: Prisma.TransactionClient,
  task: ValidationTask,
  context: {
    sorteoId: string;
    loteriaId: string; //  NUEVO: Para filtrar por lotería
    vendedorId?: string | null; //  NUEVO: Para appliesToVendedor
    numbers: Array<{ 
      number: string; 
      amountForNumber: number; 
      type: "NUMERO" | "REVENTADO"; 
      multiplierId?: string | null 
    }>;
    cache?: ScopeCache;
  }
): Promise<ValidationResult> {
  const startTime = Date.now();

  try {
    const { rule, numbersToValidate } = task;

    //  NUEVO: Filtrar por lotería si la regla especifica una
    if (rule.loteriaId && rule.loteriaId !== context.loteriaId) {
      return {
        ruleId: rule.id,
        success: true,
        executionTime: Date.now() - startTime,
        numbersValidated: 0
      };
    }

    if (numbersToValidate.length > 0) {
      // Case 1: Specific numbers in rule
      let effectiveMaxAmount: number | null = null;
      if (rule.maxAmount != null) {
        // dynamicLimit solo capea maxAmount si la regla tiene maxAmount explícito
        // NO se usa dynamicLimit como maxAmount cuando maxAmount=null
        effectiveMaxAmount = task.dynamicLimit != null
          ? Math.min(rule.maxAmount, task.dynamicLimit)
          : rule.maxAmount;
      }

      if (effectiveMaxAmount != null) {
        // Validar maxAmount por número
        for (const num of numbersToValidate) {
          const jugadasDelNumero = context.numbers.filter(n => {
            if (n.number !== num) return false;
            if (rule.multiplierId) {
              if (rule.multiplier?.kind === 'REVENTADO') {
                return n.type === 'REVENTADO';
              }
              return n.multiplierId === rule.multiplierId;
            }
            return true;
          });
          const sumForNumber = jugadasDelNumero.reduce((acc, j) => acc + j.amountForNumber, 0);

          if (sumForNumber > effectiveMaxAmount) {
            const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
            const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
            const multiplierContext = rule.multiplierId ? ` (multiplicador: ${rule.multiplier?.name || '...'})` : '';
            const available = Math.max(0, effectiveMaxAmount - sumForNumber);

            logger.warn({
              layer: 'repository',
              action: 'MAXAMOUNT_EXCEEDED',
              payload: {
                number: num,
                multiplierContext,
                isAutoDate: rule.isAutoDate,
                amountAttempted: sumForNumber,
                maxAmount: effectiveMaxAmount,
                available,
                ruleId: rule.id,
                sorteoId: context.sorteoId,
              },
            });

            //  `El número ${num}${multiplierContext}${isAutoDatePrefix}: Límite máximo: ₡${effectiveMaxAmount.toFixed(2)}. Disponible: ₡${available.toFixed(2)}`,
            throw new AppError(
              `El número ${num}${multiplierContext}${isAutoDatePrefix}: Disponible: ₡${available.toFixed(2)}`,
              400,
              {
                code: "NUMBER_MAXAMOUNT_EXCEEDED",
                number: num,
                maxAmount: effectiveMaxAmount,
                amountAttempted: sumForNumber,
                scope: ruleScope,
                isAutoDate: rule.isAutoDate,
                isDynamic: task.dynamicLimit != null,
                multiplierName: rule.multiplier?.name || undefined,
                isPerNumber: true,
                isPerTicket: true,
                clarification: 'Límite calculado por número individual en este ticket, no acumulado ni por total del ticket',
              }
            );
          }
        }
      }

      if (rule.maxTotal != null || task.dynamicLimit != null) {
        const effectiveMaxTotal = task.dynamicLimit ?? rule.maxTotal ?? Infinity;

        const numbersToCheck = numbersToValidate.map(num => {
          const matchingJugadas = context.numbers.filter(n => {
            if (n.number !== num) return false;
            if (rule.multiplierId) {
              if (rule.multiplier?.kind === 'REVENTADO') {
                return n.type === 'REVENTADO';
              }
              return n.multiplierId === rule.multiplierId;
            }
            return true;
          });
          const amount = matchingJugadas.reduce((sum, j) => sum + j.amountForNumber, 0);
          return { number: num, amountForNumber: amount };
        }).filter(n => n.amountForNumber > 0);

        if (numbersToCheck.length > 0) {
          const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
          await validateMaxTotalForNumbers(tx, {
            numbers: numbersToCheck,
            rule: { ...rule, maxTotal: effectiveMaxTotal },
            sorteoId: context.sorteoId,
            dynamicLimit: task.dynamicLimit,
            multiplierFilter,
            cache: context.cache,
            vendedorId: context.vendedorId, //  AHORA SÍ PASA
          });
        }
      }
    } else {
      // Case 2: Global rule (no numbers)
      const uniqueNumbers = [...new Set(context.numbers.map(n => n.number))];

      let effectiveMaxAmount: number | null = null;
      if (rule.maxAmount != null) {
        // dynamicLimit solo capea maxAmount si la regla tiene maxAmount explícito
        // NO se usa dynamicLimit como maxAmount cuando maxAmount=null
        effectiveMaxAmount = task.dynamicLimit != null
          ? Math.min(rule.maxAmount, task.dynamicLimit)
          : rule.maxAmount;
      }

      if (effectiveMaxAmount != null) {
        for (const num of uniqueNumbers) {
          const jugadasDelNumero = context.numbers.filter(n => {
            if (n.number !== num) return false;
            if (rule.multiplierId) {
              if (rule.multiplier?.kind === 'REVENTADO') {
                return n.type === 'REVENTADO';
              }
              return n.multiplierId === rule.multiplierId;
            }
            return true;
          });
          const sumForNumber = jugadasDelNumero.reduce((acc, j) => acc + j.amountForNumber, 0);

          if (sumForNumber > effectiveMaxAmount) {
            const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
            const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
            const available = Math.max(0, effectiveMaxAmount - sumForNumber);

            logger.warn({
              layer: 'repository',
              action: 'MAXAMOUNT_EXCEEDED',
              payload: {
                number: num,
                isAutoDate: rule.isAutoDate,
                amountAttempted: sumForNumber,
                maxAmount: effectiveMaxAmount,
                available,
                ruleId: rule.id,
                sorteoId: context.sorteoId,
              },
            });

            // Límite máximo: ₡${effectiveMaxAmount.toFixed(2)}.
            throw new AppError(
              `El número ${num}${isAutoDatePrefix}: Disponible: ₡${available.toFixed(2)}`,
              400,
              {
                code: "NUMBER_MAXAMOUNT_EXCEEDED",
                number: num,
                maxAmount: effectiveMaxAmount,
                amountAttempted: sumForNumber,
                scope: ruleScope,
                isAutoDate: rule.isAutoDate,
                isDynamic: task.dynamicLimit != null,
                multiplierName: rule.multiplier?.name || undefined,
                isPerNumber: true,
                isPerTicket: true,
                clarification: 'Límite calculado por número individual en este ticket, no acumulado ni por total del ticket',
              }
            );
          }
        }
      }

      if (rule.maxTotal != null || task.dynamicLimit != null) {
        const effectiveMaxTotal = task.dynamicLimit ?? rule.maxTotal ?? Infinity;

        //  NUEVO: Filtrar las jugadas del ticket que aplican a ESTA regla específica
        // - Si la regla TIENE multiplierId: solo contamos jugadas de ese multiplicador.
        // - Si la regla NO tiene multiplierId: sumamos TODO lo del número (Número + Reventado).
        const numbersToCheck = uniqueNumbers.map(num => {
          const matchingJugadas = context.numbers.filter(n => {
            if (n.number !== num) return false;
            // Si la regla es específica de multiplicador, filtrar por él
            if (rule.multiplierId) {
              if (rule.multiplier?.kind === 'REVENTADO') {
                return n.type === 'REVENTADO';
              }
              return n.multiplierId === rule.multiplierId;
            }
            // Si la regla no tiene multiplicador pero pedimos "REVENTADO" (en algunos casos esto se maneja por tipo)
            // Aquí sumamos todo si la regla es de "Techo Global" del número.
            return true;
          });

          const amount = matchingJugadas.reduce((sum, j) => sum + j.amountForNumber, 0);
          return { number: num, amountForNumber: amount };
        }).filter(n => n.amountForNumber > 0);

        if (numbersToCheck.length > 0) {
          const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
          await validateMaxTotalForNumbers(tx, {
            numbers: numbersToCheck,
            rule: { ...rule, maxTotal: effectiveMaxTotal },
            sorteoId: context.sorteoId,
            vendedorId: context.vendedorId,
            multiplierFilter,
            cache: context.cache,
          });
        }
      }
    }

    const executionTime = Date.now() - startTime;
    return {
      ruleId: task.ruleId,
      success: true,
      executionTime,
      numbersValidated: numbersToValidate.length || context.numbers.length,
    };

  } catch (error) {
    const executionTime = Date.now() - startTime;
    return {
      ruleId: task.ruleId,
      success: false,
      error: error as Error,
      executionTime,
      numbersValidated: task.numbersToValidate.length || context.numbers.length,
    };
  }
}

/**
 *  VALIDA MÚLTIPLES REGLAS EN PARALELO
 *
 * Esta función reemplaza el procesamiento secuencial de reglas con un sistema paralelo
 * que puede mejorar significativamente el rendimiento en escenarios con muchas reglas.
 *
 * @param tx Transacción de Prisma
 * @param params Parámetros de validación paralela
 */
export async function validateRulesInParallel(
  tx: Prisma.TransactionClient,
  params: {
    rules: any[]; // Reglas aplicables con relaciones
    numbers: Array<{ 
      number: string; 
      amountForNumber: number; 
      type: "NUMERO" | "REVENTADO"; 
      multiplierId?: string | null 
    }>; // Números y montos granulares del ticket
    sorteoId: string;
    loteriaId: string; //  NUEVO: Para filtrar por lotería
    dynamicLimits?: Map<string, number>; // Map de ruleId -> dynamicLimit
    cache?: ScopeCache;
    vendedorId?: string | null;          // NUEVO
  }
): Promise<void> {
  const { rules, numbers, sorteoId, loteriaId, dynamicLimits = new Map(), cache, vendedorId } = params;

  if (rules.length === 0) {
    return; // Nada que validar
  }

  const startTime = Date.now();

  // Organizar tareas de validación
  const { parallelGroups } = organizeValidationTasks(rules);

  // Log removido (el repository ya registra PARALLEL_VALIDATION_START con userId)

  const allResults: ValidationResult[] = [];
  const errors: Error[] = [];

  // Ejecutar grupos en paralelo
  for (const group of parallelGroups) {
    if (group.length === 1) {
      // Grupo de una sola regla - ejecutar directamente
      const task = {
        ...group[0],
        dynamicLimit: dynamicLimits.get(group[0].ruleId) ?? null,
      };

      const result = await executeValidationTask(tx, task, { sorteoId, loteriaId, vendedorId, numbers, cache });
      allResults.push(result);

      if (!result.success && result.error) {
        errors.push(result.error);
      }
    } else {
      // Grupo paralelo - ejecutar todas las tareas concurrentemente
      const groupPromises = group.map(task => {
        const enhancedTask = {
          ...task,
          dynamicLimit: dynamicLimits.get(task.ruleId) ?? null,
        };
        return executeValidationTask(tx, enhancedTask, { sorteoId, loteriaId, vendedorId, numbers, cache });
      });

      const groupResults = await Promise.all(groupPromises);
      allResults.push(...groupResults);

      // Recopilar errores
      for (const result of groupResults) {
        if (!result.success && result.error) {
          errors.push(result.error);
        }
      }
    }
  }

  const totalTime = Date.now() - startTime;
  const successfulValidations = allResults.filter(r => r.success).length;
  const failedValidations = allResults.filter(r => !r.success).length;
  const totalValidatedNumbers = allResults.reduce((sum, r) => sum + r.numbersValidated, 0);
  const avgExecutionTime = allResults.length > 0 ? allResults.reduce((sum, r) => sum + r.executionTime, 0) / allResults.length : 0;

  if (errors.length > 0) {
    logger.debug({
      layer: 'repository',
      action: 'PARALLEL_VALIDATION_COMPLETE',
      payload: {
        sorteoId,
        reglas: rules.length,
        fallidas: failedValidations,
        tiempoMs: totalTime,
      },
    });
  }

  // Si hay errores, lanzar el primero (comportamiento backward compatible)
  if (errors.length > 0) {
    const firstError = errors[0];
    
    logger.warn({
      layer: 'repository',
      action: 'TICKET_REJECTED_BY_RESTRICTIONS',
      payload: {
        sorteoId,
        motivo: firstError.message,
        numeros: Object.fromEntries(numbers.map((n: any) => [n.number, n.amountForNumber])),
      },
    });

    throw firstError;
  }
}

/**
 * Rehidrata de forma masiva los acumulados de un sorteo en Redis desde PostgreSQL.
 * Agrupa los acumulados en memoria y ejecuta un único HSET por clave dentro de un pipeline de Redis.
 */
export async function rehydrateRedisAccumulated(sorteoId: string, tx?: Prisma.TransactionClient): Promise<void> {
  if (!isRedisAvailable()) {
    logger.warn({
      layer: "redis-rehydrate",
      action: "REHYDRATE_SKIPPED_REDIS_UNAVAILABLE",
      payload: { sorteoId },
    });
    return;
  }
  const redis = getRedisClient();
  if (!redis) return;

  logger.info({
    layer: "redis-rehydrate",
    action: "REHYDRATE_START",
    payload: { sorteoId },
  });

  const startTime = Date.now();

  try {
    const client = tx || prisma;

    // Obtener la fecha del sorteo para calcular un TTL inteligente (evitar acumulación en RAM de Redis)
    const sorteo = await client.sorteo.findUnique({
      where: { id: sorteoId },
      select: { scheduledAt: true },
    });

    let ttlSeconds = 43200; // 12 horas por defecto
    if (sorteo?.scheduledAt) {
      const msToDraw = new Date(sorteo.scheduledAt).getTime() - Date.now();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const calculatedTtl = Math.ceil((msToDraw + twoHoursMs) / 1000);
      // Mínimo de 2 horas (7,200s), máximo de 24 horas (86,400s)
      ttlSeconds = Math.max(7200, Math.min(calculatedTtl, 86400));
    }

    // 1. Obtener todos los acumulados consolidados desde la base de datos
    const result = await client.$queryRaw<
      Array<{
        number: string;
        vendedorId: string | null;
        ventanaId: string | null;
        bancaId: string | null;
        jugadaType: string;
        multiplierId: string | null;
        total: string | number;
      }>
    >(
      Prisma.sql`
        SELECT 
          j."number" as number,
          t."vendedorId" as "vendedorId",
          t."ventanaId" as "ventanaId",
          v."bancaId" as "bancaId",
          j."type" as "jugadaType",
          j."multiplierId" as "multiplierId",
          COALESCE(SUM(j.amount), 0)::numeric as total
        FROM "Ticket" t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
        INNER JOIN "Ventana" v ON v.id = t."ventanaId"
        WHERE 
          t."sorteoId" = ${sorteoId}::uuid
          AND t."status" != 'CANCELLED'
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."deletedAt" IS NULL
        GROUP BY j."number", t."vendedorId", t."ventanaId", v."bancaId", j."type", j."multiplierId"
      `
    );

    // 2. Agrupar en memoria por clave de Redis
    const redisData = new Map<string, Record<string, number>>();

    const addValue = (key: string, num: string, amount: number) => {
      let record = redisData.get(key);
      if (!record) {
        record = {};
        redisData.set(key, record);
      }
      record[num] = (record[num] || 0) + amount;
    };

    for (const row of result) {
      const amount = Number(row.total);
      const num = row.number;
      const scopes = [
        { id: row.vendedorId, type: 'USER' },
        { id: row.ventanaId, type: 'VENTANA' },
        { id: row.bancaId, type: 'BANCA' }
      ];

      for (const sc of scopes) {
        if (!sc.id) continue;

        // A. Llave general
        const genKey = `sorteo:${sorteoId}:scope:${sc.id}:acumulados`;
        addValue(genKey, num, amount);

        // B. Llave por multiplicador
        const multId = row.jugadaType === 'REVENTADO' ? 'REVENTADO' : row.multiplierId;
        if (multId) {
          const multKey = `sorteo:${sorteoId}:scope:${sc.id}:multiplier:${multId}:acumulados`;
          addValue(multKey, num, amount);
        }
      }
    }

    // 3. Escribir masivamente en Redis usando un pipeline
    const pipeline = redis.pipeline();

    // Eliminar llaves existentes del sorteo antes de rehidratar
    const keysPattern = `sorteo:${sorteoId}:scope:*`;
    const existingKeys = await redis.keys(keysPattern);
    if (existingKeys.length > 0) {
      // Eliminar el prefijo local si está configurado en ioredis (ioredis maneja prefijos automáticamente)
      // pero keys() retorna las llaves con el prefijo incluido si se consulta directo.
      // ioredis keys() remueve el prefijo de la respuesta si está configurado.
      for (const k of existingKeys) {
        pipeline.del(k);
      }
    }

    // Guardar los acumulados agrupados en lote
    for (const [key, record] of redisData.entries()) {
      const stringRecord = Object.fromEntries(
        Object.entries(record).map(([num, amt]) => [num, String(amt)])
      );
      
      // HSET masivo de pares clave-valor
      pipeline.hset(key, stringRecord);
      // TTL dinámico e inteligente
      pipeline.expire(key, ttlSeconds);
    }

    // Guardar llave de control que marca el sorteo como hidratado
    const hydratedKey = `sorteo:${sorteoId}:hydrated`;
    pipeline.set(hydratedKey, "true", "EX", ttlSeconds);

    await pipeline.exec();

    logger.info({
      layer: "redis-rehydrate",
      action: "REHYDRATE_SUCCESS",
      payload: {
        sorteoId,
        keysHydrated: redisData.size,
        durationMs: Date.now() - startTime,
      },
    });
  } catch (err: any) {
    logger.error({
      layer: "redis-rehydrate",
      action: "REHYDRATE_ERROR",
      payload: { sorteoId, error: err.message },
    });
    throw err;
  }
}

