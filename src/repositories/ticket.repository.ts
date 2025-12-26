import prisma from "../core/prismaClient";
import { Prisma, TicketStatus, Role } from "@prisma/client";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { withTransactionRetry } from "../core/withTransactionRetry";
import { CommissionSnapshot } from "../services/commission/types/CommissionTypes";
import { CommissionContext } from "../services/commission/types/CommissionContext";
import { commissionService } from "../services/commission/CommissionService";
import { commissionResolver } from "../services/commission/CommissionResolver";
import { getBusinessDateCRInfo, getCRDayRangeUTC } from "../utils/businessDate";
import { nowCR, validateDate, formatDateCRWithTZ } from "../utils/datetime";
import { resolveNumbersToValidate, validateMaxTotalForNumbers } from "./helpers/ticket-restriction.helper";

/**
 * Calcula el límite dinámico basado en baseAmount y salesPercentage
 * Obtiene las ventas del SORTEO dentro de la transacción
 * 
 * ⚠️ IMPORTANTE: Este cálculo se hace sobre ventas BRUTAS del sorteo.
 * - Excluye tickets CANCELLED y EXCLUDED del cálculo
 * - NO excluye jugadas individuales con isExcluded=true (aún no procesadas en este momento)
 * - Los límites dinámicos NO se recalculan automáticamente cuando se excluyen jugadas después
 * 
 * Comportamiento:
 * - El límite se calcula una vez al momento de crear el ticket
 * - Se basa en ventas del sorteo en ese instante
 * - Si después se excluyen jugadas (SorteoListaExclusion), el límite NO se recalcula
 * 
 * Justificación:
 * - Las exclusiones se aplican DESPUÉS de crear el ticket (proceso asíncrono)
 * - Recalcular límites dinámicos después de exclusiones requeriría:
 *   1. Trigger después de cada exclusión
 *   2. Validación retroactiva de tickets ya creados
 *   3. Complejidad adicional sin beneficio claro
 * 
 * ✅ CRÍTICO: Calcula sobre ventas del sorteo específico, no del día completo
 * 
 * @param tx Transacción de Prisma
 * @param rule Regla con baseAmount y/o salesPercentage
 * @param context Contexto del ticket (sorteoId, userId, ventanaId, etc.)
 * @returns Límite dinámico calculado (siempre >= 0)
 */
async function calculateDynamicLimit(
  tx: Prisma.TransactionClient,
  rule: {
    baseAmount?: number | null;
    salesPercentage?: number | null;
    appliesToVendedor?: boolean | null;
  },
  context: {
    userId: string;
    ventanaId: string;
    bancaId: string;
    sorteoId: string;  // ✅ NUEVO: sorteoId requerido para calcular sobre el sorteo
    at: Date;
  }
): Promise<number> {
  let dynamicLimit = 0;

  // ✅ VALIDACIÓN: baseAmount no puede ser negativo
  if (rule.baseAmount != null && rule.baseAmount < 0) {
    logger.warn({
      layer: 'repository',
      action: 'INVALID_BASE_AMOUNT',
      payload: {
        baseAmount: rule.baseAmount,
        sorteoId: context.sorteoId,
        message: 'baseAmount negativo detectado, usando 0 como fallback',
      },
    });
  }

  // Monto base
  if (rule.baseAmount != null && rule.baseAmount > 0) {
    dynamicLimit += rule.baseAmount;
  }

  // ✅ VALIDACIÓN: salesPercentage debe estar entre 0 y 100
  if (rule.salesPercentage != null && (rule.salesPercentage < 0 || rule.salesPercentage > 100)) {
    logger.warn({
      layer: 'repository',
      action: 'INVALID_SALES_PERCENTAGE',
      payload: {
        salesPercentage: rule.salesPercentage,
        sorteoId: context.sorteoId,
        message: 'salesPercentage fuera de rango válido (0-100), ignorando porcentaje',
      },
    });
  }

  // Porcentaje de ventas (solo si salesPercentage es válido)
  if (rule.salesPercentage != null && rule.salesPercentage > 0 && rule.salesPercentage <= 100) {
    // ✅ CRÍTICO: Calcular sobre ventas DEL SORTEO, no del día completo
    const where: Prisma.TicketWhereInput = {
      deletedAt: null,
      isActive: true,
      status: { notIn: [TicketStatus.CANCELLED, TicketStatus.EXCLUDED] },
      sorteoId: context.sorteoId,  // ✅ CRÍTICO: Filtrar por sorteo específico
    };

    if (rule.appliesToVendedor) {
      // Por vendedor individual
      where.vendedorId = context.userId;
    } else {
      // Por ventana o banca (global)
      where.ventanaId = context.ventanaId;
    }

    // Calcular ventas del sorteo
    const result = await tx.ticket.aggregate({
      _sum: { totalAmount: true },
      where,
    });

    const sorteoSales = Number(result._sum.totalAmount) || 0;
    const percentageAmount = (sorteoSales * rule.salesPercentage) / 100;
    dynamicLimit += percentageAmount;

    logger.debug({
      layer: 'repository',
      action: 'DYNAMIC_LIMIT_CALCULATED',
      payload: {
        sorteoId: context.sorteoId,
        sorteoSales,
        salesPercentage: rule.salesPercentage,
        baseAmount: rule.baseAmount,
        percentageAmount,
        dynamicLimit,
        appliesToVendedor: rule.appliesToVendedor,
        // ✅ AGREGAR: Información sobre exclusión de tickets
        excludedTicketStatuses: ['CANCELLED', 'EXCLUDED'],
        calculationNote: 'Calculated on gross sales (before individual jugada exclusions)',
      },
    });
  }

  // ✅ VALIDACIÓN: Asegurar que el límite dinámico nunca sea negativo
  return Math.max(0, dynamicLimit);
}

type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  totalAmount?: number; // ignorado; el backend calcula el total
  clienteNombre?: string | null; // nombre del cliente (opcional)
  jugadas: Array<{
    type: "NUMERO" | "REVENTADO";
    number: string;
    reventadoNumber?: string | null; // requerido si type=REVENTADO (igual a number)
    amount: number;
    multiplierId?: string; // resuelto en repo para NUMERO; placeholder para REVENTADO
    finalMultiplierX?: number; // resuelto en repo para NUMERO; 0 para REVENTADO
  }>;
};

type TicketWarning = {
  code: "LOTTERY_MULTIPLIER_RESTRICTED";
  restrictedButAllowed: boolean;
  ruleId: string;
  scope: "USER" | "VENTANA" | "BANCA";
  loteriaId: string;
  loteriaName?: string | null;
  multiplierId: string;
  multiplierName?: string | null;
  message: string;
};

type RestrictionRuleWithRelations = Prisma.RestrictionRuleGetPayload<{
  include: { loteria: true; multiplier: true };
}>;

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Calcula el score de prioridad de una regla de restricción
 * Orden de prioridad: USER > VENTANA > BANCA
 * Bonus por número específico y reglas de lotería/multiplicador
 */
function calculatePriorityScore(rule: RestrictionRuleWithRelations): number {
  let score = 0;
  if (rule.bancaId) score += 1;
  if (rule.ventanaId) score += 10;
  if (rule.userId) score += 100;
  if (rule.number) score += 1000;
  // Prioridad máxima a reglas específicas de lotería/multiplicador
  if (rule.loteriaId && rule.multiplierId) score += 10000;
  return score;
}

// ────────────────────────────────────────────────────────────────────────────────
// Resolución de multiplicador Base (robusta + fallback)
// ────────────────────────────────────────────────────────────────────────────────

async function resolveBaseMultiplierX(
  tx: Prisma.TransactionClient,
  args: {
    bancaId: string;
    loteriaId: string;
    userId: string;
    ventanaId: string;
  }
): Promise<{ valueX: number; source: string }> {
  const { bancaId, loteriaId, userId, ventanaId } = args;

  // ✅ OPTIMIZACIÓN: Ejecutar TODAS las consultas en paralelo
  // Reducción de tiempo: 150-300ms → 50-80ms
  const [userOverride, ventanaOverride, bls, lmBase, lmNumero, lot] = await Promise.all([
    // 0) Override por usuario (directo en X) - HIGHEST PRIORITY
    tx.multiplierOverride.findFirst({
      where: {
        scope: "USER",
        userId,
        loteriaId,
        multiplierType: "NUMERO",
        isActive: true,
      },
      select: { baseMultiplierX: true },
    }),
    // 0.5) Override por ventana - SECOND PRIORITY
    tx.multiplierOverride.findFirst({
      where: {
        scope: "VENTANA",
        ventanaId,
        loteriaId,
        multiplierType: "NUMERO",
        isActive: true,
      },
      select: { baseMultiplierX: true },
    }),
    // 1) Config por banca/lotería
    tx.bancaLoteriaSetting.findUnique({
      where: { bancaId_loteriaId: { bancaId, loteriaId } },
      select: { baseMultiplierX: true },
    }),
    // 2) Multiplicador de la Lotería (tabla loteriaMultiplier) - Base
    tx.loteriaMultiplier.findFirst({
      where: { loteriaId, isActive: true, name: "Base" },
      select: { valueX: true },
    }),
    // 2) Multiplicador de la Lotería (tabla loteriaMultiplier) - NUMERO
    tx.loteriaMultiplier.findFirst({
      where: { loteriaId, isActive: true, kind: "NUMERO" },
      orderBy: { createdAt: "asc" },
      select: { valueX: true, name: true },
    }),
    // 3) Fallback: rulesJson en Lotería
    tx.loteria.findUnique({
      where: { id: loteriaId },
      select: { rulesJson: true },
    }),
  ]);

  // Evaluar resultados en orden de prioridad
  if (typeof userOverride?.baseMultiplierX === "number") {
    return {
      valueX: userOverride.baseMultiplierX,
      source: "multiplierOverride[scope=USER]",
    };
  }

  if (typeof ventanaOverride?.baseMultiplierX === "number") {
    return {
      valueX: ventanaOverride.baseMultiplierX,
      source: "multiplierOverride[scope=VENTANA]",
    };
  }

  if (typeof bls?.baseMultiplierX === "number") {
    return {
      valueX: bls.baseMultiplierX,
      source: "bancaLoteriaSetting.baseMultiplierX",
    };
  }

  if (typeof lmBase?.valueX === "number" && lmBase.valueX > 0) {
    return { valueX: lmBase.valueX, source: "loteriaMultiplier[name=Base]" };
  }

  if (typeof lmNumero?.valueX === "number" && lmNumero.valueX > 0) {
    return {
      valueX: lmNumero.valueX,
      source: `loteriaMultiplier[kind=NUMERO,name=${lmNumero.name ?? ""}]`,
    };
  }

  const rulesX = (lot?.rulesJson as any)?.baseMultiplierX;
  if (typeof rulesX === "number" && rulesX > 0) {
    return { valueX: rulesX, source: "loteria.rulesJson.baseMultiplierX" };
  }

  // 4) Fallback global por env
  const def = Number(process.env.MULTIPLIER_BASE_DEFAULT_X ?? 0);
  if (def > 0) {
    return { valueX: def, source: "env.MULTIPLIER_BASE_DEFAULT_X" };
  }

  throw new AppError(
    `Missing baseMultiplierX for bancaId=${bancaId} & loteriaId=${loteriaId}`,
    400
  );
}

// Garantiza que exista un multiplicador "Base" (para linkear en jugadas NUMERO)
async function ensureBaseMultiplierRow(
  tx: Prisma.TransactionClient,
  loteriaId: string
): Promise<{ id: string; valueX: number }> {
  const existing = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, name: "Base" },
    select: { id: true, valueX: true },
  });
  if (existing && typeof existing.valueX === "number" && existing.valueX > 0) {
    return { id: existing.id, valueX: existing.valueX };
  }

  throw new AppError(
    `No existe un multiplicador Base activo. Crea uno manualmente para la lotería ${loteriaId}.`,
    500,
    "BASE_MULTIPLIER_MISSING"
  );
}

// ────────────────────────────────────────────────────────────────────────────────

