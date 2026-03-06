// src/modules/sorteos/services/sorteo.service.ts
import { ActivityType, Prisma, Role, SorteoStatus, TicketStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import {
  CreateSorteoDTO,
  EvaluateSorteoDTO,
  UpdateSorteoDTO,
} from "../dto/sorteo.dto";
import { formatIsoLocal, normalizeDateCR, formatDateCRWithTZ } from "../../../utils/datetime";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { resolveDateRange } from "../../../utils/dateRange";
import logger from "../../../core/logger";
import { getExcludedTicketIds } from "./sorteo-listas.helpers";
import { resolveDigits } from "../../../utils/loteriaRules";
import { parseCommissionPolicy, CommissionPolicy, CommissionRule } from "../../../services/commission.resolver";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { crDateService } from "../../../utils/crDateService";
import { getPreviousMonthFinalBalance } from "./accounts/accounts.balances";
import { CacheService } from "../../../core/cache.service";
import crypto from 'crypto';

const FINAL_STATES: Set<SorteoStatus> = new Set([
  SorteoStatus.EVALUATED,
  SorteoStatus.CLOSED,
]);
const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

function extractReventadoEnabled(loteria: any): boolean {
  if (!loteria || typeof loteria !== "object") return false;
  const rules = (loteria as any)?.rulesJson;
  if (!rules || typeof rules !== "object") return false;
  try {
    return Boolean((rules as any)?.reventadoConfig?.enabled);
  } catch {
    return false;
  }
}

function sanitizeLoteria(loteria: any) {
  if (!loteria || typeof loteria !== "object") return loteria;
  const { rulesJson, ...rest } = loteria;
  return rest;
}

function serializeSorteo<T extends { scheduledAt?: Date | null; loteria?: any; hasSales?: boolean; ticketCount?: number }>(sorteo: T) {
  if (!sorteo) return sorteo;
  const reventadoEnabled = extractReventadoEnabled(sorteo.loteria);
  const serialized = {
    ...sorteo,
    scheduledAt: sorteo.scheduledAt ? formatIsoLocal(sorteo.scheduledAt) : null,
    reventadoEnabled,
    //  NUEVO: Campos de ventas (opcionales para compatibilidad)
    ...(sorteo.hasSales !== undefined ? { hasSales: sorteo.hasSales } : {}),
    ...(sorteo.ticketCount !== undefined ? { ticketCount: sorteo.ticketCount } : {}),
  };
  if (sorteo.loteria) {
    (serialized as any).loteria = sanitizeLoteria(sorteo.loteria);
  }
  return serialized;
}

function serializeSorteos<T extends { scheduledAt?: Date | null }>(sorteos: T[]) {
  return sorteos.map((s) => serializeSorteo(s));
}

/**
 * Formatea una hora en formato 12h con AM/PM
 * Ejemplo: "14:30" → "2:30PM", "09:15" → "9:15AM"
 */
function formatTime12h(date: Date): string {
  const { hour, minute } = getCRLocalComponents(date); //  Usar utilidad CR
  const ampm = hour >= 12 ? 'PM' : 'AM';
  let hours12 = hour % 12;
  hours12 = hours12 ? hours12 : 12; // 0 debe ser 12
  const minutesStr = String(minute).padStart(2, '0');
  return `${hours12}:${minutesStr}${ampm} `;
}

/**
 * Extrae la fecha en formato YYYY-MM-DD de un Date
 */
function formatDateOnly(date: Date): string {
  const { year, month, day } = getCRLocalComponents(date); //  Usar utilidad CR
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export const SorteoService = {
  async create(data: CreateSorteoDTO, userId: string) {
    //  Obtener lotería con rulesJson para heredar digits
    const loteria = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { id: true, isActive: true, rulesJson: true },
    });
    if (!loteria || !loteria.isActive)
      throw new AppError("Lotería no encontrada", 404);

    //  Heredar digits de la lotería si no se proporciona explícitamente
    const loteriaRules = loteria.rulesJson as any;
    const inheritedDigits = resolveDigits(loteriaRules);
    const finalDigits = data.digits ?? inheritedDigits;

    // Crear sorteo con digits heredado o explícito
    const s = await SorteoRepository.create({
      ...data,
      digits: finalDigits,
    });

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const loteriaObj = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { name: true }
    });
    const scheduledAtFormatted = formatDateCRWithTZ(normalizeDateCR(data.scheduledAt, 'scheduledAt'));

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      loteriaName: loteriaObj?.name || 'N/A',
      scheduledAt: scheduledAtFormatted,
      digits: finalDigits,
      digitsSource: data.digits ? 'explicit' : 'inherited',
      description: `Sorteo creado para ${loteriaObj?.name || 'N/A'} programado para el ${scheduledAtFormatted}`,
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_CREATE,
      targetType: "SORTEO",
      targetId: s.id,
      details,
    });

    return serializeSorteo(s);
  },

  async update(id: string, data: UpdateSorteoDTO, userId: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (FINAL_STATES.has(existing.status)) {
      throw new AppError("No se puede editar un sorteo evaluado o cerrado", 409);
    }

    // Validar cambio de lotería solo desde SCHEDULED
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) {
      if (existing.status !== "SCHEDULED") {
        throw new AppError("Solo se puede cambiar la lotería en estado SCHEDULED", 409);
      }
      const loteria = await prisma.loteria.findUnique({ where: { id: data.loteriaId }, select: { id: true, isActive: true } });
      if (!loteria || !loteria.isActive) throw new AppError("Lotería no encontrada", 404);
    }

    const s = await SorteoRepository.update(id, {
      name: data.name,
      loteriaId: data.loteriaId,
      scheduledAt: data.scheduledAt,
      digits: data.digits, //  Allow updating digits
      isActive: data.isActive,
    } as UpdateSorteoDTO);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const details: Record<string, any> = {};
    if (data.name && data.name !== existing.name) details.name = data.name;
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) details.loteriaId = data.loteriaId;
    if (data.scheduledAt) {
      details.scheduledAt = formatDateCRWithTZ(normalizeDateCR(data.scheduledAt, 'scheduledAt')); //  Normalizar y formatear con timezone
    }
    if (data.digits && data.digits !== (existing as any).digits) {
      details.digits = data.digits;
    }
    if (data.isActive !== undefined && data.isActive !== (existing as any).isActive) {
      details.isActive = data.isActive;
    }

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        ...details,
        description: `Actualización de datos para ${sorteoDesc}`
      },
    });

    return serializeSorteo(s);
  },

  /**
   * Activa o desactiva un sorteo sin importar su estado
   * Útil para activar sorteos que están en CLOSED o EVALUATED
   */
  async setActive(id: string, isActive: boolean, userId: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const s = await SorteoRepository.update(id, {
      isActive,
    } as UpdateSorteoDTO);

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: { 
        isActive, 
        previousIsActive: (existing as any).isActive,
        description: `Sorteo ${sorteoDesc} marcado como ${isActive ? 'ACTIVO' : 'INACTIVO'}`
      },
    });

    return serializeSorteo(s);
  },

  /**
   * Fuerza el cambio de estado a OPEN desde cualquier estado (excepto EVALUATED)
   * Útil para reabrir sorteos que están en CLOSED
   */
  async forceOpen(id: string, userId: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    const s = await SorteoRepository.forceOpen(id);

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
      forced: true,
      description: `Sorteo ${sorteoDesc} RE-ABIERTO forzadamente (Estado anterior: ${existing.status})`
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_OPEN,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  /**
   * Activa un sorteo y lo pone en estado OPEN en una sola operación
   * Útil para reactivar sorteos que están inactivos y cerrados
   */
  async activateAndOpen(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    // Actualizar isActive y status en una sola operación
    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        isActive: true,
        status: SorteoStatus.OPEN,
      },
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });

    const details: Prisma.InputJsonObject = {
      from: {
        status: existing.status,
        isActive: (existing as any).isActive,
      },
      to: {
        status: SorteoStatus.OPEN,
        isActive: true,
      },
      forced: true,
    };

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        ...details,
        description: `Sorteo ${sorteoDesc} activado y abierto forzadamente`
      },
    });

    logger.info({
      layer: "service",
      action: "SORTEO_ACTIVATE_AND_OPEN",
      userId,
      payload: {
        sorteoId: id,
        previousStatus: existing.status,
        previousIsActive: (existing as any).isActive,
      },
    });

    return serializeSorteo(s);
  },

  /**
   * Actualiza un sorteo a estado SCHEDULED y isActive=true
   * Útil para resetear sorteos a estado inicial
   */
  async resetToScheduled(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    //  NUEVA VALIDACIÓN: Permitir reset desde SCHEDULED, OPEN, CLOSED, EVALUATED
    // (cualquier estado excepto aquellos que requieren pasos previos)
    const allowedStatuses = [
      SorteoStatus.SCHEDULED,
      SorteoStatus.OPEN,
      SorteoStatus.CLOSED,
      SorteoStatus.EVALUATED,
    ];

    if (!allowedStatuses.includes(existing.status)) {
      throw new AppError(
        `No se puede resetear a SCHEDULED desde estado ${existing.status} `,
        409
      );
    }

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        // Limpiar campos de cascada
        deletedByCascade: false,
        deletedByCascadeFrom: null,
        deletedByCascadeId: null,
      },
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });

    const sFormattedAt = formatDateCRWithTZ(s.scheduledAt);
    const lotName = s.loteria?.name || 'Lotería';
    const sorteoDesc = `${s.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        previousStatus: existing.status,
        previousIsActive: (existing as any).isActive,
        description: `Sorteo ${sorteoDesc} reseteado a estado PROGRAMADO`
      },
    });

    return serializeSorteo(s);
  },

  async open(id: string, userId: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.SCHEDULED) {
      throw new AppError("Solo se puede abrir desde SCHEDULED", 409);
    }
    if (!(existing as any).isActive) {
      throw new AppError("No se puede abrir un sorteo inactivo", 409);
    }

    const s = await SorteoRepository.open(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
      description: `Sorteo ${sorteoDesc} ABIERTO`
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_OPEN,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async close(id: string, userId: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.OPEN && existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede cerrar desde OPEN o EVALUATED", 409);
    }

    //  NUEVA: Usar closeWithCascade() para marcar tickets también
    const { sorteo: s, ticketsAffected } = await SorteoRepository.closeWithCascade(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.CLOSED,
      ticketsClosed: ticketsAffected,  //  NUEVO: Registrar cuántos tickets se marcaron
      description: `Sorteo ${sorteoDesc} CERRADO (${ticketsAffected} tickets afectados)`
    };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_CLOSE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async evaluate(id: string, body: EvaluateSorteoDTO, userId: string) {
    const {
      winningNumber,
      extraMultiplierId = null,
      extraOutcomeCode: extraOutcomeCodeInput = null,
    } = body;

    if (!winningNumber?.length)
      throw new AppError("winningNumber es requerido", 400);

    // 1) Cargar sorteo y validar estado
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (!EVALUABLE_STATES.has(existing.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409);
    }

    // 2) Validar longitud del número ganador según configuración del sorteo
    const requiredDigits = (existing as any).digits ?? 2;
    if (winningNumber.length !== requiredDigits) {
      throw new AppError(
        `El número ganador debe tener ${requiredDigits} dígitos (recibido: ${winningNumber.length})`,
        400
      );
    }

    // 3) Resolver multiplicador extra (si viene) y etiqueta neutra
    // Si no viene extraMultiplierId, significa que no salió multiplicador → extraX = 0
    let extraX: number = 0;
    let extraOutcomeCode: string | null = null;

    if (extraMultiplierId) {
      const mul = await prisma.loteriaMultiplier.findUnique({
        where: { id: extraMultiplierId },
        select: {
          id: true,
          valueX: true,
          isActive: true,
          loteriaId: true,
          kind: true,
          name: true,
          appliesToSorteoId: true,
        },
      });

      if (!mul || !mul.isActive)
        throw new AppError("extraMultiplierId inválido o inactivo", 400);
      if (mul.loteriaId !== existing.loteriaId) {
        throw new AppError(
          "extraMultiplierId no pertenece a la lotería del sorteo",
          400
        );
      }
      if (mul.kind !== "REVENTADO") {
        throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
      }
      if (mul.appliesToSorteoId && mul.appliesToSorteoId !== id) {
        throw new AppError("extraMultiplierId no aplica a este sorteo", 400);
      }

      extraX = mul.valueX;
      extraOutcomeCode = (extraOutcomeCodeInput ?? mul.name ?? null) || null;
    }

    //  NUEVO: Obtener tickets excluidos ANTES de evaluar
    const excludedTicketIds = await getExcludedTicketIds(id);

    // 3) Transacción (timeout aumentado para sorteos con muchos ganadores)
    const evaluationResult = await prisma.$transaction(async (tx) => {
      // 3.1 Snapshot del sorteo
      await tx.sorteo.update({
        where: { id },
        data: {
          status: "EVALUATED",
          winningNumber,
          extraOutcomeCode,
          ...(extraMultiplierId
            ? { extraMultiplier: { connect: { id: extraMultiplierId } } }
            : { extraMultiplier: { disconnect: true } }),
          extraMultiplierX: extraX,
        },
      });

      const excludedArray = Array.from(excludedTicketIds);

      // 3.2 Marcar ganadores por NUMERO usando SQL raw para evitar cargar miles en memoria
      await tx.$executeRaw`
        UPDATE "Jugada" j
        SET "isWinner" = true,
            "payout" = j."amount" * j."finalMultiplierX"
        FROM "Ticket" t
        WHERE j."ticketId" = t.id 
        AND t."sorteoId" = ${id}::uuid
        AND t."status" != 'CANCELLED'
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."type" = 'NUMERO'
        AND j."number" = ${winningNumber}
        AND j."isActive" = true
        AND t.id NOT IN (SELECT unnest(${excludedArray}::uuid[]))
      `;

      // 3.3 Marcar ganadores por REVENTADO (si aplica)
      if (extraX > 0) {
        await tx.$executeRaw`
          UPDATE "Jugada" j
          SET "isWinner" = true,
              "finalMultiplierX" = ${extraX},
              "payout" = j."amount" * ${extraX},
              "multiplierId" = ${extraMultiplierId}::uuid
          FROM "Ticket" t
          WHERE j."ticketId" = t.id 
          AND t."sorteoId" = ${id}::uuid
          AND t."status" != 'CANCELLED'
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."type" = 'REVENTADO'
          AND j."reventadoNumber" = ${winningNumber}
          AND j."isActive" = true
          AND t.id NOT IN (SELECT unnest(${excludedArray}::uuid[]))
        `;
      }

      // 3.4 Marcar todos los tickets activos como EVALUATED e isWinner=false (base)
      await tx.ticket.updateMany({
        where: { 
          sorteoId: id,
          status: { not: 'CANCELLED' },
          isActive: true,
          deletedAt: null,
          id: { notIn: excludedArray }
        },
        data: { status: "EVALUATED", isWinner: false },
      });

      // 3.5 Marcar tickets ganadores y calcular totalPayout en una sola operación SQL
      await tx.$executeRaw`
        WITH Payouts AS (
          SELECT "ticketId", SUM("payout") as total
          FROM "Jugada"
          WHERE "ticketId" IN (
            SELECT id FROM "Ticket" 
            WHERE "sorteoId" = ${id}::uuid 
            AND id NOT IN (SELECT unnest(${excludedArray}::uuid[]))
          )
          AND "isWinner" = true
          GROUP BY "ticketId"
        )
        UPDATE "Ticket" t
        SET "isWinner" = true,
            "totalPayout" = p.total,
            "remainingAmount" = p.total,
            "totalPaid" = 0
        FROM Payouts p
        WHERE t.id = p."ticketId"
      `;

      // 3.6 Obtener conteo de ganadores para auditoría
      const winnersCount = await tx.ticket.count({
        where: { sorteoId: id, isWinner: true }
      });

      await tx.sorteo.update({
        where: { id },
        data: {
          hasWinner: winnersCount > 0,
        },
      });

      // 3.7 Auditoría interna
      const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
      const lotName = (existing as any).loteria?.name || 'Lotería';
      const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;
      const evaluationDesc = `Sorteo ${sorteoDesc} EVALUADO. Número ganador: ${winningNumber}${extraOutcomeCode ? ` (${extraOutcomeCode})` : ''}. Ganadores: ${winnersCount}`;

      await tx.activityLog.create({
        data: {
          userId,
          action: "SORTEO_EVALUATE",
          targetType: "SORTEO",
          targetId: id,
          details: {
            winningNumber,
            extraMultiplierId,
            extraMultiplierX: extraX,
            extraOutcomeCode,
            winners: winnersCount,
            description: evaluationDesc
          },
        },
      });

      return { winners: winnersCount, extraMultiplierX: extraX };
    }, { timeout: 180000 }); // 3 minutos para sorteos con muchos tickets/jugadas // 3 minutos para sorteos con muchos tickets/jugadas

    // 4) Log adicional
    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = (existing as any).loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;
    const evaluationDesc = `Sorteo ${sorteoDesc} EVALUADO. Número ganador: ${winningNumber}${extraOutcomeCode ? ` (${extraOutcomeCode})` : ''}. Ganadores: ${evaluationResult.winners}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_EVALUATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        winningNumber,
        extraMultiplierId,
        extraMultiplierX: evaluationResult.extraMultiplierX,
        extraOutcomeCode,
        winners: evaluationResult.winners,
        description: evaluationDesc
      },
    });

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    //  FASE BE-2: Invalidar cache de resúmenes (evaluación cambia premios)
    CacheService.invalidateTag(`sorteo:${id}`).catch(err => {
      logger.warn({ layer: 'cache', action: 'INVALIDATE_ERROR_ON_EVALUATE', payload: { sorteoId: id, error: err.message } });
    });

    //  CRÍTICO: Sincronizar AccountStatement de todos los días afectados cuando se evalúa un sorteo
    // La evaluación marca jugadas como ganadoras, afectando totalPayouts del statement
    // Los sorteos se evalúan conforme van sucediendo, y es ahí cuando los tickets se toman en cuenta
    // ️ IMPORTANTE: Usar el nuevo servicio de sincronización que actualiza accumulatedBalance
    let syncError: string | null = null;
    try {
      const { AccountStatementSyncService } = await import('./accounts/accounts.sync.service');

      // ️ CRÍTICO: Convertir scheduledAt a fecha CR antes de sincronizar
      const { crDateService } = await import('../../../utils/crDateService');
      const sorteoDateCR = crDateService.dateUTCToCRString(existing.scheduledAt);
      const [year, month, day] = sorteoDateCR.split('-').map(Number);
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      await AccountStatementSyncService.syncSorteoStatements(id, sorteoDateUTC);

      logger.info({
        layer: 'service',
        action: 'ACCOUNT_STATEMENT_SYNCED_ON_SORTEO_EVALUATE',
        payload: {
          sorteoId: id,
          sorteoDateCR,
        }
      });
    } catch (err) {
      syncError = (err as Error).message;
      logger.error({
        layer: 'service',
        action: 'ACCOUNT_STATEMENT_SYNC_ERROR_ON_SORTEO_EVALUATE',
        payload: {
          error: syncError,
          sorteoId: id,
        }
      });
      // No relanzar - la evaluación ya commiteó, pero el error se incluye en la respuesta
    }

    // 5) Obtener sorteo evaluado para devolver
    const evaluated = await SorteoRepository.findById(id);
    const result = evaluated ? serializeSorteo(evaluated) : evaluated;

    // Incluir warning de sync si hubo error (el frontend puede mostrarlo)
    if (syncError && result) {
      (result as any).syncWarning = `Statement sync falló: ${syncError}`;
    }

    return result;
  },

  async remove(id: string, userId: string, reason?: string) {
    // Inactivación manual: deletedByCascade = false
    const s = await SorteoRepository.softDelete(id, userId, reason, false);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const details: Record<string, any> = {};
    if (reason) details.reason = reason;

    await ActivityService.log({
      userId,
      action: ActivityType.SOFT_DELETE,
      targetType: "SORTEO",
      targetId: id,
      details: details as Prisma.InputJsonObject,
    });

    return serializeSorteo(s);
  },

  async restore(id: string, userId: string) {
    const s = await SorteoRepository.restore(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    await ActivityService.log({
      userId,
      action: ActivityType.RESTORE,
      targetType: "SORTEO",
      targetId: id,
      details: { restored: true },
    });

    return serializeSorteo(s);
  },

  async revertEvaluation(id: string, userId: string, reason?: string) {
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      include: { loteria: { select: { name: true } } }
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
    }

    const reverted = await SorteoRepository.revertEvaluation(id);

    // Sincronizar AccountStatements después de revertir
    let syncError: string | null = null;
    try {
      const { AccountStatementSyncService } = await import('./accounts/accounts.sync.service');
      const { crDateService } = await import('../../../utils/crDateService');
      const sorteoDateCR = crDateService.dateUTCToCRString(existing.scheduledAt);
      const [year, month, day] = sorteoDateCR.split('-').map(Number);
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      await AccountStatementSyncService.syncSorteoStatements(id, sorteoDateUTC);

      logger.info({
        layer: 'service',
        action: 'ACCOUNT_STATEMENT_SYNCED_ON_SORTEO_REVERT',
        payload: {
          sorteoId: id,
          sorteoDateCR,
        }
      });
    } catch (err) {
      syncError = (err as Error).message;
      logger.error({
        layer: 'service',
        action: 'ACCOUNT_STATEMENT_SYNC_ERROR_ON_SORTEO_REVERT',
        payload: {
          sorteoId: id,
          error: syncError,
        }
      });
      // No relanzar - la reversión ya commiteó, pero el error se incluye en la respuesta
    }

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_REOPEN,
      targetType: "SORTEO",
      targetId: id,
      details: {
        reason: reason ?? null,
        previousWinningNumber: existing.winningNumber,
        previousExtraMultiplierId: existing.extraMultiplierId,
        description: `Evaluación de ${sorteoDesc} REVERTIDA. Razón: ${reason ?? 'No especificada'}`
      },
    });

    const result = serializeSorteo(reverted);

    if (syncError) {
      (result as any).syncWarning = `Statement sync falló: ${syncError}`;
    }

    return result;
  },

  /**
   *  Helper: Obtener multiplicadores activos tipo NUMERO de una lotería
   */
  async getActiveMultipliers(loteriaId: string): Promise<Array<{ id: string; valueX: number }>> {
    const multipliers = await prisma.loteriaMultiplier.findMany({
      where: {
        loteriaId,
        kind: 'NUMERO',
        isActive: true,
      },
      select: {
        id: true,
        valueX: true,
      },
    });
    return multipliers;
  },

  /**
   * Helper: Obtener política de comisiones del VENDEDOR (solo nivel USER).
   * La política de VENTANA NO se usa como fallback para filtrado de sorteos/multiplicadores.
   * La política de VENTANA solo se usa para registrar la comisión de la ventana en ticket/jugadas.
   */
  async getCommissionPolicy(userId: string, ventanaId: string | null | undefined): Promise<CommissionPolicy | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { commissionPolicyJson: true },
    });

    const policyJson = user?.commissionPolicyJson ?? null;
    if (!policyJson) {
      return null;
    }

    return parseCommissionPolicy(policyJson, 'USER');
  },

  /**
   *  Helper: Verificar si un sorteo debe mostrarse según política de comisiones
   * Solo muestra si hay reglas específicas que cubran al menos un multiplicador activo
   * NO considera defaultPercent - solo reglas explícitas
   */
  async shouldShowSorteo(
    sorteo: { id: string; loteriaId: string },
    activeMultipliers: Array<{ id: string; valueX: number }>,
    commissionPolicy: CommissionPolicy
  ): Promise<boolean> {
    // Si la lotería no tiene multiplicadores activos, NO mostrar
    // (vendedores solo ven sorteos con multiplicador Y esquema de comisiones)
    if (!activeMultipliers || activeMultipliers.length === 0) {
      return false;
    }

    // Verificar si AL MENOS UN multiplicador tiene regla específica
    const hasPolicyForAnyMultiplier = activeMultipliers.some(multiplier => {
      const multiplierValue = multiplier.valueX;

      // Buscar regla específica que cubra este multiplicador
      const matchingRule = commissionPolicy.rules.find(rule => {
        // Verificar rango de multiplicador
        if (!rule.multiplierRange) {
          return false; // Solo considerar reglas con rango explícito
        }

        const inRange = multiplierValue >= rule.multiplierRange.min &&
          multiplierValue <= rule.multiplierRange.max;

        if (!inRange) return false;

        // Si tiene loteriaId específica, debe coincidir (null = aplica a todas)
        if (rule.loteriaId !== null && rule.loteriaId !== sorteo.loteriaId) {
          return false;
        }

        // Verificar tipo de apuesta (NUMERO, REVENTADO, o null para ambos)
        if (rule.betType !== null && rule.betType !== 'NUMERO') {
          return false;
        }

        return true;
      });

      // Si hay regla específica para este multiplicador, tiene política
      return matchingRule !== undefined;
    });

    // Solo mostrar si hay reglas específicas que cubran algún multiplicador
    // NO se considera defaultPercent - solo reglas explícitas
    return hasPolicyForAnyMultiplier;
  },

  /**
   *  Helper: Filtrar sorteos por política de comisiones
   * Solo aplica para VENDEDOR - otros roles ven todos los sorteos
   */
  async filterSorteosByCommissionPolicy(
    sorteos: Array<{ id: string; loteriaId: string }>,
    userId: string,
    ventanaId: string
  ): Promise<{ filteredSorteos: Array<{ id: string; loteriaId: string }>; filteredTotal: number }> {
    // Obtener política de comisiones
    const commissionPolicy = await this.getCommissionPolicy(userId, ventanaId);

    // Si no hay política, no mostrar ningún sorteo al vendedor
    if (!commissionPolicy) {
      logger.debug({
        layer: "service",
        action: "SORTEO_FILTERED_NO_POLICY",
        payload: {
          userId,
          reason: "NO_COMMISSION_POLICY",
          hiddenCount: sorteos.length,
        },
      });

      return {
        filteredSorteos: [],
        filteredTotal: 0,
      };
    }

    // Filtrar sorteos según política
    const filteredSorteos: Array<{ id: string; loteriaId: string }> = [];

    //  OPTIMIZACIÓN: Agrupar sorteos por loteriaId para evitar queries duplicadas
    const loteriaIds = [...new Set(sorteos.map(s => s.loteriaId))];
    const multipliersByLoteria = new Map<string, Array<{ id: string; valueX: number }>>();

    // Obtener multiplicadores para todas las loterías en paralelo
    await Promise.all(
      loteriaIds.map(async (loteriaId) => {
        const multipliers = await this.getActiveMultipliers(loteriaId);
        multipliersByLoteria.set(loteriaId, multipliers);
      })
    );

    // Verificar cada sorteo
    for (const sorteo of sorteos) {
      const multipliers = multipliersByLoteria.get(sorteo.loteriaId) || [];
      const shouldShow = await this.shouldShowSorteo(sorteo, multipliers, commissionPolicy);

      if (shouldShow) {
        filteredSorteos.push(sorteo);
      } else {
        logger.debug({
          layer: "service",
          action: "SORTEO_FILTERED_NO_SPECIFIC_RULE",
          payload: {
            sorteoId: sorteo.id,
            loteriaId: sorteo.loteriaId,
            userId,
            multipliersCount: multipliers.length,
            reason: "NO_SPECIFIC_RULE_FOR_MULTIPLIERS",
          },
        });
      }
    }

    return {
      filteredSorteos,
      filteredTotal: filteredSorteos.length,
    };
  },

  async list(params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: "hour" | "loteria-hour";
    lastId?: string;
    lastScheduledAt?: Date;
    //  NUEVO: Información del usuario para filtrado por política de comisiones
    userId?: string;
    role?: Role;
    ventanaId?: string | null;
  }) {
    // Early return: sin groupBy, usar lógica existente
    if (!params.groupBy) {
      const p = params.page && params.page > 0 ? params.page : 1;
      const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

      //  Para VENDEDOR, no usar caché (cada vendedor tiene políticas diferentes)
      // Para otros roles, usar caché normalmente
      const isVendedor = params.role === Role.VENDEDOR;

      if (!isVendedor) {
        // Intentar obtener del cache solo para ADMIN/VENTANA
        const { getCachedSorteoList, setCachedSorteoList } = require('../../../utils/sorteoCache');
        const cached = getCachedSorteoList({
          loteriaId: params.loteriaId,
          page: p,
          pageSize: ps,
          status: params.status,
          search: params.search?.trim() || undefined,
          isActive: params.isActive,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          lastId: params.lastId,
          lastScheduledAt: params.lastScheduledAt,
        });

        if (cached) {
          return cached;
        }
      }

      const { data, total } = await SorteoRepository.list({
        page: p,
        pageSize: ps,
        loteriaId: params.loteriaId,
        status: params.status,
        search: params.search?.trim() || undefined,
        isActive: params.isActive,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        lastId: params.lastId,
        lastScheduledAt: params.lastScheduledAt,
      });

      //  Aplicar filtrado por política de comisiones solo para VENDEDOR
      let filteredData = data;
      let filteredTotal = total;

      if (isVendedor && params.userId && params.ventanaId) {
        const filterResult = await this.filterSorteosByCommissionPolicy(
          data.map(s => ({ id: s.id, loteriaId: s.loteriaId })),
          params.userId,
          params.ventanaId
        );

        // Crear Set de IDs filtrados para mantener el orden y estructura completa
        const filteredIds = new Set(filterResult.filteredSorteos.map(s => s.id));
        filteredData = data.filter(s => filteredIds.has(s.id));
        filteredTotal = filterResult.filteredTotal;

        logger.info({
          layer: "service",
          action: "SORTEO_LIST_FILTERED_BY_COMMISSION_POLICY",
          payload: {
            userId: params.userId,
            role: params.role,
            originalCount: data.length,
            filteredCount: filteredData.length,
            hiddenCount: data.length - filteredData.length,
          },
        });
      }

      const serialized = serializeSorteos(filteredData);
      const totalPages = Math.ceil(filteredTotal / ps);
      const result = {
        data: serialized,
        meta: {
          total: filteredTotal,
          page: p,
          pageSize: ps,
          totalPages,
          hasNextPage: p < totalPages,
          hasPrevPage: p > 1,
          grouped: false,
          groupBy: null,
        },
      };

      // Guardar en cache solo para ADMIN/VENTANA
      if (!isVendedor) {
        const { setCachedSorteoList } = require('../../../utils/sorteoCache');
        setCachedSorteoList(
          {
            loteriaId: params.loteriaId,
            page: p,
            pageSize: ps,
            status: params.status,
            search: params.search?.trim() || undefined,
            isActive: params.isActive,
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
          },
          result.data,
          result.meta
        );
      }

      return result;
    }

    // Con groupBy, usar query SQL optimizada
    if (params.groupBy === "loteria-hour") {
      return this.groupedByLoteriaHour(params);
    }

    if (params.groupBy === "hour") {
      return this.groupedByHour(params);
    }

    throw new AppError(`Unsupported groupBy: ${params.groupBy} `, 400);
  },

  /**
   * Agrupa sorteos por loteriaId + hora (extraída de scheduledAt)
   * Usa SQL GROUP BY para eficiencia
   */
  async groupedByLoteriaHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    // Construir condiciones WHERE
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}:: uuid`);
    }

    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}:: text`);
    }

    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive} `);
    }

    if (params.dateFrom || params.dateTo) {
      if (params.dateFrom) {
        whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} `);
      }
      if (params.dateTo) {
        whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} `);
      }
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")} `
      : Prisma.empty;

    // Query SQL con GROUP BY (PostgreSQL)
    // Usar CTE para evitar problemas con GROUP BY en subquery
    const query = Prisma.sql`
      WITH grouped_sorteos AS(
  SELECT
          s."loteriaId",
  l.name as "loteriaName",
  TO_CHAR(
    s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
    'HH24:MI'
  ) as "hour24",
  TO_CHAR(
    s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
    'HH12:MI AM'
  ) as "hour12",
  COUNT(*):: int as count,
  MAX(s."scheduledAt") as "mostRecentDate",
  STRING_AGG(s.id:: text, ',') as "sorteoIds"
        FROM "Sorteo" s
        INNER JOIN "Loteria" l ON l.id = s."loteriaId"
        ${whereClause}
        GROUP BY 
          s."loteriaId",
  l.name,
  TO_CHAR(
    s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
    'HH24:MI'
  ),
  TO_CHAR(
    s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
    'HH12:MI AM'
  )
)
SELECT
gs."loteriaId",
  gs."loteriaName",
    gs."hour24",
      gs."hour12",
        gs.count,
        gs."mostRecentDate",
          gs."sorteoIds",
            (
              SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."loteriaId" = gs."loteriaId"
            AND s2."deletedAt" IS NULL
            AND TO_CHAR(
                s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
                'HH24:MI'
              ) = gs."hour24"
            ${params.dateFrom ? Prisma.sql`AND s2."scheduledAt" >= ${params.dateFrom}` : Prisma.empty}
            ${params.dateTo ? Prisma.sql`AND s2."scheduledAt" <= ${params.dateTo}` : Prisma.empty}
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY
gs."loteriaName" ASC,
  gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteriaName: string;
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    // Formatear respuesta
    // Ordenar sorteoIds por fecha (obtener IDs ordenados por scheduledAt DESC)
    const data = await Promise.all(
      results.map(async (row) => {
        // Obtener IDs ordenados por fecha descendente
        const sorteoIdsArray = row.sorteoIds.split(",");
        const sorteosWithDates = await prisma.sorteo.findMany({
          where: {
            id: { in: sorteoIdsArray },
            ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          },
          select: {
            id: true,
            scheduledAt: true,
          },
          orderBy: {
            scheduledAt: "desc",
          },
        });
        const sortedIds = sorteosWithDates.map((s) => s.id);

        return {
          loteriaId: row.loteriaId,
          loteriaName: row.loteriaName,
          hour: row.hour12.trim(), // Formato 12h para display (trim para quitar espacios)
          hour24: row.hour24, // Formato 24h para ordenamiento
          sorteoIds: sortedIds, // Array ordenado por fecha descendente
          count: row.count,
          mostRecentSorteoId: row.mostRecentSorteoId,
          mostRecentDate: formatDateOnly(row.mostRecentDate),
        };
      })
    );

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "loteria-hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  },

  /**
   * Agrupa sorteos solo por hora (útil cuando ya se filtró por loteriaId)
   * Usa SQL GROUP BY para eficiencia
   */
  async groupedByHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    // Construir condiciones WHERE
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}:: uuid`);
    }

    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}:: text`);
    }

    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive} `);
    }

    if (params.dateFrom || params.dateTo) {
      if (params.dateFrom) {
        whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} `);
      }
      if (params.dateTo) {
        whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} `);
      }
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")} `
      : Prisma.empty;

    // Query SQL con GROUP BY solo por hora (PostgreSQL)
    // Usar CTE para evitar problemas con GROUP BY en subquery
    const query = Prisma.sql`
      WITH grouped_sorteos AS(
    SELECT
          TO_CHAR(
      s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
      'HH24:MI'
    ) as "hour24",
    TO_CHAR(
      s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
      'HH12:MI AM'
    ) as "hour12",
    COUNT(*):: int as count,
    MAX(s."scheduledAt") as "mostRecentDate",
    STRING_AGG(s.id:: text, ',') as "sorteoIds"
        FROM "Sorteo" s
        ${whereClause}
        GROUP BY 
          TO_CHAR(
      s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
      'HH24:MI'
    ),
    TO_CHAR(
      s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
      'HH12:MI AM'
    )
  )
SELECT
gs."hour24",
  gs."hour12",
    gs.count,
    gs."mostRecentDate",
      gs."sorteoIds",
        (
          SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."deletedAt" IS NULL
            AND TO_CHAR(
            s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ) = gs."hour24"
            ${params.loteriaId ? Prisma.sql`AND s2."loteriaId" = ${params.loteriaId}::uuid` : Prisma.empty}
            ${params.dateFrom ? Prisma.sql`AND s2."scheduledAt" >= ${params.dateFrom}` : Prisma.empty}
            ${params.dateTo ? Prisma.sql`AND s2."scheduledAt" <= ${params.dateTo}` : Prisma.empty}
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY
gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    // Formatear respuesta
    // Ordenar sorteoIds por fecha (obtener IDs ordenados por scheduledAt DESC)
    const data = await Promise.all(
      results.map(async (row) => {
        // Obtener IDs ordenados por fecha descendente
        const sorteoIdsArray = row.sorteoIds.split(",");
        const sorteosWithDates = await prisma.sorteo.findMany({
          where: {
            id: { in: sorteoIdsArray },
            ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          },
          select: {
            id: true,
            scheduledAt: true,
          },
          orderBy: {
            scheduledAt: "desc",
          },
        });
        const sortedIds = sorteosWithDates.map((s) => s.id);

        return {
          hour: row.hour12.trim(), // Formato 12h para display
          hour24: row.hour24, // Formato 24h para ordenamiento
          sorteoIds: sortedIds, // Array ordenado por fecha descendente
          count: row.count,
          mostRecentSorteoId: row.mostRecentSorteoId,
          mostRecentDate: formatDateOnly(row.mostRecentDate),
        };
      })
    );

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  },

  async findById(id: string) {
    const sorteo = await SorteoRepository.findById(id);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return serializeSorteo(sorteo);
  },

  /**
   * Obtiene resumen de sorteos evaluados y/o abiertos con datos financieros agregados
   * GET /api/v1/sorteos/evaluated-summary
   * Por defecto filtra por EVALUATED y OPEN, pero puede especificarse con el parámetro status
   */
  async evaluatedSummary(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      loteriaId?: string;
      status?: string;
      isActive?: string;
      ventanaId?: string;
      bancaId?: string;
      sorteoId?: string;
    },
    vendedorId?: string
  ) {
    //  FASE BE-2: Implementación de Cache-Aside con Coalescing
    const cacheKey = `banca:${params.bancaId || 'all'}:ventana:${params.ventanaId || 'all'}:vendedor:${vendedorId || 'all'}:summary:${crypto
      .createHash('md5')
      .update(JSON.stringify({ ...params, vendedorId }))
      .digest('hex')}`;

    const tags = ['report:summary'];
    if (vendedorId) tags.push(`vendedor:${vendedorId}`);
    if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
    if (params.bancaId) tags.push(`banca:${params.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    return CacheService.wrap(
      cacheKey,
      async () => {
        try {
          // Resolver rango de fechas
      const dateRange = resolveDateRange(
        params.date || "today",
        params.fromDate,
        params.toDate
      );

      //  CAMBIO: Forzar status EVALUATED (Global Filter)
      // Ya no permitimos que el cliente solicite otros estados para este reporte
      const allowedStatuses: SorteoStatus[] = [SorteoStatus.EVALUATED];

      // Ignorar params.status para garantizar integridad financiera
      if (params.status) {
        logger.warn({
          layer: "service",
          action: "SORTEO_EVALUATED_SUMMARY_FILTER_IGNORED",
          payload: {
            message: "Client requested specific status but was ignored due to Global Evaluated Rule",
            requestedStatus: params.status
          }
        });
      }

      // Construir filtro de status de tickets
      // Filtro de isActive: si no se proporciona, se asume true (solo tickets activos)
      const ticketIsActive = params.isActive !== 'false' && params.isActive !== '0';

      //  C3.4 OPTIMIZACIÓN: FASE 1 - Construcción dinámica de condiciones para optimización de índices
      const ticketConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = ${ticketIsActive}`,
        Prisma.sql`s.status = 'EVALUATED'`,
        Prisma.sql`s."scheduledAt" >= ${dateRange.fromAt}`,
        Prisma.sql`s."scheduledAt" <= ${dateRange.toAt}`
      ];

      // Aplicar filtros RBAC dinámicos (Vendedor, Ventana, Banca)
      if (vendedorId) ticketConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
      if (params.ventanaId) ticketConditions.push(Prisma.sql`t."ventanaId" = ${params.ventanaId}::uuid`);
      if (params.bancaId) ticketConditions.push(Prisma.sql`v."bancaId" = ${params.bancaId}::uuid`);
      if (params.loteriaId) ticketConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}::uuid`);

      const whereClause = Prisma.join(ticketConditions, ' AND ');

      //  C3.4 OPTIMIZACIÓN: Resolver rango mensual una sola vez (se usa en monthlyAccumulated)
      const monthlyRange = resolveDateRange("month");
      const monthlyStartDate = monthlyRange.fromAt;
      const monthlyEndDate = monthlyRange.toAt;

      // Determinar mes efectivo para previousMonthBalance
      const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
      const rangeEffectiveMonth = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}`;

      //  FASE 1 - Ejecutar la query consolidada de métricas y las de soporte (movimientos/balance anterior)
      const [consolidatedMetrics, movementsByDate, rangePreviousMonthBalance] = await Promise.all([
        prisma.$queryRaw<any[]>(Prisma.sql`
          WITH base_tickets AS (
            SELECT 
              t.id, t."sorteoId", t."totalAmount", t."totalCommission", t."totalPayout", t."isWinner", t.status,
              s."scheduledAt", s."loteriaId", s.name as "sorteoName", s."extraMultiplierId", s."extraMultiplierX",
              l.name as "loteriaName"
            FROM "Ticket" t
            JOIN "Sorteo" s ON t."sorteoId" = s.id
            JOIN "Loteria" l ON s."loteriaId" = l.id
            LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
            WHERE ${whereClause}
          ),
          sorteo_metrics AS (
            SELECT 
              "sorteoId", "scheduledAt", "loteriaId", "sorteoName", "extraMultiplierId", "extraMultiplierX", "loteriaName",
              SUM("totalAmount") as "totalSales",
              SUM("totalCommission") as "totalCommission",
              SUM(CASE WHEN "isWinner" THEN "totalPayout" ELSE 0 END) as "totalPrizes",
              COUNT(id) as "ticketCount",
              COUNT(CASE WHEN "isWinner" THEN 1 END) as "winningTicketsCount",
              COUNT(CASE WHEN status IN ('PAID', 'PAGADO') THEN 1 END) as "paidTicketsCount"
            FROM base_tickets
            GROUP BY "sorteoId", "scheduledAt", "loteriaId", "sorteoName", "extraMultiplierId", "extraMultiplierX", "loteriaName"
          ),
          multiplier_summary AS (
            SELECT 
              bt."sorteoId",
              j."multiplierId",
              m.name as "multiplierName",
              m."valueX" as "multiplierValue",
              SUM(j.amount) as "mSales",
              SUM(j."commissionAmount") as "mCommission",
              SUM(CASE WHEN j.type = 'NUMERO' THEN j."commissionAmount" ELSE 0 END) as "mCommNum",
              SUM(CASE WHEN j.type = 'REVENTADO' THEN j."commissionAmount" ELSE 0 END) as "mCommRev",
              SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END) as "mPrizes",
              COUNT(DISTINCT bt.id) as "mTickets",
              COUNT(CASE WHEN j."isWinner" THEN 1 END) as "mWinningTickets",
              COUNT(CASE WHEN bt.status IN ('PAID', 'PAGADO') THEN 1 END) as "mPaidTickets"
            FROM base_tickets bt
            JOIN "Jugada" j ON bt.id = j."ticketId"
            LEFT JOIN "LoteriaMultiplier" m ON j."multiplierId" = m.id
            WHERE j."deletedAt" IS NULL
            GROUP BY bt."sorteoId", j."multiplierId", m.name, m."valueX"
          ),
          multiplier_json AS (
            SELECT 
              "sorteoId",
              JSON_AGG(JSON_BUILD_OBJECT(
                'multiplierId', "multiplierId",
                'multiplierName', COALESCE("multiplierName", 'x1'),
                'multiplierValue', COALESCE("multiplierValue", 1),
                'totalSales', "mSales",
                'totalCommission', "mCommission",
                'commissionByNumber', "mCommNum",
                'commissionByReventado', "mCommRev",
                'totalPrizes', "mPrizes",
                'ticketCount', "mTickets",
                'winningTicketsCount', "mWinningTickets",
                'paidTicketsCount', "mPaidTickets",
                'unpaidTicketsCount', "mWinningTickets" - "mPaidTickets"
              ) ORDER BY "multiplierValue" ASC) as by_multiplier
            FROM multiplier_summary
            GROUP BY "sorteoId"
          )
          SELECT sm.*, mj.by_multiplier
          FROM sorteo_metrics sm
          LEFT JOIN multiplier_json mj ON sm."sorteoId" = mj."sorteoId"
          ORDER BY sm."scheduledAt" ASC, sm."loteriaId" ASC, sm."sorteoId" ASC
        `),
        AccountPaymentRepository.findMovementsByDateRange(
          dateRange.fromAt,
          dateRange.toAt,
          "vendedor",
          undefined,
          vendedorId
        ),
        getPreviousMonthFinalBalance(
          rangeEffectiveMonth,
          "vendedor",
          undefined,
          vendedorId,
          undefined
        ),
      ]);

      //  PASO 2: Construir datos de sorteos SIN calcular accumulated aún
      const sorteoData = consolidatedMetrics.map((row) => {
        // Calcular isReventado
        const isReventado =
          (row.extraMultiplierId !== null &&
            row.extraMultiplierId !== undefined) ||
          (row.extraMultiplierX !== null &&
            row.extraMultiplierX !== undefined &&
            row.extraMultiplierX > 0);

        // Calcular subtotal
        const subtotal =
          Number(row.totalSales) -
          Number(row.totalCommission) -
          Number(row.totalPrizes);

        const winningCount = Number(row.winningTicketsCount) || 0;
        const paidCount = Number(row.paidTicketsCount) || 0;
        const unpaidCount = winningCount - paidCount;

        // Mapear byMultiplier desde el JSON de la query
        const byMultiplierRaw = row.by_multiplier || [];
        const byMultiplier = byMultiplierRaw.map((m: any) => ({
          multiplierId: m.multiplierId,
          multiplierName: m.multiplierName,
          multiplierValue: Number(m.multiplierValue),
          totalSales: Number(m.totalSales),
          totalCommission: Number(m.totalCommission),
          commissionByNumber: Number(m.commissionByNumber),
          commissionByReventado: Number(m.commissionByReventado),
          totalPrizes: Number(m.totalPrizes),
          ticketCount: Number(m.ticketCount),
          subtotal: Number(m.totalSales) - Number(m.totalCommission) - Number(m.totalPrizes),
          winningTicketsCount: Number(m.winningTicketsCount),
          paidTicketsCount: Number(m.paidTicketsCount),
          unpaidTicketsCount: Number(m.unpaidTicketsCount),
        }));

        // NUEVO: Calcular comisiones por tipo agregadas desde multiplicadores
        const commissionByNumber = byMultiplier.reduce((sum: number, m: any) => sum + m.commissionByNumber, 0);
        const commissionByReventado = byMultiplier.reduce((sum: number, m: any) => sum + m.commissionByReventado, 0);

        return {
          sorteoId: row.sorteoId,
          sorteoName: row.sorteoName,
          scheduledAt: row.scheduledAt, // Guardar Date para ordenar después
          date: formatDateOnly(new Date(row.scheduledAt)),
          time: formatTime12h(new Date(row.scheduledAt)),
          loteriaId: row.loteriaId,
          loteriaName: row.loteriaName || "Desconocida",
          winningNumber: null, // No se necesita en este resumen
          isReventado,
          totalSales: Number(row.totalSales),
          totalCommission: Number(row.totalCommission),
          commissionByNumber,
          commissionByReventado,
          totalPrizes: Number(row.totalPrizes),
          ticketCount: Number(row.ticketCount),
          subtotal,
          accumulated: 0, // Se calculará después junto con movimientos
          chronologicalIndex: 0,
          totalChronological: consolidatedMetrics.length,
          winningTicketsCount: winningCount,
          paidTicketsCount: paidCount,
          unpaidTicketsCount: unpaidCount,
          byMultiplier,
        };
      });

      // Log de depuración
      logger.info({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_CONSOLIDATED_SUCCESS",
        payload: {
          vendedorId,
          sorteosFound: consolidatedMetrics.length,
          message: "Resumen evaluado generado mediante query consolidada",
        },
      });

      //  PASO 3: Convertir movimientos a items con la misma estructura que sorteos
      const movementItems: any[] = [];
      for (const [dateStr, movements] of movementsByDate.entries()) {
        for (const movement of movements) {
          if (!movement.isReversed) {
            //  CRÍTICO: Detectar si es el movimiento especial "Saldo del mes anterior"
            const isOpeningBalance = movement.id?.startsWith('previous-month-balance-');

            //  CRÍTICO: Usar movement.time si está disponible (hora real del movimiento)
            // Si no, fallback a createdAt (hora de registro en BD)
            let scheduledAt: Date;
            let timeDisplay: string;

            const hasValidTime = movement.time && typeof movement.time === 'string' && movement.time.trim().length > 0;
            const [year, month, day] = movement.date.split('-').map(Number);

            //  CRÍTICO: El saldo del mes anterior SIEMPRE debe ser el primer evento del día
            if (isOpeningBalance) {
              // Forzar hora 00:00:00 para que sea el primer evento cronológicamente
              scheduledAt = new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0)); // 00:00 CR = 06:00 UTC
              timeDisplay = "12:00AM ";
            } else if (hasValidTime) {
              // Usar movement.time (formato HH:MM en hora CR)
              const [hours, minutes] = movement.time.split(':').map(Number);

              // Convertir hora CR a UTC para scheduledAt (CR es UTC-6, sumar 6 horas)
              const utcHours = hours + 6;
              if (utcHours >= 24) {
                // Día siguiente en UTC
                scheduledAt = new Date(Date.UTC(year, month - 1, day + 1, utcHours - 24, minutes, 0));
              } else {
                scheduledAt = new Date(Date.UTC(year, month - 1, day, utcHours, minutes, 0));
              }

              // Formatear hora en 12h
              const ampm = hours >= 12 ? 'PM' : 'AM';
              const hours12 = hours % 12 || 12;
              timeDisplay = `${hours12}:${String(minutes).padStart(2, '0')}${ampm} `;
            } else {
              // Fallback: usar createdAt
              const createdAtDate = new Date(movement.createdAt);
              // Convertir UTC a CR (UTC-6)
              const crTime = new Date(createdAtDate.getTime() - (6 * 60 * 60 * 1000));
              const hour = crTime.getUTCHours();
              const minute = crTime.getUTCMinutes();
              const seconds = crTime.getUTCSeconds();
              //  CRÍTICO: Usar Date.UTC y ajustar offset (UTC-6) para evitar dependencia de la hora local del server
              scheduledAt = new Date(Date.UTC(year, month - 1, day, hour, minute, seconds) + (6 * 60 * 60 * 1000));
              timeDisplay = formatTime12h(scheduledAt);
            }

            //  CRÍTICO: El movimiento especial tiene subtotal: 0 porque el saldo ya está en eventAccumulated inicial
            //  CRÍTICO: Usar Number() para garantizar tipo numérico y evitar concatenación de strings
            //  Si es el saldo del mes anterior, subtotal = 0 (ya está en initialAccumulatedForRange)
            const subtotal = isOpeningBalance
              ? 0
              : (movement.type === 'payment' ? Number(movement.amount || 0) : -Number(movement.amount || 0));

            movementItems.push({
              sorteoId: `mov-${movement.id}`,
              sorteoName: isOpeningBalance
                ? 'Saldo del mes anterior'
                : (movement.type === 'payment' ? 'Pago recibido' : 'Cobro realizado'),
              scheduledAt, //  Fecha del usuario + hora del movimiento (o creación como fallback)
              date: movement.date, //  Fecha que el usuario indicó
              time: timeDisplay, //  Usar hora de movement.time si disponible
              loteriaId: null,
              loteriaName: null,
              winningNumber: null,
              isReventado: false,
              totalSales: 0,
              totalCommission: 0,
              commissionByNumber: 0,
              commissionByReventado: 0,
              totalPrizes: 0,
              ticketCount: 0,
              subtotal, //  CRÍTICO: Usar variable calculada (normal para saldo inicial)
              accumulated: 0, // Se recalculará después
              chronologicalIndex: 0,
              totalChronological: 0,
              winningTicketsCount: 0,
              paidTicketsCount: 0,
              unpaidTicketsCount: 0,
              byMultiplier: [],
              // Campos específicos de movimiento
              type: movement.type,
              amount: movement.amount,
              method: movement.method || (isOpeningBalance ? 'Saldo del mes anterior' : ''),
              notes: movement.notes || (isOpeningBalance ? 'Saldo arrastrado del mes anterior' : ''),
            });
          }
        }
      }

      //  PASO 4: Combinar sorteos y movimientos y ordenar cronológicamente
      const allEvents = [...sorteoData, ...movementItems];
      allEvents.sort((a, b) => {
        const timeA = new Date(a.scheduledAt).getTime();
        const timeB = new Date(b.scheduledAt).getTime();
        return timeA - timeB;
      });

      //  PASO 4.5: Obtener el acumulado inicial para el primer día del rango consultado
      //  CRÍTICO: Esto asegura que el accumulated de cada evento sea ABSOLUTO (desde inicio del mes),
      //  no relativo al período consultado. Así el acumulado es consistente sin importar el filtro.
      let initialAccumulatedForRange = 0;

      if (allEvents.length > 0) {
        const firstEventDate = allEvents[0].date;
        const [firstYear, firstMonth, firstDay] = firstEventDate.split('-').map(Number);

        if (firstDay === 1) {
          //  Si el rango empieza el día 1 del mes, usar el saldo del mes anterior
          initialAccumulatedForRange = Number(rangePreviousMonthBalance) || 0;
        } else {
          //  Si el rango NO empieza el día 1, obtener el accumulatedBalance del día anterior
          //  desde AccountStatement (fuente de verdad)
          const previousDay = new Date(Date.UTC(firstYear, firstMonth - 1, firstDay - 1, 0, 0, 0, 0));
          const previousDayStatement = await prisma.accountStatement.findFirst({
            where: {
              vendedorId,
              date: previousDay,
            },
            select: { accumulatedBalance: true },
          });

          if (previousDayStatement) {
            initialAccumulatedForRange = Number(previousDayStatement.accumulatedBalance) || 0;
          } else {
            //  Fallback: si no hay statement del día anterior, calcular desde inicio del mes
            //  Obtener todos los statements desde el día 1 hasta el día anterior
            const monthStart = new Date(Date.UTC(firstYear, firstMonth - 1, 1, 0, 0, 0, 0));
            const lastStatementBeforeRange = await prisma.accountStatement.findFirst({
              where: {
                vendedorId,
                date: {
                  gte: monthStart,
                  lt: previousDay,
                },
              },
              orderBy: { date: 'desc' },
              select: { accumulatedBalance: true },
            });

            if (lastStatementBeforeRange) {
              initialAccumulatedForRange = Number(lastStatementBeforeRange.accumulatedBalance) || 0;
            } else {
              //  Si no hay statements previos en el mes, usar saldo del mes anterior
              initialAccumulatedForRange = Number(rangePreviousMonthBalance) || 0;
            }
          }
        }
      }

      //  PASO 5: Calcular acumulado y chronologicalIndex por evento (sorteo/movimiento)
      //  CRÍTICO: Inicializar con el acumulado del día anterior al rango (o saldo mes anterior si es día 1)
      //  Esto garantiza que el accumulated sea ABSOLUTO, no relativo al período consultado
      let eventAccumulated = initialAccumulatedForRange;
      let lastProcessedDate = '';
      const totalEvents = allEvents.length;
      const dataWithAccumulated = allEvents.map((event, index) => {
        const eventDate = event.date;

        //  CRÍTICO: Si cambiamos de día dentro del rango, verificar si necesitamos
        //  ajustar el acumulado (en caso de gaps entre días sin el movimiento especial)
        if (lastProcessedDate && eventDate !== lastProcessedDate) {
          //  El acumulado ya incluye todos los eventos del día anterior,
          //  así que solo continuamos sumando (el carry-over es automático)
        }
        lastProcessedDate = eventDate;

        //  CRÍTICO: Usar Number() para garantizar suma numérica (evitar concatenación de strings)
        eventAccumulated += Number(event.subtotal) || 0;
        return {
          ...event,
          accumulated: eventAccumulated,
          chronologicalIndex: index + 1, // 1 = más antiguo, n = más reciente
          totalChronological: totalEvents,
        };
      });

      //  C3.1 OPTIMIZACIÓN: monthlyRange ya resuelto en Fase 1

      //  C3.1 OPTIMIZACIÓN: Detectar si podemos reusar resultados del rango principal
      // Cuando date=month sin filtro de lotería, las queries mensuales son idénticas a las principales
      const isMonthRange = (params.date === 'month') && !params.fromDate && !params.toDate;
      const canReuseMonthlyMovements = isMonthRange; // movements no dependen de loteriaId
      const monthlyMovementsByDate = canReuseMonthlyMovements
        ? movementsByDate
        : await AccountPaymentRepository.findMovementsByDateRange(
            monthlyStartDate,
            monthlyEndDate,
            "vendedor",
            undefined,
            vendedorId
          );

      //  ACTUALIZADO: Agrupar todos los eventos (sorteos + movimientos) por día
      //  CRÍTICO: Usar dataWithAccumulated (no allEvents) para que tengan el accumulated calculado
      const eventsByDate = new Map<string, any[]>();

      for (const event of dataWithAccumulated) {
        const date = event.date;
        if (!eventsByDate.has(date)) {
          eventsByDate.set(date, []);
        }
        eventsByDate.get(date)!.push(event);
      }

      //  ACTUALIZADO: Ordenar eventos dentro de cada día por scheduledAt DESC (más reciente primero)
      for (const [date, eventsDelDia] of eventsByDate.entries()) {
        eventsDelDia.sort((a, b) => {
          const dateA = new Date(a.scheduledAt).getTime();
          const dateB = new Date(b.scheduledAt).getTime();
          if (dateA !== dateB) {
            return dateB - dateA; // DESC por fecha (más reciente primero)
          }
          // Si tienen la misma fecha/hora, sorteos primero, luego movimientos
          const aIsMovement = a.sorteoId?.startsWith('mov-');
          const bIsMovement = b.sorteoId?.startsWith('mov-');
          if (aIsMovement !== bIsMovement) {
            return aIsMovement ? 1 : -1;
          }
          // Si ambos son sorteos, usar mismo orden que en SQL
          if (!aIsMovement && !bIsMovement) {
            if (a.loteriaId && b.loteriaId && a.loteriaId !== b.loteriaId) {
              return a.loteriaId.localeCompare(b.loteriaId);
            }
            if (a.sorteoId && b.sorteoId) {
              return a.sorteoId.localeCompare(b.sorteoId);
            }
          }
          return 0;
        });
      }

      //  ACTUALIZADO: Construir respuesta agrupada por día (incluye sorteos + movimientos)
      const daysArray = Array.from(eventsByDate.entries())
        .map(([date, eventsDelDia]) => {
          // Separar sorteos y movimientos para calcular totales
          const sorteosDelDia = eventsDelDia.filter(e => !e.sorteoId?.startsWith('mov-'));
          const movimientosDelDia = eventsDelDia.filter(e => e.sorteoId?.startsWith('mov-'));

          // Calcular dayTotals (suma de todos los sorteos del día)
          const totalSales = sorteosDelDia.reduce((sum, s) => sum + (s.totalSales || 0), 0);
          const totalCommission = sorteosDelDia.reduce((sum, s) => sum + (s.totalCommission || 0), 0);
          const commissionByNumber = sorteosDelDia.reduce((sum, s) => sum + (s.commissionByNumber || 0), 0);
          const commissionByReventado = sorteosDelDia.reduce((sum, s) => sum + (s.commissionByReventado || 0), 0);
          const totalPrizes = sorteosDelDia.reduce((sum, s) => sum + (s.totalPrizes || 0), 0);
          const totalTickets = sorteosDelDia.reduce((sum, s) => sum + (s.ticketCount || 0), 0);

          // Calcular totalPaid y totalCollected desde movimientos del día
          // Excluir el movimiento especial "Saldo del mes anterior" del cálculo
          const totalPaid = movimientosDelDia
            .filter((m: any) => m.type === "payment" && !m.sorteoId?.includes('previous-month-balance'))
            .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
          const totalCollected = movimientosDelDia
            .filter((m: any) => m.type === "collection" && !m.sorteoId?.includes('previous-month-balance'))
            .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);

          // Calcular totalBalance y totalRemainingBalance
          const totalBalance = totalSales - totalPrizes - totalCommission;
          const totalRemainingBalance = totalBalance - totalCollected + totalPaid;

          const dayTotals = {
            totalSales,
            totalCommission,
            commissionByNumber,
            commissionByReventado,
            totalPrizes,
            totalTickets,
            totalPaid,
            totalCollected,
            totalBalance,
            totalRemainingBalance,
            totalSubtotal: totalRemainingBalance,
            accumulated: 0, // Se calculará después basado en totalRemainingBalance histórico
          };

          //  ACTUALIZADO: Formatear todos los eventos (sorteos + movimientos)
          const eventsFormatted = eventsDelDia.map((e) => ({
            ...e,
            scheduledAt: formatIsoLocal(e.scheduledAt),
          }));

          return {
            date,
            sorteos: eventsFormatted, // Incluye sorteos Y movimientos
            dayTotals,
          };
        })
        .sort((a, b) => {
          // Ordenar días descendente (más reciente primero)
          return b.date.localeCompare(a.date);
        });

      //  CRÍTICO: Obtener accumulatedBalance desde AccountStatement para cada día
      // Esto asegura que el acumulado sea consistente independiente del período consultado
      // (el acumulado a una fecha X siempre será el mismo sin importar los filtros)
      const datesToQuery = daysArray.map(d => {
        const [year, month, day] = d.date.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      });

      const statementsForAccumulated = await prisma.accountStatement.findMany({
        where: {
          vendedorId,
          date: { in: datesToQuery },
        },
        select: {
          date: true,
          accumulatedBalance: true,
        },
      });

      // Crear mapa de fecha -> accumulatedBalance
      const accumulatedByDate = new Map<string, number>();
      for (const stmt of statementsForAccumulated) {
        const dateStr = stmt.date.toISOString().split('T')[0];
        accumulatedByDate.set(dateStr, stmt.accumulatedBalance);
      }

      // Asignar accumulated a cada día desde AccountStatement
      for (const day of daysArray) {
        day.dayTotals.accumulated = accumulatedByDate.get(day.date) ?? 0;
      }

      // Calcular totales agregados (suma de todos los días)
      const totals = {
        totalSales: daysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
        totalCommission: daysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
        commissionByNumber: daysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
        commissionByReventado: daysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
        totalPrizes: daysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
        totalTickets: daysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
        totalPaid: daysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
        totalCollected: daysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
        totalBalance: daysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0),
        totalRemainingBalance: daysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
        totalSubtotal: daysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0), //  DEPRECATED: igual a totalRemainingBalance
      };

      //  C3.1 OPTIMIZACIÓN: Calcular monthlyAccumulated
      // Cuando date=month sin filtro de lotería ni isActive=false, los datos son idénticos
      // al rango principal → reusar directamente y ahorrar ~4 queries + 1 findMany
      const canSkipMonthlyQueries = isMonthRange && !params.loteriaId && ticketIsActive;

      //  CRÍTICO: previousMonthBalance se necesita siempre para monthlyAccumulated
      // Cuando date=month, rangeEffectiveMonth === effectiveMonth, así que reusamos rangePreviousMonthBalance
      const monthlyStartComponents = getCRLocalComponents(monthlyStartDate);
      const effectiveMonth = `${monthlyStartComponents.year}-${String(monthlyStartComponents.month).padStart(2, '0')}`;
      const previousMonthBalance = isMonthRange
        ? rangePreviousMonthBalance  // Mismo mes → reusar
        : await getPreviousMonthFinalBalance(effectiveMonth, "vendedor", undefined, vendedorId, undefined);
      const numericPreviousMonthBalance = Number(previousMonthBalance) || 0;

      let monthlyAccumulated;

      if (canSkipMonthlyQueries) {
        //  C3.1: date=month sin filtros → reusar totals del rango principal (ahorra 4+ queries)
        // Calcular totalPaid y totalCollected desde movimientos (ya disponibles)
        let monthlyTotalPaid = 0;
        let monthlyTotalCollected = 0;
        for (const movements of monthlyMovementsByDate.values()) {
          monthlyTotalPaid += movements
            .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
            .reduce((sum: number, m: any) => sum + m.amount, 0);
          monthlyTotalCollected += movements
            .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        }

        // Reusar comisiones por tipo desde sorteoData (ya calculados en Paso 2)
        const monthlyCommissionByNumber = sorteoData.reduce((sum, s) => sum + s.commissionByNumber, 0);
        const monthlyCommissionByReventado = sorteoData.reduce((sum, s) => sum + s.commissionByReventado, 0);

        const monthlyTotalBalance = totals.totalSales - totals.totalPrizes - totals.totalCommission;
        const monthlyTotalRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

        monthlyAccumulated = {
          totalSales: totals.totalSales,
          totalCommission: totals.totalCommission,
          commissionByNumber: monthlyCommissionByNumber,
          commissionByReventado: monthlyCommissionByReventado,
          totalPrizes: totals.totalPrizes,
          totalTickets: totals.totalTickets,
          totalPaid: monthlyTotalPaid,
          totalCollected: monthlyTotalCollected,
          totalBalance: numericPreviousMonthBalance + monthlyTotalBalance,
          totalRemainingBalance: numericPreviousMonthBalance + monthlyTotalRemainingBalance,
          totalSubtotal: numericPreviousMonthBalance + monthlyTotalRemainingBalance,
        };
      } else {
        //  Caso general: queries mensuales necesarias (diferente rango o filtro de lotería)
        const monthlySorteoWhere: Prisma.SorteoWhereInput = {
          status: SorteoStatus.EVALUATED,
          scheduledAt: { gte: monthlyStartDate, lte: monthlyEndDate },
          tickets: {
            some: { vendedorId, deletedAt: null, isActive: true },
          },
        };

        const monthlySorteos = await prisma.sorteo.findMany({
          where: monthlySorteoWhere,
          select: { id: true },
        });
        const monthlySorteoIds = monthlySorteos.map((s) => s.id);

        //  C3.2 OPTIMIZACIÓN: Ejecutar queries mensuales en paralelo
        // Y reemplazar jugadas findMany con groupBy (solo necesita commission por tipo)
        const [monthlyFinancialData, monthlyPrizesData, monthlyJugadaCommissions] = await Promise.all([
          prisma.ticket.groupBy({
            by: ["sorteoId"],
            where: {
              sorteoId: { in: monthlySorteoIds },
              vendedorId,
              deletedAt: null,
              isActive: true,
            },
            _sum: { totalAmount: true, totalCommission: true, totalPayout: true },
            _count: { id: true },
          }),
          prisma.ticket.groupBy({
            by: ["sorteoId"],
            where: {
              sorteoId: { in: monthlySorteoIds },
              vendedorId,
              isWinner: true,
              deletedAt: null,
              isActive: true,
            },
            _sum: { totalPayout: true },
          }),
          //  C3.2: groupBy en vez de findMany (2 filas vs ~1500+ filas)
          prisma.jugada.groupBy({
            by: ["type"],
            where: {
              ticket: {
                sorteoId: { in: monthlySorteoIds },
                vendedorId,
                deletedAt: null,
                isActive: true,
              },
              deletedAt: null,
            },
            _sum: { commissionAmount: true },
          }),
        ]);

        const monthlyTotalSales = monthlyFinancialData.reduce((sum, f) => sum + (f._sum.totalAmount || 0), 0);
        const monthlyTotalCommission = monthlyFinancialData.reduce((sum, f) => sum + (f._sum.totalCommission || 0), 0);
        const monthlyTotalPrizes = monthlyPrizesData.reduce((sum, p) => sum + (p._sum.totalPayout || 0), 0);
        const monthlyTotalTickets = monthlyFinancialData.reduce((sum, f) => sum + f._count.id, 0);

        let monthlyTotalPaid = 0;
        let monthlyTotalCollected = 0;
        for (const movements of monthlyMovementsByDate.values()) {
          monthlyTotalPaid += movements
            .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
            .reduce((sum: number, m: any) => sum + m.amount, 0);
          monthlyTotalCollected += movements
            .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        }

        //  C3.2: Leer comisiones por tipo desde groupBy (ya no carga filas individuales)
        const monthlyCommissionByNumber = monthlyJugadaCommissions
          .find((j) => j.type === "NUMERO")?._sum.commissionAmount || 0;
        const monthlyCommissionByReventado = monthlyJugadaCommissions
          .find((j) => j.type === "REVENTADO")?._sum.commissionAmount || 0;

        const monthlyTotalBalance = monthlyTotalSales - monthlyTotalPrizes - monthlyTotalCommission;
        const monthlyTotalRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

        monthlyAccumulated = {
          totalSales: monthlyTotalSales,
          totalCommission: monthlyTotalCommission,
          commissionByNumber: monthlyCommissionByNumber,
          commissionByReventado: monthlyCommissionByReventado,
          totalPrizes: monthlyTotalPrizes,
          totalTickets: monthlyTotalTickets,
          totalPaid: monthlyTotalPaid,
          totalCollected: monthlyTotalCollected,
          totalBalance: numericPreviousMonthBalance + monthlyTotalBalance,
          totalRemainingBalance: numericPreviousMonthBalance + monthlyTotalRemainingBalance,
          totalSubtotal: numericPreviousMonthBalance + monthlyTotalRemainingBalance,
        };
      }
      const result = {
        data: daysArray,
        meta: {
          totals,
          monthlyAccumulated, //  NUEVO: Acumulado del mes completo
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalSorteos: sorteoData.length,
          totalDays: daysArray.length,
        },
      };

      // Log de depuración final
      logger.info({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_RESULT",
        payload: {
          vendedorId,
          totalSorteos: sorteoData.length,
          totalDays: daysArray.length,
          totalTickets: totals.totalTickets,
          message: "Resultado final del resumen evaluado",
        },
      });

      return result;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  }, 30, tags);
},
};

export default SorteoService;
