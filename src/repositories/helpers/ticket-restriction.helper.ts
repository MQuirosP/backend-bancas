// src/repositories/helpers/ticket-restriction.helper.ts
import { Prisma } from "@prisma/client";
import logger from "../../core/logger";
import { AppError } from "../../core/errors";
import { getCRLocalComponents } from "../../utils/businessDate";
import { restrictionCacheV2 } from "../../utils/restrictionCacheV2";

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
    multiplierFilter?: {        //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
  }
): Promise<Map<string, number>> {
  const { numbers, scopeType, scopeId, sorteoId, multiplierFilter } = params;

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

    //  OPTIMIZACIÓN: Query SQL que calcula todos los acumulados en una sola consulta
    //  SEGURIDAD: Validar números antes de usar (ya validados por resolveNumbersToValidate)
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
          AND t."isActive" = true  --  Exclusivo activos
          AND t."deletedAt" IS NULL
          AND j."isActive" = true  --  Exclusivo activas
          AND j."deletedAt" IS NULL
          ${multiplierCondition}   --  Inyectar filtro de multiplicador
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
        multiplierFilter,
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
        multiplierFilter,
        error: error.message,
        stack: error.stack,
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
  }
): Promise<number> {
  //  OPTIMIZACIÓN: Usar función optimizada que calcula múltiples números en una query
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: [params.number],
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    sorteoId: params.sorteoId,
    multiplierFilter: params.multiplierFilter,
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
    };
    sorteoId: string;
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
    multiplierFilter?: {          //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
  }
): Promise<void> {
  const { numbers, rule, sorteoId, dynamicLimit, multiplierFilter } = params;

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

  //  OPTIMIZACIÓN: Calcular todos los acumulados en una sola query
  const numberStrings = numbers.map(n => n.number);
  const accumulatedMap = await calculateAccumulatedByNumbersAndScope(tx, {
    numbers: numberStrings,
    scopeType,
    scopeId,
    sorteoId,
    multiplierFilter, //  Pasar filtro al cálculo
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
    if (!Number.isFinite(effectiveMaxTotal) || effectiveMaxTotal <= 0) {
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
          multiplierFilter,
          accumulatedInSorteo, //  Acumulado SOLO de este número
          amountForNumber, //  Monto SOLO de este número en el ticket
          newAccumulated, //  Nuevo acumulado SOLO de este número
          effectiveMaxTotal, //  Límite SOLO para este número
          staticMaxTotal,
          dynamicLimit,
          available,
          isAutoDate: rule.isAutoDate,
          //  CRÍTICO: Aclarar que estos valores son por número individual, no por total del ticket
          clarification: 'Todos los valores son por número individual, no por total del ticket',
        },
      });

      //  CRÍTICO: Mensaje claro - maxTotal es acumulado por número individual en el sorteo, NO por total del ticket
      throw new AppError(
        `El número ${number}${isAutoDateLabel}: Límite máximo: ₡${effectiveMaxTotal.toFixed(2)}. Disponible: ₡${available.toFixed(2)}`,
        400,
        {
          code: "NUMBER_MAXTOTAL_EXCEEDED",
          number,
          scopeType,
          scope: scopeLabel, //  Frontend espera 'scope' además de 'scopeLabel'
          scopeLabel,
          sorteoId,
          accumulatedInSorteo, //  "usado" = acumulado previo SOLO de este número en el sorteo
          amountForNumber, //  "intento" = monto SOLO de este número en el ticket actual
          newAccumulated, //  Nuevo acumulado SOLO de este número
          effectiveMaxTotal, //  "tope" = límite máximo SOLO para este número
          available,
          isAutoDate: rule.isAutoDate,
          //  CRÍTICO: Aclarar en el meta que es por número individual, NO por total del ticket
          isPerNumber: true,
          isAccumulated: true, //  Aclarar que es acumulado (maxTotal), no por ticket (maxAmount)
          clarification: 'Límite acumulado calculado por número individual en el sorteo, NO por total del ticket',
        }
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
        multiplierFilter,
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
    };
    sorteoId: string;
    dynamicLimit?: number | null; // Límite dinámico calculado (opcional)
    multiplierFilter?: {          //  NUEVO: Filtro por multiplicador
      id: string;
      kind: 'NUMERO' | 'REVENTADO';
    } | null;
  }
): Promise<void> {
  return validateMaxTotalForNumbers(tx, {
    numbers: [{ number: params.number, amountForNumber: params.amountForNumber }],
    rule: params.rule,
    sorteoId: params.sorteoId,
    dynamicLimit: params.dynamicLimit,
    multiplierFilter: params.multiplierFilter,
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
    numbers: Array<{ number: string; amountForNumber: number }>;
  }
): Promise<ValidationResult> {
  const startTime = Date.now();

  try {
    const { rule, numbersToValidate } = task;

    if (numbersToValidate.length > 0) {
      // Case 1: Specific numbers in rule
      let effectiveMaxAmount: number | null = null;
      if (rule.maxAmount != null || task.dynamicLimit != null) {
        const staticMaxAmount = rule.maxAmount ?? Infinity;
        effectiveMaxAmount = task.dynamicLimit != null
          ? Math.min(staticMaxAmount, task.dynamicLimit)
          : staticMaxAmount;
      }

      if (effectiveMaxAmount != null) {
        // Validar maxAmount por número
        for (const num of numbersToValidate) {
          const jugadasDelNumero = context.numbers.filter(n => n.number === num);
          const sumForNumber = jugadasDelNumero.reduce((acc, j) => acc + j.amountForNumber, 0);

          if (sumForNumber > effectiveMaxAmount) {
            const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
            const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
            const multiplierContext = rule.multiplierId ? ` (multiplicador: ${rule.multiplier?.name || '...'})` : '';
            const available = Math.max(0, effectiveMaxAmount - sumForNumber);

            throw new AppError(
              `El número ${num}${multiplierContext}${isAutoDatePrefix}: Límite máximo: ₡${effectiveMaxAmount.toFixed(2)}. Disponible: ₡${available.toFixed(2)}`,
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
        const staticMaxTotal = rule.maxTotal ?? Infinity;
        const effectiveMaxTotal = task.dynamicLimit != null ? Math.min(staticMaxTotal, task.dynamicLimit) : staticMaxTotal;

        const numbersToCheck = numbersToValidate.map(num => {
          const amount = context.numbers.find(n => n.number === num)?.amountForNumber || 0;
          return { number: num, amountForNumber: amount };
        }).filter(n => n.amountForNumber > 0);

        if (numbersToCheck.length > 0) {
          const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
          await validateMaxTotalForNumbers(tx, {
            numbers: numbersToCheck,
            rule: { ...rule, maxTotal: effectiveMaxTotal },
            sorteoId: context.sorteoId,
            dynamicLimit: task.dynamicLimit,
            multiplierFilter
          });
        }
      }
    } else {
      // Case 2: Global rule (no numbers)
      const uniqueNumbers = [...new Set(context.numbers.map(n => n.number))];

      let effectiveMaxAmount: number | null = null;
      if (rule.maxAmount != null || task.dynamicLimit != null) {
        const staticMaxAmount = rule.maxAmount ?? Infinity;
        effectiveMaxAmount = task.dynamicLimit != null ? Math.min(staticMaxAmount, task.dynamicLimit) : staticMaxAmount;
      }

      if (effectiveMaxAmount != null) {
        for (const num of uniqueNumbers) {
          const jugadasDelNumero = context.numbers.filter(n => n.number === num);
          const sumForNumber = jugadasDelNumero.reduce((acc, j) => acc + j.amountForNumber, 0);

          if (sumForNumber > effectiveMaxAmount) {
            const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
            const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
            const available = Math.max(0, effectiveMaxAmount - sumForNumber);

            throw new AppError(
              `El número ${num}${isAutoDatePrefix}: Límite máximo: ₡${effectiveMaxAmount.toFixed(2)}. Disponible: ₡${available.toFixed(2)}`,
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
        const staticMaxTotal = rule.maxTotal ?? Infinity;
        const effectiveMaxTotal = task.dynamicLimit != null ? Math.min(staticMaxTotal, task.dynamicLimit) : staticMaxTotal;

        const numbersToCheck = uniqueNumbers.map(num => {
          const amount = context.numbers.find(n => n.number === num)?.amountForNumber || 0;
          return { number: num, amountForNumber: amount };
        }).filter(n => n.amountForNumber > 0);

        if (numbersToCheck.length > 0) {
          const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
          await validateMaxTotalForNumbers(tx, {
            numbers: numbersToCheck,
            rule: { ...rule, maxTotal: effectiveMaxTotal },
            sorteoId: context.sorteoId,
            dynamicLimit: task.dynamicLimit,
            multiplierFilter
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
    numbers: Array<{ number: string; amountForNumber: number }>; // Números y montos del ticket
    sorteoId: string;
    dynamicLimits?: Map<string, number>; // Map de ruleId -> dynamicLimit
  }
): Promise<void> {
  const { rules, numbers, sorteoId, dynamicLimits = new Map() } = params;

  if (rules.length === 0) {
    return; // Nada que validar
  }

  const startTime = Date.now();

  // Organizar tareas de validación
  const { parallelGroups } = organizeValidationTasks(rules);

  logger.info({
    layer: 'repository',
    action: 'PARALLEL_VALIDATION_START',
    payload: {
      totalRules: rules.length,
      parallelGroups: parallelGroups.length,
      totalNumbers: numbers.length,
      sorteoId,
    },
  });

  const allResults: ValidationResult[] = [];
  const errors: Error[] = [];

  // Ejecutar grupos en paralelo
  for (const group of parallelGroups) {
    if (group.length === 1) {
      // Grupo de una sola regla - ejecutar directamente
      const task = {
        ...group[0],
        dynamicLimit: dynamicLimits.get(group[0].ruleId) || null,
      };

      const result = await executeValidationTask(tx, task, { sorteoId, numbers });
      allResults.push(result);

      if (!result.success && result.error) {
        errors.push(result.error);
      }
    } else {
      // Grupo paralelo - ejecutar todas las tareas concurrentemente
      const groupPromises = group.map(task => {
        const enhancedTask = {
          ...task,
          dynamicLimit: dynamicLimits.get(task.ruleId) || null,
        };
        return executeValidationTask(tx, enhancedTask, { sorteoId, numbers });
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

  logger.info({
    layer: 'repository',
    action: 'PARALLEL_VALIDATION_COMPLETE',
    payload: {
      totalRules: rules.length,
      parallelGroups: parallelGroups.length,
      successfulValidations,
      failedValidations,
      totalValidatedNumbers,
      totalTime,
      avgExecutionTime: Math.round(avgExecutionTime),
      errorsCount: errors.length,
      sorteoId,
    },
  });

  // Si hay errores, lanzar el primero (comportamiento backward compatible)
  if (errors.length > 0) {
    throw errors[0];
  }
}