export const TicketRepository = {
  async create(
    data: CreateTicketInput,
    userId: string,
    options?: { actorRole?: Role; createdBy?: string; createdByRole?: Role }
  ) {
    const { loteriaId, sorteoId, ventanaId, jugadas, clienteNombre } = data;
    const actorRole = options?.actorRole ?? Role.VENDEDOR;

    // Toda la operación dentro de una transacción con retry y timeouts explícitos

    const { ticket, warnings } = await withTransactionRetry(
      async (tx) => {
        const warnings: TicketWarning[] = [];
        const warningRuleIds = new Set<string>();

        // 1) Generación de businessDate CR y folio prefijado por 'TYYMMDD'
        const nowUtc = new Date();
        const cutoffHour = (process.env.BUSINESS_CUTOFF_HOUR_CR || '00:00').trim();

        // 2) Validación de FKs + reglas de la lotería + políticas de comisión
        const [loteria, sorteo, ventana, user] = await Promise.all([
          tx.loteria.findUnique({
            where: { id: loteriaId },
            select: { id: true, name: true, isActive: true, rulesJson: true },
          }),
          tx.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true, status: true, loteriaId: true, scheduledAt: true },
          }),
          tx.ventana.findUnique({
            where: { id: ventanaId },
            select: {
              id: true,
              bancaId: true,
              commissionPolicyJson: true,
              banca: {
                select: {
                  id: true,
                  commissionPolicyJson: true,
                },
              },
              // ✅ OPTIMIZACIÓN: Incluir usuario ventana (listero) en consulta inicial
              // Elimina consulta separada posterior (50-100ms ahorrados)
              users: {
                where: {
                  role: Role.VENTANA,
                  isActive: true,
                  deletedAt: null,
                },
                select: {
                  id: true,
                  commissionPolicyJson: true,
                },
                orderBy: { updatedAt: "desc" },
                take: 1,
              },
            },
          }),
          tx.user.findUnique({
            where: { id: userId },
            select: { id: true, commissionPolicyJson: true },
          }),
        ]);

        if (!user)
          throw new AppError(
            "Seller (vendedor) not found",
            404,
            "FK_VIOLATION"
          );
        if (!loteria || loteria.isActive === false)
          throw new AppError("Lotería not found", 404, "FK_VIOLATION");
        if (!sorteo)
          throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
        if (!ventana)
          throw new AppError("Ventana not found", 404, "FK_VIOLATION");

        // Defensa: el sorteo debe pertenecer a la misma lotería
        if (sorteo.loteriaId !== loteriaId) {
          throw new AppError(
            "El sorteo no pertenece a la lotería indicada",
            400,
            "SORTEO_LOTERIA_MISMATCH"
          );
        }

        const loteriaName = loteria.name ?? null;

        // 2) Determinar businessDate CR priorizando sorteo.scheduledAt (fallback por cutoff)
        const bd = getBusinessDateCRInfo({ scheduledAt: sorteo.scheduledAt, nowUtc, cutoffHour });

        // 2.1) Incrementar contador diario por (businessDate, ventanaId) y obtener secuencia
        // Usar upsert atómico con bloqueo de fila para prevenir race conditions
        let nextNumber: string = '';
        let seqForLog: number | null = null;

        try {
          // ✅ Incrementar contador atómicamente con reintento automático en caso de colisión
          // Usar loop de reintento máximo 5 veces para manejar race conditions
          let seq: number = 0;
          let attempts = 0;
          const maxAttempts = 5;

          while (attempts < maxAttempts) {
            attempts++;

            // Incrementar contador atómicamente
            const seqRows = await tx.$queryRaw<{ last: number }[]>(
              Prisma.sql`
                INSERT INTO "TicketCounter" ("businessDate", "ventanaId", "last")
                VALUES (${bd.businessDate}::date, ${ventanaId}::uuid, 1)
                ON CONFLICT ("businessDate", "ventanaId")
                DO UPDATE SET "last" = "TicketCounter"."last" + 1
                RETURNING "last";
              `
            );

            seq = (seqRows?.[0]?.last ?? 1) as number;
            const seqPadded = String(seq).padStart(5, '0');
            const candidateNumber = `T${bd.prefixYYMMDD}-${seqPadded}`;

            // Verificar que el ticketNumber no exista (doble validación)
            const existing = await tx.ticket.findUnique({
              where: { ticketNumber: candidateNumber },
              select: { id: true },
            });

            if (!existing) {
              // ✅ Número disponible - usar este
              nextNumber = candidateNumber;
              seqForLog = seq;
              break;
            }

            // Colisión detectada - registrar y reintentar
            logger.warn({
              layer: 'repository',
              action: 'TICKET_NUMBER_COLLISION_RETRY',
              payload: {
                ticketNumber: candidateNumber,
                existingId: existing.id,
                businessDate: bd.businessDate,
                ventanaId,
                sequence: seq,
                attempt: attempts,
              },
            });

            // Si es el último intento, lanzar error
            if (attempts >= maxAttempts) {
              throw new AppError(
                `No se pudo generar número de ticket único después de ${maxAttempts} intentos`,
                500,
                'TICKET_NUMBER_COLLISION'
              );
            }
          }

          logger.info({
            layer: 'repository',
            action: 'TICKET_NUMBER_GENERATED',
            payload: {
              ticketNumber: nextNumber,
              businessDate: bd.businessDate,
              sequence: seq,
            },
          });
        } catch (error: any) {
          // Error al generar número de ticket
          if (error.code === 'TICKET_NUMBER_COLLISION') {
            throw error; // Re-lanzar colisiones
          }

          // Verificar si es error de tabla inexistente
          if (error.message?.includes('TicketCounter') || error.code === '42P01') {
            logger.error({
              layer: 'repository',
              action: 'TICKET_COUNTER_TABLE_MISSING',
              payload: {
                error: error.message,
                note: 'La tabla TicketCounter no existe. Ejecutar migración 20251103121500',
              },
            });
            throw new AppError(
              'Sistema de numeración no configurado. Contacte al administrador.',
              500,
              'TICKET_COUNTER_MISSING'
            );
          }

          // Otro error
          logger.error({
            layer: 'repository',
            action: 'TICKET_NUMBER_GENERATION_ERROR',
            payload: { error: error.message },
          });
          throw new AppError(
            'Error al generar número de ticket',
            500,
            'TICKET_NUMBER_ERROR'
          );
        }

        // Asegurar que nextNumber siempre esté asignado
        if (!nextNumber) {
          throw new AppError('Failed to generate ticket number', 500, 'SEQ_ERROR');
        }

        // 3) Resolver X efectivo y asegurar fila Base
        const bancaId = ventana.bancaId;

        const { valueX: effectiveBaseX, source } = await resolveBaseMultiplierX(
          tx,
          {
            bancaId,
            loteriaId,
            userId,
            ventanaId,
          }
        );

        logger.info({
          layer: "ticket",
          action: "BASE_MULTIPLIER_RESOLVED",
          payload: { bancaId, loteriaId, userId, effectiveBaseX, source },
        });

        // 4) Rules pipeline (User > Ventana > Banca)
        const now = new Date();
        const candidateRules = await tx.restrictionRule.findMany({
          where: {
            isActive: true,
            OR: [
              { userId },
              { ventanaId },
              { bancaId },
              // ✅ Incluir reglas globales (sin scope específico) que aplican a lotería/multiplicador
              { AND: [{ userId: null }, { ventanaId: null }, { bancaId: null }] }
            ],
          },
          include: {
            loteria: true,
            multiplier: true,
          },
        });

        const applicable: RestrictionRuleWithRelations[] = candidateRules
          .filter((r) => {
            if (
              r.appliesToDate &&
              !isSameLocalDay(new Date(r.appliesToDate), now)
            )
              return false;
            if (
              typeof r.appliesToHour === "number" &&
              r.appliesToHour !== now.getHours()
            )
              return false;
            return true;
          })
          .map((r) => {
            const score = calculatePriorityScore(r);
            return { r, score };
          })
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);

        const lotteryMultiplierRules = applicable.filter(
          (rule) => rule.loteriaId && rule.multiplierId
        );

        // 5) Validaciones con rulesJson de la Lotería
        const RJ = (loteria.rulesJson ?? {}) as any;

        const allowedBetTypes = Array.isArray(RJ.allowedBetTypes)
          ? new Set<string>(RJ.allowedBetTypes)
          : null;
        const reventadoEnabled = !!RJ.reventadoConfig?.enabled;
        const requiresMatchingNumber =
          !!RJ.reventadoConfig?.requiresMatchingNumber;
        const numberRange =
          RJ.numberRange &&
            typeof RJ.numberRange.min === "number" &&
            typeof RJ.numberRange.max === "number"
            ? { min: RJ.numberRange.min, max: RJ.numberRange.max }
            : { min: 0, max: 99 };

        const minBetAmount =
          typeof RJ.minBetAmount === "number" ? RJ.minBetAmount : undefined;
        const maxBetAmount =
          typeof RJ.maxBetAmount === "number" ? RJ.maxBetAmount : undefined;
        const maxNumbersPerTicket =
          typeof RJ.maxNumbersPerTicket === "number"
            ? RJ.maxNumbersPerTicket
            : undefined;

        // a) tipos permitidos
        if (allowedBetTypes) {
          for (const j of jugadas) {
            if (!allowedBetTypes.has(j.type)) {
              throw new AppError(
                `Tipo de jugada no permitido: ${j.type}`,
                400,
                "BETTYPE_NOT_ALLOWED"
              );
            }
          }
        }

        // b) REVENTADO habilitado
        if (!reventadoEnabled) {
          const hasReventado = jugadas.some((j) => j.type === "REVENTADO");
          if (hasReventado) {
            throw new AppError(
              "REVENTADO no está habilitado para esta lotería",
              400,
              "REVENTADO_DISABLED"
            );
          }
        }

        // c) matching de número en REVENTADO (si la regla lo exige)
        if (requiresMatchingNumber) {
          for (const j of jugadas) {
            if (j.type === "REVENTADO") {
              if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
                throw new AppError(
                  "REVENTADO debe coincidir con el mismo número (number === reventadoNumber)",
                  400,
                  "REVENTADO_MATCH_REQUIRED"
                );
              }
            }
          }
        }

        // d) rango de número (respeta numberRange si es más estrecho que 00..99)
        for (const j of jugadas) {
          const num = Number(j.number);
          if (
            Number.isNaN(num) ||
            num < numberRange.min ||
            num > numberRange.max
          ) {
            throw new AppError(
              `Número fuera de rango permitido (${numberRange.min}..${numberRange.max}): ${j.number}`,
              400,
              "NUMBER_OUT_OF_RANGE"
            );
          }
        }

        // e) min/max por jugada
        for (const j of jugadas) {
          if (typeof minBetAmount === "number" && j.amount < minBetAmount) {
            throw new AppError(
              `Monto mínimo por jugada: ${minBetAmount}`,
              400,
              "BET_MIN_VIOLATION"
            );
          }
          if (typeof maxBetAmount === "number" && j.amount > maxBetAmount) {
            throw new AppError(
              `Monto máximo por jugada: ${maxBetAmount}`,
              400,
              "BET_MAX_VIOLATION"
            );
          }
        }

        // f) límite de cantidad de números por ticket (solo NUMERO, únicos)
        if (typeof maxNumbersPerTicket === "number") {
          const uniqueNumeros = new Set(
            jugadas.filter((j) => j.type === "NUMERO").map((j) => j.number)
          );
          if (uniqueNumeros.size > maxNumbersPerTicket) {
            throw new AppError(
              `Máximo de números por ticket: ${maxNumbersPerTicket}`,
              400,
              "MAX_NUMBERS_PER_TICKET"
            );
          }
        }

        // 6) Normalizar jugadas + total
        const numeroMultiplierIds = Array.from(
          new Set(
            jugadas
              .filter((j) => j.type === "NUMERO" && j.multiplierId)
              .map((j) => j.multiplierId!) // validated later
          )
        );

        const multiplierCache = new Map<
          string,
          {
            id: string;
            valueX: number;
            isActive: boolean;
            kind: "NUMERO" | "REVENTADO";
            loteriaId: string;
            name?: string | null;
          }
        >();

        if (numeroMultiplierIds.length > 0) {
          const multipliers = await tx.loteriaMultiplier.findMany({
            where: {
              id: { in: numeroMultiplierIds },
            },
            select: {
              id: true,
              name: true,
              valueX: true,
              isActive: true,
              kind: true,
              loteriaId: true,
            },
          });

          for (const m of multipliers) {
            multiplierCache.set(m.id, {
              id: m.id,
              name: m.name,
              valueX: m.valueX,
              isActive: m.isActive,
              kind: m.kind as "NUMERO" | "REVENTADO",
              loteriaId: m.loteriaId,
            });
          }
        }

        const preparedJugadas = jugadas.map((j) => {
          if (j.type === "REVENTADO") {
            if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
              throw new AppError(
                "REVENTADO must reference the same number (reventadoNumber === number)",
                400,
                "INVALID_REVENTADO_LINK"
              );
            }
            return {
              type: "REVENTADO" as const,
              number: j.number,
              reventadoNumber: j.reventadoNumber,
              amount: j.amount,
              finalMultiplierX: 0,
              multiplierId: null,
              isActive: (j as any).isActive !== false, // ✅ Preservar isActive (default true)
            };
          }
          // NUMERO
          if (!j.multiplierId) {
            throw new AppError(
              "Debe seleccionar un multiplicador para jugadas tipo NUMERO",
              400,
              "MISSING_MULTIPLIER_ID"
            );
          }
          const multiplier = multiplierCache.get(j.multiplierId);
          if (!multiplier) {
            throw new AppError(
              `Multiplicador inválido para jugada NUMERO`,
              400,
              "INVALID_MULTIPLIER"
            );
          }
          if (multiplier.kind !== "NUMERO") {
            throw new AppError(
              `Multiplicador incompatible con jugada NUMERO`,
              400,
              "INVALID_MULTIPLIER_KIND"
            );
          }
          if (multiplier.loteriaId !== loteriaId) {
            throw new AppError(
              `Multiplicador no pertenece a la lotería`,
              400,
              "INVALID_MULTIPLIER_LOTERIA"
            );
          }
          if (!multiplier.isActive) {
            throw new AppError(
              `Multiplicador inactivo`,
              400,
              "INACTIVE_MULTIPLIER"
            );
          }
          const multiplierX = multiplier.valueX;
          if (typeof multiplierX !== "number" || multiplierX <= 0) {
            throw new AppError(
              `Multiplicador con valor inválido`,
              400,
              "INVALID_MULTIPLIER_VALUE"
            );
          }

          const matchingRule = lotteryMultiplierRules.find(
            (rule) =>
              rule.loteriaId === loteriaId &&
              rule.multiplierId === j.multiplierId
          );

          if (matchingRule) {
            // ✅ NUEVO LÓGICA: Solo bloquear si NO tiene límites configurados
            // Si tiene maxAmount O maxTotal, se permite la venta (validación de límites posterior)
            const isBlockingRule = matchingRule.maxAmount == null && matchingRule.maxTotal == null;

            if (isBlockingRule) {
              const ruleScope: "USER" | "VENTANA" | "BANCA" =
                matchingRule.userId
                  ? "USER"
                  : matchingRule.ventanaId
                    ? "VENTANA"
                    : "BANCA";

              const loteriaNameForWarning =
                matchingRule.loteria?.name ?? loteriaName;
              const multiplierNameForWarning =
                multiplier.name ?? matchingRule.multiplier?.name ?? null;

              const defaultMessage = multiplier.name
                ? `El multiplicador '${multiplier.name}' está restringido para esta lotería.`
                : "El multiplicador seleccionado está restringido para esta lotería.";
              const message =
                (matchingRule.message && matchingRule.message.trim()) || defaultMessage;

              if (actorRole === Role.ADMIN) {
                if (!warningRuleIds.has(matchingRule.id)) {
                  warnings.push({
                    code: "LOTTERY_MULTIPLIER_RESTRICTED",
                    restrictedButAllowed: true,
                    ruleId: matchingRule.id,
                    scope: ruleScope,
                    loteriaId,
                    loteriaName: loteriaNameForWarning,
                    multiplierId: j.multiplierId,
                    multiplierName: multiplierNameForWarning,
                    message,
                  });
                  warningRuleIds.add(matchingRule.id);

                  logger.warn({
                    layer: 'repository',
                    action: 'RESTRICTION_MULTIPLIER_ALLOWED_ADMIN',
                    payload: {
                      restrictionType: 'LOTTERY_MULTIPLIER',
                      ruleId: matchingRule.id,
                      scope: ruleScope,
                      userId,
                      ventanaId,
                      bancaId,
                      sorteoId,
                      loteriaId,
                      loteriaName: loteriaNameForWarning,
                      multiplierId: j.multiplierId,
                      multiplierName: multiplierNameForWarning,
                      jugadaNumber: j.number,
                      jugadaAmount: j.amount,
                      actorRole: 'ADMIN',
                      message,
                      reason: 'Admin bypass - multiplier restriction waived',
                    },
                  });
                }
              } else {
                logger.warn({
                  layer: 'repository',
                  action: 'RESTRICTION_MULTIPLIER_REJECTED',
                  payload: {
                    restrictionType: 'LOTTERY_MULTIPLIER',
                    ruleId: matchingRule.id,
                    scope: ruleScope,
                    userId,
                    ventanaId,
                    bancaId,
                    sorteoId,
                    loteriaId,
                    loteriaName: loteriaNameForWarning,
                    multiplierId: j.multiplierId,
                    multiplierName: multiplierNameForWarning,
                    jugadaNumber: j.number,
                    jugadaAmount: j.amount,
                    actorRole,
                    message,
                    reason: 'Multiplier restricted for this lottery',
                  },
                });

                throw new AppError(message, 400, {
                  code: "LOTTERY_MULTIPLIER_RESTRICTED",
                  ruleId: matchingRule.id,
                  scope: ruleScope,
                  loteriaId,
                  loteriaName: loteriaNameForWarning,
                  multiplierId: j.multiplierId,
                  multiplierName: multiplierNameForWarning,
                });
              }
            }
          }

          return {
            type: "NUMERO" as const,
            number: j.number,
            reventadoNumber: null,
            amount: j.amount,
            finalMultiplierX: multiplierX, // congelado en venta
            multiplierId: j.multiplierId,
          };
        });

        const totalAmountTx = preparedJugadas.reduce(
          (acc, j) => acc + j.amount,
          0
        );

        // 7) ❌ ELIMINADO: Validación de límite diario TOTAL del vendedor
        // Los límites deben aplicarse POR NÚMERO, no por total diario del vendedor.
        // La validación correcta está más abajo (validateMaxTotalForNumbers)

        // ✅ LOGGING: Registrar todas las reglas aplicables para trazabilidad (después de preparar jugadas)
        logger.info({
          layer: 'repository',
          action: 'RESTRICTION_RULES_EVALUATION_START',
          payload: {
            ticketContext: {
              loteriaId,
              sorteoId,
              ventanaId,
              userId,
              bancaId,
              jugadasCount: preparedJugadas.length,
            },
            applicableRules: applicable.map((r, idx) => ({
              index: idx,
              ruleId: r.id,
              scope: r.userId ? 'USER' : r.ventanaId ? 'VENTANA' : r.bancaId ? 'BANCA' : 'GLOBAL',
              priority: calculatePriorityScore(r),
              hasMaxAmount: r.maxAmount != null,
              hasMaxTotal: r.maxTotal != null,
              hasDynamicLimit: (r.baseAmount != null || r.salesPercentage != null),
              number: r.number,
              isAutoDate: r.isAutoDate,
              multiplierId: r.multiplierId || null,
              loteriaId: r.loteriaId || null,
            })),
            totalRulesCount: applicable.length,
            candidateRulesCount: candidateRules.length,
          },
        });

        // 8) Aplicar TODAS las reglas aplicables de forma acumulativa (USER > VENTANA > BANCA)
        // ✅ CRÍTICO: Todas las reglas aplicables se validan, no solo la de mayor prioridad
        // ✅ CRÍTICO: maxAmount se valida por número individual por ticket
        // ✅ CRÍTICO: maxTotal se valida por número individual acumulado en el sorteo
        // ⚠️ NUNCA se valida sobre total del ticket ni sobre total diario
        for (const rule of (applicable as any[])) {
          // ✅ EFICIENCIA: Solo calcular dynamicLimit si realmente se necesita (hay maxAmount o maxTotal)
          const needsDynamicLimit = (rule.maxAmount != null || rule.maxTotal != null) &&
            ((rule.baseAmount != null && rule.baseAmount > 0) ||
             (rule.salesPercentage != null && rule.salesPercentage > 0));
          
          let dynamicLimit: number | null = null;
          if (needsDynamicLimit) {
            dynamicLimit = await calculateDynamicLimit(tx, {
              baseAmount: rule.baseAmount,
              salesPercentage: rule.salesPercentage,
              appliesToVendedor: rule.appliesToVendedor,
            }, {
              userId,
              ventanaId,
              bancaId,
              sorteoId,
              at: now,
            });
          }

          const numbersInRule = resolveNumbersToValidate(rule, now);

          if (numbersInRule.length > 0) {
            // Case 1: Specific numbers in rule
            let effectiveMaxAmount: number | null = null;
            if (rule.maxAmount != null || dynamicLimit != null) {
              const staticMaxAmount = rule.maxAmount ?? Infinity;
              effectiveMaxAmount = dynamicLimit != null ? Math.min(staticMaxAmount, dynamicLimit) : staticMaxAmount;
            }

            if (effectiveMaxAmount != null) {
              // ✅ ROBUSTEZ: Validar que effectiveMaxAmount sea un número válido
              if (!Number.isFinite(effectiveMaxAmount) || effectiveMaxAmount <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_AMOUNT',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxAmount,
                    maxAmount: rule.maxAmount,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              for (const num of numbersInRule) {
                // ✅ CRÍTICO: Calcular sumForNumber SOLO para este número específico en este ticket
                // NO debe incluir otros números ni el total del ticket
                const jugadasDelNumero = preparedJugadas.filter((j) => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  if (j.type === 'NUMERO') {
                    if (rule.multiplierId && j.multiplierId !== rule.multiplierId) return false;
                    return j.number === num;
                  } else if (j.type === 'REVENTADO') {
                    if (rule.multiplierId) {
                      // ✅ LOGGING: REVENTADO excluido de validación cuando la regla tiene multiplierId
                      logger.debug({
                        layer: 'repository',
                        action: 'REVENTADO_EXCLUDED_FROM_MULTIPLIER_RULE',
                        payload: {
                          ruleId: rule.id,
                          multiplierId: rule.multiplierId,
                          reventadoNumber: j.reventadoNumber,
                          reason: 'REVENTADO jugadas do not have multiplierId, excluded from multiplier-specific rules',
                        },
                      });
                      return false;
                    }
                    return j.reventadoNumber === num;
                  }
                  return false;
                });
                
                const sumForNumber = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amount = Number(j.amount);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amount;
                }, 0);

                // ✅ ROBUSTEZ: Validar que sumForNumber sea un número válido antes de comparar
                if (!Number.isFinite(sumForNumber)) {
                  logger.error({
                    layer: 'repository',
                    action: 'INVALID_SUM_FOR_NUMBER',
                    payload: { num, sumForNumber, ruleId: rule.id },
                  });
                  throw new AppError(
                    `Error al calcular monto del número ${num}. Contacte al administrador.`,
                    500,
                    'CALCULATION_ERROR'
                  );
                }

                if (sumForNumber > effectiveMaxAmount) {
                  const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
                  const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
                  const multiplierContext = rule.multiplierId ? ` (multiplicador: ${rule.multiplier?.name || '...'})` : '';
                  // ✅ CRÍTICO: maxAmount es por número por ticket, NO acumulado. El mensaje debe ser claro.
                  throw new AppError(
                    `El número ${num}${multiplierContext}${isAutoDatePrefix} excede el límite ${ruleScope} por ticket. Monto del número en este ticket: ₡${sumForNumber.toFixed(2)}, límite máximo permitido: ₡${effectiveMaxAmount.toFixed(2)}${dynamicLimit != null ? ` (límite dinámico)` : ''}`,
                    400,
                    { 
                      code: "NUMBER_MAXAMOUNT_EXCEEDED", 
                      number: num, 
                      maxAmount: effectiveMaxAmount, // ✅ Límite por número por ticket
                      amountAttempted: sumForNumber, // ✅ Monto del número en este ticket
                      scope: ruleScope,
                      isAutoDate: rule.isAutoDate,
                      isDynamic: dynamicLimit != null,
                      multiplierName: rule.multiplier?.name || undefined, // ✅ Frontend espera multiplierName
                      // ✅ CRÍTICO: Aclarar que es por número por ticket, no acumulado
                      isPerNumber: true,
                      isPerTicket: true,
                      clarification: 'Límite calculado por número individual en este ticket, no acumulado ni por total del ticket',
                    }
                  );
                }
              }
            }

            if (rule.maxTotal != null || dynamicLimit != null) {
              const staticMaxTotal = rule.maxTotal ?? Infinity;
              const effectiveMaxTotal = dynamicLimit != null ? Math.min(staticMaxTotal, dynamicLimit) : staticMaxTotal;

              // ✅ ROBUSTEZ: Validar que effectiveMaxTotal sea un número válido
              if (!Number.isFinite(effectiveMaxTotal) || effectiveMaxTotal <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_TOTAL',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxTotal,
                    maxTotal: rule.maxTotal,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              // ✅ CRÍTICO: maxTotal es acumulado por número individual en el sorteo, NO por total del ticket
              // ✅ CRÍTICO: Calcular amountForNumber por número INDIVIDUAL, no por total del ticket
              const numbersToCheck = numbersInRule.map(num => {
                // ✅ CRÍTICO: Filtrar SOLO las jugadas de este número específico
                const jugadasDelNumero = preparedJugadas.filter(j => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  // ✅ CRÍTICO: Solo contar jugadas de este número específico
                  return (j.type === 'NUMERO' && j.number === num && (!rule.multiplierId || j.multiplierId === rule.multiplierId)) || (j.type === 'REVENTADO' && j.reventadoNumber === num && !rule.multiplierId);
                });
                
                const amount = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amountValue = Number(j.amount);
                  if (!Number.isFinite(amountValue) || amountValue <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amountValue;
                }, 0);

                // ✅ ROBUSTEZ: Validar que amount sea un número válido
                if (!Number.isFinite(amount) || amount <= 0) {
                  return null; // Filtrar después
                }
                return { number: num, amountForNumber: amount };
              }).filter((n): n is { number: string; amountForNumber: number } => n !== null && n.amountForNumber > 0);

              if (numbersToCheck.length > 0) {
                const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
                await validateMaxTotalForNumbers(tx, {
                  numbers: numbersToCheck,
                  rule: { ...rule, maxTotal: effectiveMaxTotal },
                  sorteoId,
                  dynamicLimit,
                  multiplierFilter
                });
              }
            }
          } else {
            // Case 2: Global rule (no numbers)
            const uniqueNumbers = [...new Set(preparedJugadas.map(j => j.type === 'NUMERO' ? j.number : j.reventadoNumber))].filter((n): n is string => !!n);

            let effectiveMaxAmount: number | null = null;
            if (rule.maxAmount != null || dynamicLimit != null) {
              const staticMaxAmount = rule.maxAmount ?? Infinity;
              effectiveMaxAmount = dynamicLimit != null ? Math.min(staticMaxAmount, dynamicLimit) : staticMaxAmount;
            }

            if (effectiveMaxAmount != null) {
              // ✅ ROBUSTEZ: Validar que effectiveMaxAmount sea un número válido
              if (!Number.isFinite(effectiveMaxAmount) || effectiveMaxAmount <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_AMOUNT',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxAmount,
                    maxAmount: rule.maxAmount,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              for (const num of uniqueNumbers) {
                // ✅ CRÍTICO: Calcular sumForNumber SOLO para este número específico en este ticket
                // NO debe incluir otros números ni el total del ticket
                const jugadasDelNumero = preparedJugadas.filter((j) => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  if (j.type === 'NUMERO') {
                    if (rule.multiplierId && j.multiplierId !== rule.multiplierId) return false;
                    return j.number === num;
                  } else if (j.type === 'REVENTADO') {
                    if (rule.multiplierId) {
                      // ✅ LOGGING: REVENTADO excluido de validación cuando la regla tiene multiplierId
                      logger.debug({
                        layer: 'repository',
                        action: 'REVENTADO_EXCLUDED_FROM_MULTIPLIER_RULE',
                        payload: {
                          ruleId: rule.id,
                          multiplierId: rule.multiplierId,
                          reventadoNumber: j.reventadoNumber,
                          reason: 'REVENTADO jugadas do not have multiplierId, excluded from multiplier-specific rules',
                        },
                      });
                      return false;
                    }
                    return j.reventadoNumber === num;
                  }
                  return false;
                });
                
                const sumForNumber = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amount = Number(j.amount);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amount;
                }, 0);

                // ✅ ROBUSTEZ: Validar que sumForNumber sea un número válido antes de comparar
                if (!Number.isFinite(sumForNumber)) {
                  logger.error({
                    layer: 'repository',
                    action: 'INVALID_SUM_FOR_NUMBER',
                    payload: { num, sumForNumber, ruleId: rule.id },
                  });
                  throw new AppError(
                    `Error al calcular monto del número ${num}. Contacte al administrador.`,
                    500,
                    'CALCULATION_ERROR'
                  );
                }

                if (sumForNumber > effectiveMaxAmount) {
                  const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
                  const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
                  // ✅ CRÍTICO: maxAmount es por número por ticket, NO acumulado. El mensaje debe ser claro.
                  throw new AppError(
                    `El número ${num}${isAutoDatePrefix} excede el límite ${ruleScope} por ticket. Monto del número en este ticket: ₡${sumForNumber.toFixed(2)}, límite máximo permitido: ₡${effectiveMaxAmount.toFixed(2)}${dynamicLimit != null ? ` (límite dinámico)` : ''}`,
                    400,
                    { 
                      code: "NUMBER_MAXAMOUNT_EXCEEDED", 
                      number: num, 
                      maxAmount: effectiveMaxAmount, // ✅ Límite por número por ticket
                      amountAttempted: sumForNumber, // ✅ Monto del número en este ticket
                      scope: ruleScope,
                      isAutoDate: rule.isAutoDate,
                      isDynamic: dynamicLimit != null,
                      multiplierName: rule.multiplier?.name || undefined, // ✅ Frontend espera multiplierName
                      // ✅ CRÍTICO: Aclarar que es por número por ticket, no acumulado
                      isPerNumber: true,
                      isPerTicket: true,
                      clarification: 'Límite calculado por número individual en este ticket, no acumulado ni por total del ticket',
                    }
                  );
                }
              }
            }

            if (rule.maxTotal != null || dynamicLimit != null) {
              const staticMaxTotal = rule.maxTotal ?? Infinity;
              const effectiveMaxTotal = dynamicLimit != null ? Math.min(staticMaxTotal, dynamicLimit) : staticMaxTotal;

              // ✅ ROBUSTEZ: Validar que effectiveMaxTotal sea un número válido
              if (!Number.isFinite(effectiveMaxTotal) || effectiveMaxTotal <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_TOTAL',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxTotal,
                    maxTotal: rule.maxTotal,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              // ✅ CRÍTICO: maxTotal es acumulado por número individual en el sorteo, NO por total del ticket
              // ✅ CRÍTICO: Calcular amountForNumber por número INDIVIDUAL, no por total del ticket
              const numbersToCheck = uniqueNumbers.map(num => {
                // ✅ CRÍTICO: Filtrar SOLO las jugadas de este número específico
                const jugadasDelNumero = preparedJugadas.filter(j => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  // ✅ CRÍTICO: Solo contar jugadas de este número específico
                  return (j.type === 'NUMERO' && j.number === num && (!rule.multiplierId || j.multiplierId === rule.multiplierId)) || (j.type === 'REVENTADO' && j.reventadoNumber === num && !rule.multiplierId);
                });
                
                const amount = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amountValue = Number(j.amount);
                  if (!Number.isFinite(amountValue) || amountValue <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amountValue;
                }, 0);

                // ✅ ROBUSTEZ: Validar que amount sea un número válido
                if (!Number.isFinite(amount) || amount <= 0) {
                  return null; // Filtrar después
                }
                return { number: num, amountForNumber: amount };
              }).filter((n): n is { number: string; amountForNumber: number } => n !== null && n.amountForNumber > 0);

              if (numbersToCheck.length > 0) {
                const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
                await validateMaxTotalForNumbers(tx, {
                  numbers: numbersToCheck,
                  rule: { ...rule, maxTotal: effectiveMaxTotal },
                  sorteoId,
                  dynamicLimit,
                  multiplierFilter
                });
              }
            }
          }
          
          // ✅ LOGGING: Registrar resultado de validación de esta regla (al final de cada regla)
          logger.debug({
            layer: 'repository',
            action: 'RESTRICTION_RULE_VALIDATION_COMPLETE',
            payload: {
              ruleId: rule.id,
              scope: rule.userId ? 'USER' : rule.ventanaId ? 'VENTANA' : rule.bancaId ? 'BANCA' : 'GLOBAL',
              priority: calculatePriorityScore(rule),
              status: 'PASSED',
              hasMaxAmount: (rule.maxAmount != null || dynamicLimit != null),
              hasMaxTotal: (rule.maxTotal != null || dynamicLimit != null),
              numbersValidated: numbersInRule.length > 0 ? numbersInRule.length : 'all',
              dynamicLimitCalculated: dynamicLimit != null,
            },
          });
        }

        // 9) Crear ticket y jugadas con comisiones
        const commissionsDetails: any[] = [];
        const normalizedClienteNombre = (clienteNombre?.trim() || "CLIENTE CONTADO");

        const userPolicy = (user?.commissionPolicyJson ?? null) as any;
        const ventanaPolicy = (ventana?.commissionPolicyJson ?? null) as any;
        const bancaPolicy = (ventana?.banca?.commissionPolicyJson ?? null) as any;
        const ventanaUser = ventana?.users?.[0] ?? null;
        const ventanaUserPolicy = (ventanaUser?.commissionPolicyJson ?? null) as any;
        const ventanaUserId = ventanaUser?.id ?? null;

        const jugadasWithCommissions = preparedJugadas.map((j) => {
          const res = commissionService.calculateVendedorCommission(
            { loteriaId, betType: j.type, finalMultiplierX: j.finalMultiplierX, amount: j.amount },
            userPolicy, ventanaPolicy, bancaPolicy
          );

          let listeroRes: CommissionSnapshot;
          if (ventanaUserPolicy && ventanaUserId) {
            try {
              const parsedPolicy = commissionResolver.parsePolicy(ventanaUserPolicy, "USER");
              const resolution = commissionResolver.resolveFromPolicy(parsedPolicy, {
                userId: ventanaUserId,
                loteriaId,
                betType: j.type as "NUMERO" | "REVENTADO",
                finalMultiplierX: j.finalMultiplierX ?? null,
              }, true);
              listeroRes = {
                commissionPercent: resolution.percent,
                commissionAmount: parseFloat(((j.amount * resolution.percent) / 100).toFixed(2)),
                commissionOrigin: "USER",
                commissionRuleId: resolution.ruleId ?? null,
              };
            } catch (err) {
              listeroRes = commissionService.calculateListeroCommission({ loteriaId, betType: j.type, finalMultiplierX: j.finalMultiplierX || 0, amount: j.amount }, ventanaPolicy, bancaPolicy);
            }
          } else {
            listeroRes = commissionService.calculateListeroCommission({ loteriaId, betType: j.type, finalMultiplierX: j.finalMultiplierX || 0, amount: j.amount }, ventanaPolicy, bancaPolicy);
          }

          commissionsDetails.push({
            origin: res.commissionOrigin,
            ruleId: res.commissionRuleId ?? null,
            percent: res.commissionPercent,
            amount: res.commissionAmount,
            loteriaId,
            betType: j.type,
            multiplierX: j.finalMultiplierX,
            jugadaAmount: j.amount,
          });

          return {
            type: j.type,
            number: j.number,
            reventadoNumber: j.reventadoNumber ?? null,
            amount: j.amount,
            finalMultiplierX: j.finalMultiplierX,
            commissionPercent: res.commissionPercent,
            commissionAmount: res.commissionAmount,
            commissionOrigin: res.commissionOrigin,
            commissionRuleId: res.commissionRuleId ?? null,
            listeroCommissionAmount: listeroRes.commissionAmount,
            ...(j.multiplierId ? { multiplier: { connect: { id: j.multiplierId } } } : {}),
          };
        });

        const totalCommission = jugadasWithCommissions.reduce((sum, j) => sum + (j.commissionAmount || 0), 0);

        const createdTicket = await tx.ticket.create({
          data: {
            ticketNumber: nextNumber,
            loteriaId,
            sorteoId,
            ventanaId,
            vendedorId: userId,
            totalAmount: totalAmountTx,
            totalCommission,
            status: TicketStatus.ACTIVE,
            isActive: true,
            clienteNombre: normalizedClienteNombre,
            createdBy: options?.createdBy ?? null,
            createdByRole: options?.createdByRole ?? null,
            jugadas: { create: jugadasWithCommissions },
          },
          include: { jugadas: true },
        });

        (createdTicket as any).__businessDateInfo = bd;
        (createdTicket as any).__commissionsDetails = commissionsDetails;
        (createdTicket as any).__jugadasCount = jugadasWithCommissions.length;

        return { ticket: createdTicket, warnings };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // 9.1) Persistir businessDate fuera de la transacción
    const bdInfo = (ticket as any).__businessDateInfo as ReturnType<typeof getBusinessDateCRInfo> | undefined;
    if (bdInfo) {
      try {
        await prisma.$executeRaw(
          Prisma.sql`UPDATE "Ticket" SET "businessDate" = ${bdInfo.businessDate}::date WHERE id = ${ticket.id}::uuid`
        );
      } catch (e) {
        logger.warn({
          layer: 'repository',
          action: 'BUSINESS_DATE_NOT_PERSISTED',
          payload: { ticketId: ticket.id, reason: (e as Error).message, businessDateISO: bdInfo.businessDateISO },
        });
      }
    }

    // ActivityLog fuera de la TX (no bloqueante)
    const commissionsDetailsForLog = (ticket as any).__commissionsDetails || [];
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CREATE",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            jugadas: (ticket as any).jugadas?.length ?? (ticket as any).__jugadasCount ?? jugadas.length,
            commissions: commissionsDetailsForLog,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    // Logging
    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_TX",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        jugadas: (ticket as any).jugadas?.length ?? (ticket as any).__jugadasCount ?? jugadas.length,
      },
    });

    logger.debug({
      layer: "repository",
      action: "TICKET_DEBUG",
      payload: {
        loteriaId,
        sorteoId,
        ventanaId,
        vendedorId: userId,
        jugadas,
      },
    });

    delete (ticket as any).__commissionsDetails;
    delete (ticket as any).__jugadasCount;
    delete (ticket as any).__businessDateInfo;

    // ✅ NOTA: AccountStatement se actualiza cuando se evalúan los sorteos, no al crear tickets
    // Los sorteos se evalúan conforme van sucediendo, y es ahí cuando los tickets se toman en cuenta
    // Esto permite consolidar toda la información (ventas, premios, comisiones) en AccountStatement
    // para eficiencia al servir datos al FE sin recalcular días enteros

    return { ticket, warnings };
  },

  /**
   * Método optimizado de creación de tickets
   * - Pre-calcula comisiones fuera de la transacción (usando contexto cacheado)
   * - Usa batch creation para jugadas
   * - Timeout dinámico según número de jugadas
   */
  async createOptimized(
    data: Omit<CreateTicketInput, 'totalAmount'>,
    userId: string,
    options?: {
      actorRole?: Role;
      commissionContext?: CommissionContext;
      scheduledAt?: Date | null;
      createdBy?: string;
      createdByRole?: Role;
    }
  ) {
    const { loteriaId, sorteoId, ventanaId, jugadas, clienteNombre } = data;
    const actorRole = options?.actorRole ?? Role.VENDEDOR;
    const commissionContext = options?.commissionContext;
    const scheduledAt = options?.scheduledAt;

    // Calcular timeout dinámico basado en número de jugadas
    const baseTimeout = 20_000; // 20s base (aumentado para manejar concurrencia)
    const perJugadaTimeout = 300; // 300ms por jugada
    const maxTimeout = 60_000; // Máximo 60s
    const dynamicTimeout = Math.min(
      baseTimeout + (jugadas.length * perJugadaTimeout),
      maxTimeout
    );

    logger.info({
      layer: 'repository',
      action: 'TICKET_CREATE_OPTIMIZED_START',
      payload: {
        jugadasCount: jugadas.length,
        dynamicTimeout,
        hasCommissionContext: !!commissionContext,
      },
    });

    const { ticket, warnings } = await withTransactionRetry(
      async (tx) => {
        const warnings: TicketWarning[] = [];
        const warningRuleIds = new Set<string>();

        // 1) Generación de businessDate CR
        const nowUtc = new Date();
        const cutoffHour = (process.env.BUSINESS_CUTOFF_HOUR_CR || '00:00').trim();

        // 2) Validación de FKs + reglas de la lotería
        const [loteria, sorteo, ventana, user] = await Promise.all([
          tx.loteria.findUnique({
            where: { id: loteriaId },
            select: { id: true, name: true, isActive: true, rulesJson: true },
          }),
          tx.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true, status: true, loteriaId: true, scheduledAt: true },
          }),
          tx.ventana.findUnique({
            where: { id: ventanaId },
            select: {
              id: true,
              bancaId: true,
              commissionPolicyJson: true,
              banca: {
                select: {
                  commissionPolicyJson: true,
                },
              },
            },
          }),
          tx.user.findUnique({
            where: { id: userId },
            select: { id: true, commissionPolicyJson: true },
          }),
        ]);

        if (!user) throw new AppError("Seller (vendedor) not found", 404, "FK_VIOLATION");
        if (!loteria || loteria.isActive === false) throw new AppError("Lotería not found", 404, "FK_VIOLATION");
        if (!sorteo) throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
        if (!ventana) throw new AppError("Ventana not found", 404, "FK_VIOLATION");

        if (sorteo.loteriaId !== loteriaId) {
          throw new AppError("El sorteo no pertenece a la lotería indicada", 400, "SORTEO_LOTERIA_MISMATCH");
        }

        const loteriaName = loteria.name ?? null;

        // 3) Determinar businessDate CR
        const bd = getBusinessDateCRInfo({
          scheduledAt: scheduledAt ?? sorteo.scheduledAt,
          nowUtc,
          cutoffHour,
        });

        // 4) Generar número de ticket
        let nextNumber: string = '';
        let seqForLog: number | null = null;

        try {
          // ✅ Incrementar contador atómicamente con reintento automático en caso de colisión
          // Usar loop de reintento máximo 5 veces para manejar race conditions
          let seq: number = 0;
          let attempts = 0;
          const maxAttempts = 5;

          while (attempts < maxAttempts) {
            attempts++;

            // Incrementar contador atómicamente
            const seqRows = await tx.$queryRaw<{ last: number }[]>(
              Prisma.sql`
                INSERT INTO "TicketCounter" ("businessDate", "ventanaId", "last")
                VALUES (${bd.businessDate}::date, ${ventanaId}::uuid, 1)
                ON CONFLICT ("businessDate", "ventanaId")
                DO UPDATE SET "last" = "TicketCounter"."last" + 1
                RETURNING "last";
              `
            );

            seq = (seqRows?.[0]?.last ?? 1) as number;
            const seqPadded = String(seq).padStart(5, '0');
            const candidateNumber = `T${bd.prefixYYMMDD}-${seqPadded}`;

            const existing = await tx.ticket.findUnique({
              where: { ticketNumber: candidateNumber },
              select: { id: true },
            });

            if (!existing) {
              // ✅ Número disponible - usar este
              nextNumber = candidateNumber;
              seqForLog = seq;
              break;
            }

            // Colisión detectada - registrar y reintentar
            logger.warn({
              layer: 'repository',
              action: 'TICKET_NUMBER_COLLISION_RETRY',
              payload: {
                ticketNumber: candidateNumber,
                existingId: existing.id,
                businessDate: bd.businessDate,
                ventanaId,
                sequence: seq,
                attempt: attempts,
              },
            });

            // Si es el último intento, lanzar error
            if (attempts >= maxAttempts) {
              throw new AppError(
                `No se pudo generar número de ticket único después de ${maxAttempts} intentos`,
                500,
                'TICKET_NUMBER_COLLISION'
              );
            }
          }

          logger.info({
            layer: 'repository',
            action: 'TICKET_NUMBER_GENERATED',
            payload: {
              ticketNumber: nextNumber,
              businessDate: bd.businessDate,
              sequence: seq,
            },
          });
        } catch (error: any) {
          // Error al generar número de ticket
          if (error.code === 'TICKET_NUMBER_COLLISION') {
            throw error; // Re-lanzar colisiones
          }

          // Verificar si es error de tabla inexistente
          if (error.message?.includes('TicketCounter') || error.code === '42P01') {
            logger.error({
              layer: 'repository',
              action: 'TICKET_COUNTER_TABLE_MISSING',
              payload: {
                error: error.message,
                note: 'La tabla TicketCounter no existe. Ejecutar migración 20251103121500',
              },
            });
            throw new AppError(
              'Sistema de numeración no configurado. Contacte al administrador.',
              500,
              'TICKET_COUNTER_MISSING'
            );
          }

          // Otro error
          logger.error({
            layer: 'repository',
            action: 'TICKET_NUMBER_GENERATION_ERROR',
            payload: { error: error.message },
          });
          throw new AppError(
            'Error al generar número de ticket',
            500,
            'TICKET_NUMBER_ERROR'
          );
        }

        if (!nextNumber) {
          throw new AppError('Failed to generate ticket number', 500, 'SEQ_ERROR');
        }

        // 5) Resolver multiplicador base
        const bancaId = ventana.bancaId;
        const { valueX: effectiveBaseX, source } = await resolveBaseMultiplierX(tx, {
          bancaId,
          loteriaId,
          userId,
          ventanaId,
        });

        // 6) Búsqueda de reglas de restricción (simplificada)
        const now = new Date();
        const candidateRules = await tx.restrictionRule.findMany({
          where: {
            isActive: true,
            OR: [{ userId }, { ventanaId }, { bancaId }],
          },
          include: {
            loteria: true,
            multiplier: true,
          },
        });

        const applicable: RestrictionRuleWithRelations[] = candidateRules
          .filter((r) => {
            if (r.appliesToDate && !isSameLocalDay(new Date(r.appliesToDate), now)) return false;
            if (typeof r.appliesToHour === "number" && r.appliesToHour !== now.getHours()) return false;
            return true;
          })
          .map((r) => {
            let score = 0;
            if (r.bancaId) score += 1;
            if (r.ventanaId) score += 10;
            if (r.userId) score += 100;
            if (r.number) score += 1000;
            return { r, score };
          })
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);

        const lotteryMultiplierRules = applicable.filter(
          (rule) => rule.loteriaId && rule.multiplierId
        );

        // 7) Validaciones de rulesJson (simplificadas, ya validadas en service)
        const RJ = (loteria.rulesJson ?? {}) as any;
        const numberRange =
          RJ.numberRange &&
            typeof RJ.numberRange.min === "number" &&
            typeof RJ.numberRange.max === "number"
            ? { min: RJ.numberRange.min, max: RJ.numberRange.max }
            : { min: 0, max: 99 };

        const minBetAmount = typeof RJ.minBetAmount === "number" ? RJ.minBetAmount : undefined;
        const maxBetAmount = typeof RJ.maxBetAmount === "number" ? RJ.maxBetAmount : undefined;
        const maxNumbersPerTicket =
          typeof RJ.maxNumbersPerTicket === "number" ? RJ.maxNumbersPerTicket : undefined;

        // Validaciones rápidas (ya validadas en service, pero verificamos por seguridad)
        for (const j of jugadas) {
          const num = Number(j.number);
          if (Number.isNaN(num) || num < numberRange.min || num > numberRange.max) {
            throw new AppError(
              `Número fuera de rango permitido (${numberRange.min}..${numberRange.max}): ${j.number}`,
              400,
              "NUMBER_OUT_OF_RANGE"
            );
          }
          if (typeof minBetAmount === "number" && j.amount < minBetAmount) {
            throw new AppError(`Monto mínimo por jugada: ${minBetAmount}`, 400, "BET_MIN_VIOLATION");
          }
          if (typeof maxBetAmount === "number" && j.amount > maxBetAmount) {
            throw new AppError(`Monto máximo por jugada: ${maxBetAmount}`, 400, "BET_MAX_VIOLATION");
          }
        }

        if (typeof maxNumbersPerTicket === "number") {
          const uniqueNumeros = new Set(
            jugadas.filter((j) => j.type === "NUMERO").map((j) => j.number)
          );
          if (uniqueNumeros.size > maxNumbersPerTicket) {
            throw new AppError(
              `Máximo de números por ticket: ${maxNumbersPerTicket}`,
              400,
              "MAX_NUMBERS_PER_TICKET"
            );
          }
        }

        // 8) Normalizar jugadas y obtener multiplicadores
        const numeroMultiplierIds = Array.from(
          new Set(
            jugadas
              .filter((j) => j.type === "NUMERO" && j.multiplierId)
              .map((j) => j.multiplierId!)
          )
        );

        const multiplierCache = new Map<
          string,
          {
            id: string;
            valueX: number;
            isActive: boolean;
            kind: "NUMERO" | "REVENTADO";
            loteriaId: string;
            name?: string | null;
          }
        >();

        if (numeroMultiplierIds.length > 0) {
          const multipliers = await tx.loteriaMultiplier.findMany({
            where: { id: { in: numeroMultiplierIds } },
            select: {
              id: true,
              name: true,
              valueX: true,
              isActive: true,
              kind: true,
              loteriaId: true,
            },
          });

          for (const m of multipliers) {
            multiplierCache.set(m.id, {
              id: m.id,
              name: m.name,
              valueX: m.valueX,
              isActive: m.isActive,
              kind: m.kind as "NUMERO" | "REVENTADO",
              loteriaId: m.loteriaId,
            });
          }
        }

        const preparedJugadas = jugadas.map((j) => {
          if (j.type === "REVENTADO") {
            return {
              type: "REVENTADO" as const,
              number: j.number,
              reventadoNumber: j.reventadoNumber,
              amount: j.amount,
              finalMultiplierX: 0,
              multiplierId: null,
            };
          }

          // NUMERO
          if (!j.multiplierId) {
            throw new AppError("Debe seleccionar un multiplicador para jugadas tipo NUMERO", 400, "MISSING_MULTIPLIER_ID");
          }

          const multiplier = multiplierCache.get(j.multiplierId);
          if (!multiplier) {
            throw new AppError(`Multiplicador inválido para jugada NUMERO`, 400, "INVALID_MULTIPLIER");
          }
          if (multiplier.kind !== "NUMERO") {
            throw new AppError(`Multiplicador incompatible con jugada NUMERO`, 400, "INVALID_MULTIPLIER_KIND");
          }
          if (multiplier.loteriaId !== loteriaId) {
            throw new AppError(`Multiplicador no pertenece a la lotería`, 400, "INVALID_MULTIPLIER_LOTERIA");
          }
          if (!multiplier.isActive) {
            throw new AppError(`Multiplicador inactivo`, 400, "INACTIVE_MULTIPLIER");
          }

          const multiplierX = multiplier.valueX;
          if (typeof multiplierX !== "number" || multiplierX <= 0) {
            throw new AppError(`Multiplicador con valor inválido`, 400, "INVALID_MULTIPLIER_VALUE");
          }

          const matchingRule = lotteryMultiplierRules.find(
            (rule) => rule.loteriaId === loteriaId && rule.multiplierId === j.multiplierId
          );

          if (matchingRule) {
            const ruleScope: "USER" | "VENTANA" | "BANCA" = matchingRule.userId
              ? "USER"
              : matchingRule.ventanaId
                ? "VENTANA"
                : "BANCA";

            const loteriaNameForWarning = matchingRule.loteria?.name ?? loteriaName;
            const multiplierNameForWarning = multiplier.name ?? matchingRule.multiplier?.name ?? null;
            const defaultMessage = multiplier.name
              ? `El multiplicador '${multiplier.name}' está restringido para esta lotería.`
              : "El multiplicador seleccionado está restringido para esta lotería.";
            const message = (matchingRule.message && matchingRule.message.trim()) || defaultMessage;

            if (actorRole === Role.ADMIN) {
              if (!warningRuleIds.has(matchingRule.id)) {
                warnings.push({
                  code: "LOTTERY_MULTIPLIER_RESTRICTED",
                  restrictedButAllowed: true,
                  ruleId: matchingRule.id,
                  scope: ruleScope,
                  loteriaId,
                  loteriaName: loteriaNameForWarning,
                  multiplierId: j.multiplierId,
                  multiplierName: multiplierNameForWarning,
                  message,
                });
                warningRuleIds.add(matchingRule.id);
              }
            } else {
              throw new AppError(message, 400, {
                code: "LOTTERY_MULTIPLIER_RESTRICTED",
                ruleId: matchingRule.id,
                scope: ruleScope,
                loteriaId,
                loteriaName: loteriaNameForWarning,
                multiplierId: j.multiplierId,
                multiplierName: multiplierNameForWarning,
              });
            }
          }

          return {
            type: "NUMERO" as const,
            number: j.number,
            reventadoNumber: null,
            amount: j.amount,
            finalMultiplierX: multiplierX,
            multiplierId: j.multiplierId,
            isActive: (j as any).isActive !== false, // ✅ Preservar isActive (default true)
          };
        });

        const totalAmountTx = preparedJugadas.reduce((acc, j) => acc + j.amount, 0);

        // 9) ❌ ELIMINADO: Validación de límite diario TOTAL del vendedor
        // Los límites deben aplicarse POR NÚMERO, no por total diario del vendedor.
        // La validación correcta está en las líneas 1966-2034 (validateMaxTotalForNumbers)

        // 10) Aplicar TODAS las reglas aplicables de forma acumulativa (USER > VENTANA > BANCA)
        for (const rule of (applicable as any[])) {
          // Calcular límite dinámico si hay baseAmount o salesPercentage
          let dynamicLimit: number | null = null;
          const hasDynamicFields =
            (rule.baseAmount != null && rule.baseAmount > 0) ||
            (rule.salesPercentage != null && rule.salesPercentage > 0);

          if (hasDynamicFields) {
            dynamicLimit = await calculateDynamicLimit(tx, {
              baseAmount: rule.baseAmount,
              salesPercentage: rule.salesPercentage,
              appliesToVendedor: rule.appliesToVendedor,
            }, {
              userId,
              ventanaId,
              bancaId,
              sorteoId,  // ✅ CRÍTICO: Pasar sorteoId para calcular sobre el sorteo
              at: now,
            });
          }

          const numbersToValidate = resolveNumbersToValidate(rule, now);

          if (numbersToValidate.length > 0) {
            // Case 1: Specific numbers in rule
            let effectiveMaxAmount: number | null = null;
            if (rule.maxAmount != null || dynamicLimit != null) {
              const staticMaxAmount = rule.maxAmount ?? Infinity;
              effectiveMaxAmount = dynamicLimit != null
                ? Math.min(staticMaxAmount, dynamicLimit)
                : staticMaxAmount;
            }

            if (effectiveMaxAmount != null) {
              for (const num of numbersToValidate) {
                const sumForNumber = preparedJugadas
                  .filter((j) => {
                    if (j.type === 'NUMERO') {
                      if (rule.multiplierId && j.multiplierId !== rule.multiplierId) return false;
                      return j.number === num;
                    } else if (j.type === 'REVENTADO') {
                      if (rule.multiplierId) return false;
                      return j.reventadoNumber === num;
                    }
                    return false;
                  })
                  .reduce((acc, j) => acc + j.amount, 0);

                if (sumForNumber > effectiveMaxAmount) {
                  const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
                  const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
                  const multiplierContext = rule.multiplierId ? ` (multiplicador: ${rule.multiplier?.name || '...'})` : '';

                  throw new AppError(
                    `El número ${num}${multiplierContext}${isAutoDatePrefix} excede el límite ${ruleScope} por ticket. Monto en el ticket: ₡${sumForNumber.toFixed(2)}, límite máximo por ticket: ₡${effectiveMaxAmount.toFixed(2)}${dynamicLimit != null ? ` (dinámico)` : ''}`,
                    400,
                    {
                      code: "NUMBER_MAXAMOUNT_EXCEEDED",
                      number: num,
                      maxAmount: effectiveMaxAmount,
                      scope: ruleScope,
                      isAutoDate: rule.isAutoDate,
                      amountAttempted: sumForNumber,
                      isDynamic: dynamicLimit != null,
                      multiplierName: rule.multiplier?.name || undefined, // ✅ Frontend espera multiplierName
                    }
                  );
                }
              }
            }

            if (rule.maxTotal != null || dynamicLimit != null) {
              const staticMaxTotal = rule.maxTotal ?? Infinity;
              const effectiveMaxTotal = dynamicLimit != null ? Math.min(staticMaxTotal, dynamicLimit) : staticMaxTotal;

              const numbersToCheck = numbersToValidate.map(num => {
                const amount = preparedJugadas
                  .filter(j => {
                    // ✅ Excluir jugadas inactivas
                    if (j.isActive === false) return false;
                    return (j.type === 'NUMERO' && j.number === num && (!rule.multiplierId || j.multiplierId === rule.multiplierId)) || (j.type === 'REVENTADO' && j.reventadoNumber === num && !rule.multiplierId);
                  })
                  .reduce((acc, j) => acc + j.amount, 0);
                return { number: num, amountForNumber: amount };
              }).filter(n => n.amountForNumber > 0);

              if (numbersToCheck.length > 0) {
                const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
                await validateMaxTotalForNumbers(tx, {
                  numbers: numbersToCheck,
                  rule: { ...rule, maxTotal: effectiveMaxTotal },
                  sorteoId,
                  dynamicLimit,
                  multiplierFilter
                });
              }
            }
          } else {
            // Case 2: Global rule (no numbers)
            const uniqueNumbers = [...new Set(preparedJugadas.map(j => j.type === 'NUMERO' ? j.number : j.reventadoNumber))].filter((n): n is string => !!n);

            let effectiveMaxAmount: number | null = null;
            if (rule.maxAmount != null || dynamicLimit != null) {
              const staticMaxAmount = rule.maxAmount ?? Infinity;
              effectiveMaxAmount = dynamicLimit != null ? Math.min(staticMaxAmount, dynamicLimit) : staticMaxAmount;
            }

            if (effectiveMaxAmount != null) {
              // ✅ ROBUSTEZ: Validar que effectiveMaxAmount sea un número válido
              if (!Number.isFinite(effectiveMaxAmount) || effectiveMaxAmount <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_AMOUNT',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxAmount,
                    maxAmount: rule.maxAmount,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              for (const num of uniqueNumbers) {
                // ✅ CRÍTICO: Calcular sumForNumber SOLO para este número específico en este ticket
                // NO debe incluir otros números ni el total del ticket
                const jugadasDelNumero = preparedJugadas.filter((j) => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  if (j.type === 'NUMERO') {
                    if (rule.multiplierId && j.multiplierId !== rule.multiplierId) return false;
                    return j.number === num;
                  } else if (j.type === 'REVENTADO') {
                    if (rule.multiplierId) {
                      // ✅ LOGGING: REVENTADO excluido de validación cuando la regla tiene multiplierId
                      logger.debug({
                        layer: 'repository',
                        action: 'REVENTADO_EXCLUDED_FROM_MULTIPLIER_RULE',
                        payload: {
                          ruleId: rule.id,
                          multiplierId: rule.multiplierId,
                          reventadoNumber: j.reventadoNumber,
                          reason: 'REVENTADO jugadas do not have multiplierId, excluded from multiplier-specific rules',
                        },
                      });
                      return false;
                    }
                    return j.reventadoNumber === num;
                  }
                  return false;
                });
                
                const sumForNumber = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amount = Number(j.amount);
                  if (!Number.isFinite(amount) || amount <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amount;
                }, 0);

                // ✅ ROBUSTEZ: Validar que sumForNumber sea un número válido antes de comparar
                if (!Number.isFinite(sumForNumber)) {
                  logger.error({
                    layer: 'repository',
                    action: 'INVALID_SUM_FOR_NUMBER',
                    payload: { num, sumForNumber, ruleId: rule.id },
                  });
                  throw new AppError(
                    `Error al calcular monto del número ${num}. Contacte al administrador.`,
                    500,
                    'CALCULATION_ERROR'
                  );
                }

                if (sumForNumber > effectiveMaxAmount) {
                  const ruleScope = rule.userId ? "personal" : rule.ventanaId ? "de ventana" : rule.bancaId ? "de banca" : "general";
                  const isAutoDatePrefix = rule.isAutoDate ? " (automático)" : "";
                  // ✅ CRÍTICO: maxAmount es por número por ticket, NO acumulado. El mensaje debe ser claro.
                  throw new AppError(
                    `El número ${num}${isAutoDatePrefix} excede el límite ${ruleScope} por ticket. Monto del número en este ticket: ₡${sumForNumber.toFixed(2)}, límite máximo permitido: ₡${effectiveMaxAmount.toFixed(2)}${dynamicLimit != null ? ` (límite dinámico)` : ''}`,
                    400,
                    { 
                      code: "NUMBER_MAXAMOUNT_EXCEEDED", 
                      number: num, 
                      maxAmount: effectiveMaxAmount, // ✅ Límite por número por ticket
                      amountAttempted: sumForNumber, // ✅ Monto del número en este ticket
                      scope: ruleScope,
                      isAutoDate: rule.isAutoDate,
                      isDynamic: dynamicLimit != null,
                      multiplierName: rule.multiplier?.name || undefined, // ✅ Frontend espera multiplierName
                      // ✅ CRÍTICO: Aclarar que es por número por ticket, no acumulado
                      isPerNumber: true,
                      isPerTicket: true,
                      clarification: 'Límite calculado por número individual en este ticket, no acumulado ni por total del ticket',
                    }
                  );
                }
              }
            }

            if (rule.maxTotal != null || dynamicLimit != null) {
              const staticMaxTotal = rule.maxTotal ?? Infinity;
              const effectiveMaxTotal = dynamicLimit != null ? Math.min(staticMaxTotal, dynamicLimit) : staticMaxTotal;

              // ✅ ROBUSTEZ: Validar que effectiveMaxTotal sea un número válido
              if (!Number.isFinite(effectiveMaxTotal) || effectiveMaxTotal <= 0) {
                logger.warn({
                  layer: 'repository',
                  action: 'INVALID_EFFECTIVE_MAX_TOTAL',
                  payload: {
                    ruleId: rule.id,
                    effectiveMaxTotal,
                    maxTotal: rule.maxTotal,
                    dynamicLimit,
                  },
                });
                continue; // Saltar esta regla si el límite es inválido
              }

              // ✅ CRÍTICO: maxTotal es acumulado por número individual en el sorteo, NO por total del ticket
              // ✅ CRÍTICO: Calcular amountForNumber por número INDIVIDUAL, no por total del ticket
              const numbersToCheck = uniqueNumbers.map(num => {
                // ✅ CRÍTICO: Filtrar SOLO las jugadas de este número específico
                const jugadasDelNumero = preparedJugadas.filter(j => {
                  // ✅ Excluir jugadas inactivas
                  if (j.isActive === false) return false;
                  // ✅ CRÍTICO: Solo contar jugadas de este número específico
                  return (j.type === 'NUMERO' && j.number === num && (!rule.multiplierId || j.multiplierId === rule.multiplierId)) || (j.type === 'REVENTADO' && j.reventadoNumber === num && !rule.multiplierId);
                });
                
                const amount = jugadasDelNumero.reduce((acc, j) => {
                  // ✅ ROBUSTEZ: Validar que cada amount sea un número válido
                  const amountValue = Number(j.amount);
                  if (!Number.isFinite(amountValue) || amountValue <= 0) {
                    logger.warn({
                      layer: 'repository',
                      action: 'INVALID_JUGADA_AMOUNT',
                      payload: { jugada: j, amount: j.amount },
                    });
                    return acc; // Ignorar jugadas con montos inválidos
                  }
                  return acc + amountValue;
                }, 0);

                // ✅ ROBUSTEZ: Validar que amount sea un número válido
                if (!Number.isFinite(amount) || amount <= 0) {
                  return null; // Filtrar después
                }
                return { number: num, amountForNumber: amount };
              }).filter((n): n is { number: string; amountForNumber: number } => n !== null && n.amountForNumber > 0);

              if (numbersToCheck.length > 0) {
                const multiplierFilter = rule.multiplierId ? { id: rule.multiplierId, kind: (rule.multiplier?.kind || 'NUMERO') as any } : null;
                await validateMaxTotalForNumbers(tx, {
                  numbers: numbersToCheck,
                  rule: { ...rule, maxTotal: effectiveMaxTotal },
                  sorteoId,
                  dynamicLimit,
                  multiplierFilter
                });
              }
            }
          }
        }

        // 11) 🚀 OPTIMIZACIÓN: Calcular comisiones usando contexto cacheado
        const commissionsDetails: any[] = [];
        let jugadasWithCommissions: Array<{
          type: "NUMERO" | "REVENTADO";
          number: string;
          reventadoNumber: string | null;
          amount: number;
          finalMultiplierX: number;
          commissionPercent: number;
          commissionAmount: number;
          commissionOrigin: "USER" | "VENTANA" | "BANCA" | null;
          commissionRuleId: string | null;
          listeroCommissionAmount: number; // ✅ CRÍTICO: Comisión del listero (VENTANA/BANCA)
          multiplierId: string | null;
        }>;

        if (commissionContext) {
          // Usar pre-cálculo optimizado con CommissionService
          const preCalculated = commissionService.calculateCommissionsForJugadas(
            preparedJugadas,
            loteriaId,
            commissionContext
          );

          // Crear mapa de número -> multiplierId para NUMERO jugadas
          const numeroMultiplierMap = new Map<string, string | null>();
          for (const pj of preparedJugadas) {
            if (pj.type === "NUMERO") {
              numeroMultiplierMap.set(pj.number, pj.multiplierId);
            }
          }

          // ✅ CRÍTICO: Calcular listeroCommissionAmount desde políticas VENTANA o BANCA
          const ventanaPolicy = ventana?.commissionPolicyJson ?? null;
          const bancaPolicy = ventana?.banca?.commissionPolicyJson ?? null;
          // ✅ Use listeroPolicy from context if available
          const listeroPolicy = commissionContext.listeroPolicy ?? null;

          jugadasWithCommissions = preCalculated.map((j) => {
            // Calcular comisión del listero (VENTANA o BANCA, nunca USER)
            let listeroCommissionAmount = 0;

            // Try to use listeroPolicy from context first (most optimized)
            if (listeroPolicy) {
              const match = commissionResolver.findMatchingRule(listeroPolicy, {
                loteriaId,
                betType: j.type,
                finalMultiplierX: j.finalMultiplierX,
                amount: j.amount,
              });
              if (match) {
                listeroCommissionAmount = parseFloat(((j.amount * match.percent) / 100).toFixed(2));
              } else {
                // Fallback to standard resolution if no match in listero policy
                const listeroResult = commissionService.calculateListeroCommission(
                  {
                    loteriaId,
                    betType: j.type,
                    finalMultiplierX: j.finalMultiplierX,
                    amount: j.amount,
                  },
                  ventanaPolicy,
                  bancaPolicy
                );
                listeroCommissionAmount = parseFloat((listeroResult.commissionAmount).toFixed(2));
              }
            } else {
              // Fallback to standard resolution
              const listeroResult = commissionService.calculateListeroCommission(
                {
                  loteriaId,
                  betType: j.type,
                  finalMultiplierX: j.finalMultiplierX,
                  amount: j.amount,
                },
                ventanaPolicy,
                bancaPolicy
              );
              listeroCommissionAmount = parseFloat((listeroResult.commissionAmount).toFixed(2));
            }

            return {
              ...j,
              reventadoNumber: j.type === "REVENTADO" ? j.number : null,
              multiplierId: j.type === "NUMERO" ? (numeroMultiplierMap.get(j.number) ?? null) : null,
              listeroCommissionAmount, // ✅ PERSISTIR en DB
            };
          });

          // Preparar detalles para ActivityLog
          for (const j of jugadasWithCommissions) {
            commissionsDetails.push({
              origin: j.commissionOrigin,
              ruleId: j.commissionRuleId ?? null,
              percent: j.commissionPercent,
              amount: j.commissionAmount,
              listeroAmount: j.listeroCommissionAmount, // ✅ Incluir en logs
              loteriaId,
              betType: j.type,
              multiplierX: j.finalMultiplierX,
              jugadaAmount: j.amount,
            });
          }
        } else {
          // Fallback al método original (sin optimización)
          const userPolicy = user?.commissionPolicyJson ?? null;
          const ventanaPolicy = ventana?.commissionPolicyJson ?? null;
          const bancaPolicy = ventana?.banca?.commissionPolicyJson ?? null;

          jugadasWithCommissions = preparedJugadas.map((j) => {
            const res = commissionService.calculateVendedorCommission(
              {
                loteriaId,
                betType: j.type,
                finalMultiplierX: j.finalMultiplierX,
                amount: j.amount,
              },
              userPolicy,
              ventanaPolicy,
              bancaPolicy
            );

            // ✅ CRÍTICO: Calcular listeroCommissionAmount desde políticas VENTANA o BANCA
            const listeroResult = commissionService.calculateListeroCommission(
              {
                loteriaId,
                betType: j.type,
                finalMultiplierX: j.finalMultiplierX,
                amount: j.amount,
              },
              ventanaPolicy,
              bancaPolicy
            );

            const listeroCommissionAmount = parseFloat((listeroResult.commissionAmount).toFixed(2));

            commissionsDetails.push({
              origin: res.commissionOrigin,
              ruleId: res.commissionRuleId ?? null,
              percent: res.commissionPercent,
              amount: res.commissionAmount,
              listeroAmount: listeroCommissionAmount, // ✅ Incluir en logs
              loteriaId,
              betType: j.type,
              multiplierX: j.finalMultiplierX,
              jugadaAmount: j.amount,
            });

            return {
              type: j.type,
              number: j.number,
              reventadoNumber: j.reventadoNumber ?? null,
              amount: j.amount,
              finalMultiplierX: j.finalMultiplierX,
              commissionPercent: res.commissionPercent,
              commissionAmount: res.commissionAmount,
              commissionOrigin: res.commissionOrigin,
              commissionRuleId: res.commissionRuleId ?? null,
              listeroCommissionAmount, // ✅ PERSISTIR en DB
              multiplierId: j.multiplierId ?? null,
            };
          });
        }

        const totalCommission = jugadasWithCommissions.reduce(
          (sum, j) => sum + (j.commissionAmount || 0),
          0
        );

        const normalizedClienteNombre = (clienteNombre?.trim() || "CLIENTE CONTADO");

        // 12) Crear ticket primero
        const createdTicket = await tx.ticket.create({
          data: {
            ticketNumber: nextNumber,
            loteriaId,
            sorteoId,
            ventanaId,
            vendedorId: userId,
            totalAmount: totalAmountTx,
            totalCommission,
            status: TicketStatus.ACTIVE,
            isActive: true,
            clienteNombre: normalizedClienteNombre,
            createdBy: options?.createdBy ?? null,
            createdByRole: options?.createdByRole ?? null,
          },
        });

        // 13) 🚀 OPTIMIZACIÓN: Crear jugadas en batches
        const BATCH_SIZE = 20;
        for (let i = 0; i < jugadasWithCommissions.length; i += BATCH_SIZE) {
          const batch = jugadasWithCommissions.slice(i, i + BATCH_SIZE);
          await tx.jugada.createMany({
            data: batch.map((j) => ({
              ticketId: createdTicket.id,
              type: j.type,
              number: j.number,
              reventadoNumber: j.reventadoNumber,
              amount: j.amount,
              finalMultiplierX: j.finalMultiplierX,
              commissionPercent: j.commissionPercent,
              commissionAmount: j.commissionAmount,
              commissionOrigin: j.commissionOrigin,
              commissionRuleId: (j as any).commissionRuleId,
              listeroCommissionAmount: (j as any).listeroCommissionAmount, // ✅ PERSISTIR en DB
              multiplierId: (j as any).multiplierId,
            })),
          });
        }

        // 14) Obtener ticket completo con jugadas
        const ticketWithJugadas = await tx.ticket.findUnique({
          where: { id: createdTicket.id },
          include: { jugadas: true },
        });

        if (!ticketWithJugadas) {
          throw new AppError("Failed to retrieve created ticket", 500);
        }

        // Adjuntar datos para uso fuera de TX
        (ticketWithJugadas as any).__businessDateInfo = bd;
        (ticketWithJugadas as any).__commissionsDetails = commissionsDetails;
        (ticketWithJugadas as any).__jugadasCount = jugadasWithCommissions.length;

        logger.info({
          layer: 'repository',
          action: 'TICKET_FOLIO_DIAG',
          payload: {
            createdAtUTC: new Date().toISOString(),
            scheduledAt: sorteo.scheduledAt?.toISOString() ?? null,
            businessDateISO: bd.businessDateISO,
            prefixYYMMDD: bd.prefixYYMMDD,
            counter: seqForLog,
            ticketNumber: nextNumber,
            optimized: true,
          },
        });

        return { ticket: ticketWithJugadas, warnings };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: dynamicTimeout,
      }
    );

    // Persistir businessDate fuera de la transacción
    const bdInfo = (ticket as any).__businessDateInfo as ReturnType<typeof getBusinessDateCRInfo> | undefined;
    if (bdInfo) {
      try {
        await prisma.$executeRaw(
          Prisma.sql`UPDATE "Ticket" SET "businessDate" = ${bdInfo.businessDate}::date WHERE id = ${ticket.id}::uuid`
        );
      } catch (e) {
        logger.warn({
          layer: 'repository',
          action: 'BUSINESS_DATE_NOT_PERSISTED',
          payload: { ticketId: ticket.id, reason: (e as Error).message, businessDateISO: bdInfo.businessDateISO },
        });
      }
    }

    // ActivityLog fuera de la TX (no bloqueante)
    const commissionsDetailsForLog = (ticket as any).__commissionsDetails || [];
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CREATE",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            jugadas: (ticket as any).jugadas?.length ?? (ticket as any).__jugadasCount ?? jugadas.length,
            commissions: commissionsDetailsForLog,
            optimized: true,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_OPTIMIZED_SUCCESS",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        jugadas: (ticket as any).jugadas?.length ?? (ticket as any).__jugadasCount ?? jugadas.length,
        dynamicTimeout,
      },
    });

    delete (ticket as any).__commissionsDetails;
    delete (ticket as any).__jugadasCount;
    delete (ticket as any).__businessDateInfo;

    return { ticket, warnings };
  },

  async getById(id: string) {
    return prisma.ticket.findUnique({
      where: { id },
      include: {
        jugadas: true,
        loteria: true,
        sorteo: true,
        ventana: true,
        vendedor: true,
        createdByUser: {
          select: { id: true, name: true, role: true },
        },
      },
    });
  },

  async list(
    page = 1,
    pageSize = 10,
    filters: {
      status?: TicketStatus;
      isActive?: boolean;
      sorteoId?: string;
      loteriaId?: string;
      multiplierId?: string;
      ventanaId?: string;
      search?: string;
      userId?: string;
      dateFrom?: Date;
      dateTo?: Date;
      winnersOnly?: boolean;
      number?: string; // ✅ NUEVO: Búsqueda por número de jugada (1-2 dígitos)
    } = {}
  ) {
    const skip = (page - 1) * pageSize;

    const where: Prisma.TicketWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(typeof filters.isActive === "boolean" ? { isActive: filters.isActive } : {}),
      ...(filters.sorteoId ? { sorteoId: filters.sorteoId } : {}),
      ...(filters.loteriaId ? { loteriaId: filters.loteriaId } : {}),
      ...(filters.multiplierId
        ? {
          jugadas: {
            some: {
              multiplierId: filters.multiplierId,
            },
          },
        }
        : {}),
      ...(filters.userId ? { vendedorId: filters.userId } : {}),
      ...(filters.ventanaId ? { ventanaId: filters.ventanaId } : {}),
      ...(filters.winnersOnly === true ? { isWinner: true } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lt: filters.dateTo } : {}), // ✅ medio-abierto
          },
        }
        : {}),
    };

    // ✅ NUEVO: Búsqueda exacta por número de jugada
    // Busca en jugada.number (para NUMERO) y jugada.reventadoNumber (para REVENTADO)
    // La búsqueda es exacta: si se busca "12", encuentra "12" pero no "123" o "012"
    if (filters.number) {
      const numberStr = filters.number.trim();
      // Normalizar el número: asegurar que tenga formato consistente (sin ceros a la izquierda para comparación)
      // Pero mantener la búsqueda exacta en la base de datos
      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          jugadas: {
            some: {
              OR: [
                // Búsqueda en number (para tipo NUMERO)
                { number: numberStr },
                // Búsqueda en reventadoNumber (para tipo REVENTADO)
                { reventadoNumber: numberStr },
              ],
              deletedAt: null, // Solo jugadas activas
            },
          },
        },
      ];
    }

    // búsqueda unificada
    const s = typeof filters.search === "string" ? filters.search.trim() : "";
    if (s.length > 0) {
      const isDigits = /^\d+$/.test(s);
      const n = isDigits ? Number(s) : null;

      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          OR: [
            ...(n !== null
              ? [{ ticketNumber: n } as Prisma.TicketWhereInput]
              : []),
            { vendedor: { name: { contains: s, mode: "insensitive" } } },
            { ventana: { name: { contains: s, mode: "insensitive" } } },
            { loteria: { name: { contains: s, mode: "insensitive" } } },
            { sorteo: { name: { contains: s, mode: "insensitive" } } },
          ],
        },
      ];
    }

    // Optimización: Usar select en lugar de include para mejor performance
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip,
        take: pageSize,
        select: {
          id: true,
          ticketNumber: true,
          businessDate: true,
          loteriaId: true,
          ventanaId: true,
          vendedorId: true,
          totalAmount: true,
          status: true,
          isActive: true,
          isWinner: true,
          sorteoId: true,
          clienteNombre: true,
          totalPayout: true,
          totalPaid: true,
          remainingAmount: true,
          totalCommission: true,
          lastPaymentAt: true,
          paidById: true,
          paymentMethod: true,
          paymentNotes: true,
          createdAt: true,
          updatedAt: true,
          createdBy: true,
          createdByRole: true,
          loteria: { select: { id: true, name: true } },
          sorteo: {
            select: { id: true, name: true, status: true, scheduledAt: true },
          },
          ventana: { select: { id: true, name: true } },
          vendedor: { select: { id: true, name: true, role: true } },
          createdByUser: { select: { id: true, name: true, role: true } },
          jugadas: {
            select: {
              id: true,
              number: true,
              amount: true,
              finalMultiplierX: true,
              payout: true,
              isActive: true,
              isWinner: true,
              multiplierId: true,
              reventadoNumber: true,
              type: true,
              commissionPercent: true,
              commissionAmount: true,
              commissionOrigin: true,
              multiplier: {
                select: {
                  id: true,
                  name: true,
                  valueX: true,
                  kind: true,
                  isActive: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const meta = {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    logger.info({
      layer: "repository",
      action: "TICKET_LIST",
      payload: {
        filters: { ...filters, search: s || undefined },
        page,
        pageSize,
        total,
      },
    });

    return { data, meta };
  },

  async cancel(id: string, userId: string) {
    // Cancelación bajo retry + timeouts (misma estrategia que create)
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado
        const existing = await tx.ticket.findUnique({
          where: { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status === TicketStatus.EVALUATED) {
          throw new AppError(
            "Cannot cancel an evaluated ticket",
            400,
            "INVALID_STATE"
          );
        }

        // 2) Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
        if (
          existing.sorteo.status === "CLOSED" ||
          existing.sorteo.status === "EVALUATED"
        ) {
          throw new AppError(
            "Cannot cancel ticket from closed or evaluated sorteo",
            400,
            "SORTEO_LOCKED"
          );
        }

        // 3) Actualizar ticket (soft delete + inactivar)
        // IMPORTANTE: También inactivar todas las jugadas del ticket
        const now = new Date();
        const cancelled = await tx.ticket.update({
          where: { id },
          data: {
            isActive: false,
            status: TicketStatus.CANCELLED,
            deletedAt: now, // Registrar fecha de cancelación/eliminación
            updatedAt: now,
          },
          include: { jugadas: true },
        });

        // 4) Inactivar todas las jugadas del ticket cancelado
        await tx.jugada.updateMany({
          where: { ticketId: id },
          data: {
            isActive: false,
          },
        });

        return cancelled;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // ActivityLog fuera de la TX (no bloqueante)
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CANCEL",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            cancelledAt: ticket.updatedAt,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    // Logging global
    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: {
        ticketId: id,
        userId,
        sorteoId: (ticket as any).sorteoId,
        totalAmount: ticket.totalAmount,
      },
    });

    // ✅ NUEVO: Invalidar caché de estados de cuenta cuando se cancela un ticket
    // El ticket cancelado afecta el balance (totalSales) del statement del día
    const { invalidateCacheForTicket } = await import('../utils/accountStatementCache');
    invalidateCacheForTicket({
      businessDate: ticket.businessDate,
      ventanaId: ticket.ventanaId,
      vendedorId: ticket.vendedorId,
    }).catch((err: Error) => {
      // Ignorar errores de invalidación de caché (no crítico)
      logger.warn({
        layer: 'repository',
        action: 'CACHE_INVALIDATION_FAILED',
        payload: { error: err.message, ticketId: id }
      });
    });

    return ticket;
  },

  /**
   * Restaura un ticket cancelado si el sorteo aún no ha pasado
   */
  async restore(id: string, userId: string) {
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado
        const existing = await tx.ticket.findUnique({
          where: { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status !== TicketStatus.CANCELLED) {
          throw new AppError(
            "Only cancelled tickets can be restored",
            400,
            "INVALID_STATE"
          );
        }

        // 2) Validar que el sorteo no haya pasado
        const now = new Date();
        if (existing.sorteo.scheduledAt <= now) {
          throw new AppError(
            "Cannot restore ticket: draw has passed",
            409,
            "DRAW_PASSED"
          );
        }

        // 3) Validar estado del sorteo
        if (
          existing.sorteo.status === "CLOSED" ||
          existing.sorteo.status === "EVALUATED"
        ) {
          throw new AppError(
            "Cannot restore ticket: draw is closed or evaluated",
            409,
            "SORTEO_LOCKED"
          );
        }

        // 4) Restaurar ticket
        const restored = await tx.ticket.update({
          where: { id },
          data: {
            isActive: true,
            status: TicketStatus.ACTIVE,
            updatedAt: new Date(),
          },
          include: { jugadas: true },
        });

        // 5) Restaurar jugadas
        await tx.jugada.updateMany({
          where: { ticketId: id },
          data: {
            isActive: true,
          },
        });

        return restored;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // ActivityLog
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_RESTORE",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            restoredAt: ticket.updatedAt,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    logger.info({
      layer: "repository",
      action: "TICKET_RESTORE_DB",
      payload: {
        ticketId: id,
        userId,
      },
    });

    // ✅ NUEVO: Invalidar caché de estados de cuenta cuando se restaura un ticket
    // El ticket restaurado afecta el balance (totalSales) del statement del día
    const { invalidateCacheForTicket } = await import('../utils/accountStatementCache');
    invalidateCacheForTicket({
      businessDate: ticket.businessDate,
      ventanaId: ticket.ventanaId,
      vendedorId: ticket.vendedorId,
    }).catch((err: Error) => {
      // Ignorar errores de invalidación de caché (no crítico)
      logger.warn({
        layer: 'repository',
        action: 'CACHE_INVALIDATION_FAILED',
        payload: { error: err.message, ticketId: id }
      });
    });

    return ticket;
  },
};

export default TicketRepository;

