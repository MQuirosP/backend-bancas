// src/repositories/helpers/ticket-restriction.helper.ts
import { Prisma } from "@prisma/client";
import logger from "../../core/logger";
import { getCRLocalComponents } from "../../utils/businessDate";

/**
 * Calcula los acumulados del sorteo para múltiples números y alcance en una sola query
 * ⚠️ IMPORTANTE: El acumulado es independiente por sorteo, no se mezcla entre sorteos diferentes
 * 
 * ⚡ OPTIMIZACIÓN: Calcula todos los acumulados en una sola query para mejor rendimiento
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
    sorteoId: string;           // ⚠️ CRÍTICO: Acumulado es por sorteo
  }
): Promise<Map<string, number>> {
  const { numbers, scopeType, scopeId, sorteoId } = params;
  
  // Si no hay números, retornar map vacío
  if (numbers.length === 0) {
    return new Map();
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
    
    // ⚡ OPTIMIZACIÓN: Query SQL que calcula todos los acumulados en una sola consulta
    // ✅ SEGURIDAD: Validar números antes de usar (ya validados por resolveNumbersToValidate)
    // Construir condiciones OR para cada número (más seguro que ANY con raw)
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
        Prisma.sql`(j."number" = ${num} AND j."type" = 'NUMERO')`
      );
      numberConditions.push(
        Prisma.sql`(j."reventadoNumber" = ${num} AND j."type" = 'REVENTADO')`
      );
    }
    
    // Si no hay condiciones válidas, retornar map vacío
    if (numberConditions.length === 0) {
      return new Map();
    }
    
    const result = await tx.$queryRaw<Array<{ number: string; total: number }>>(
      Prisma.sql`
        SELECT 
          COALESCE(j."number", j."reventadoNumber") as number,
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
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND (${Prisma.join(numberConditions, ' OR ')})
        GROUP BY COALESCE(j."number", j."reventadoNumber")
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
        numbers,
        scopeType,
        scopeId,
        sorteoId,
        accumulatedMap: Object.fromEntries(accumulatedMap),
      },
    });
    
    return accumulatedMap;
  } catch (error: any) {
    logger.error({
      layer: 'repository',
      action: 'ACCUMULATED_BY_NUMBERS_SCOPE_ERROR',
      payload: {
        numbers,
        scopeType,
        scopeId,
        sorteoId,
        error: error.message,
        stack: error.stack,
      },
    });
    throw error;
  }
}

/**
 * Calcula el acumulado del sorteo para un número específico y alcance
 * ⚠️ IMPORTANTE: El acumulado es independiente por sorteo, no se mezcla entre sorteos diferentes
 * 
 * ⚡ OPTIMIZACIÓN: Usa calculateAccumulatedByNumbersAndScope internamente para mejor rendimiento
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
    sorteoId: string;           // ⚠️ CRÍTICO: Acumulado es por sorteo
  }
): Promise<number> {
  // ⚡ OPTIMIZACIÓN: Usar función optimizada que calcula múltiples números en una query
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: [params.number],
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    sorteoId: params.sorteoId,
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
 * ⚡ OPTIMIZACIÓN: Calcula todos los acumulados en una sola query
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
    };
    sorteoId: string;
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
  }
): Promise<void> {
  const { numbers, rule, sorteoId, dynamicLimit } = params;
  
  // Si no hay números, no validar
  if (numbers.length === 0) {
    return;
  }
  
  // Determinar alcance
  const scopeType = rule.userId ? 'USER' 
    : rule.ventanaId ? 'VENTANA' 
    : rule.bancaId ? 'BANCA' 
    : null;
  
  if (!scopeType) {
    // Sin alcance específico: no validar (fallback a comportamiento legacy)
    logger.debug({
      layer: 'repository',
      action: 'MAXTOTAL_VALIDATION_SKIPPED_NO_SCOPE',
      payload: { numbers: numbers.map(n => n.number), ruleId: rule },
    });
    return;
  }
  
  const scopeId = rule.userId || rule.ventanaId || rule.bancaId!;
  
  // Calcular límite efectivo (considerar límite dinámico si existe)
  const staticMaxTotal = rule.maxTotal;
  const effectiveMaxTotal = dynamicLimit != null
    ? Math.min(staticMaxTotal, dynamicLimit)
    : staticMaxTotal;
  
  // ⚡ OPTIMIZACIÓN: Calcular todos los acumulados en una sola query
  const numberStrings = numbers.map(n => n.number);
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: numberStrings,
    scopeType,
    scopeId,
    sorteoId,
  });
  
  // Validar cada número
  for (const { number, amountForNumber } of numbers) {
    const accumulatedInSorteo = accumulatedMap.get(number) ?? 0;
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
          number,
          scopeType,
          scopeId,
          scopeLabel,
          sorteoId,
          accumulatedInSorteo,
          amountForNumber,
          newAccumulated,
          effectiveMaxTotal,
          staticMaxTotal,
          dynamicLimit,
          available,
          isAutoDate: rule.isAutoDate,
        },
      });
      
      throw new Error(
        `El número ${number} excede el límite ${scopeLabel} en este sorteo${isAutoDateLabel}: ₡${newAccumulated.toFixed(2)} supera ₡${effectiveMaxTotal.toFixed(2)}. Disponible: ₡${available.toFixed(2)}`
      );
    }
    
    logger.debug({
      layer: 'repository',
      action: 'MAXTOTAL_VALIDATION_PASSED',
      payload: {
        number,
        scopeType,
        scopeId,
        sorteoId,
        accumulatedInSorteo,
        amountForNumber,
        newAccumulated,
        effectiveMaxTotal,
      },
    });
  }
}

/**
 * Valida maxTotal para un número específico contra el acumulado del sorteo
 * ⚡ OPTIMIZACIÓN: Usa validateMaxTotalForNumbers internamente
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
    };
    sorteoId: string;
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
  }
): Promise<void> {
  return validateMaxTotalForNumbers(tx, {
    numbers: [{ number: params.number, amountForNumber: params.amountForNumber }],
    rule: params.rule,
    sorteoId: params.sorteoId,
    dynamicLimit: params.dynamicLimit,
  });
}

