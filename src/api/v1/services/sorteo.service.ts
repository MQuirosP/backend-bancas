// src/modules/sorteos/services/sorteo.service.ts
import { ActivityType, Prisma, Role, SorteoStatus, TicketStatus, BetType } from "../../../generated/prisma/client";
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
import { commissionResolver } from "../../../services/commission/CommissionResolver";
import { CommissionPolicy, CommissionRule } from "../../../services/commission/types/CommissionTypes";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { crDateService } from "../../../utils/crDateService";
import { getPreviousMonthFinalBalance, getPreviousMonthFinalBalancesBatch } from "./accounts/accounts.balances";
import { getMonthlyRemainingBalance, getMonthlyRemainingBalancesBatch } from "./accounts/accounts.service";
import { CacheService } from "../../../core/cache.service";
import { getRedisClient } from "../../../core/redisClient";
import crypto from 'crypto';
import { ConcurrencyManager, SharedWarmupPool, SingleFlight } from "../../../utils/concurrency";
import { SorteoEvaluationCoordinator } from "./sorteoEvaluation.coordinator";

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

function serializeSorteo<T extends { scheduledAt?: Date | null; loteria?: any; hasSales?: boolean; ticketCount?: number; hasExclusions?: boolean }>(sorteo: T) {
  if (!sorteo) return sorteo;
  const reventadoEnabled = extractReventadoEnabled(sorteo.loteria);
  const serialized = {
    ...sorteo,
    scheduledAt: sorteo.scheduledAt ? formatIsoLocal(sorteo.scheduledAt) : null,
    reventadoEnabled,
    //  NUEVO: Campos de ventas (opcionales para compatibilidad)
    ...(sorteo.hasSales !== undefined ? { hasSales: sorteo.hasSales } : {}),
    ...(sorteo.ticketCount !== undefined ? { ticketCount: sorteo.ticketCount } : {}),
    ...(sorteo.hasExclusions !== undefined ? { hasExclusions: sorteo.hasExclusions } : {}),
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

const SorteoService = {
  /**
   * Valida si un usuario tiene acceso a un sorteo según su bancaId.
   * Si el sorteo es global (bancaId === null), solo ADMIN puede editarlo?
   * O permitimos que BANCA admins vean globales pero no los toquen?
   */
  async validateSorteoOwnership(sorteoId: string, bancaId?: string, role?: Role) {
    const sorteo = await prisma.sorteo.findUnique({
      where: { id: sorteoId },
      select: { 
        id: true, 
        bancaId: true, 
        status: true, 
        name: true, 
        scheduledAt: true, 
        loteriaId: true, 
        winningNumber: true, 
        extraMultiplierId: true,
        isActive: true,
        digits: true,
        loteria: { select: { name: true } } 
      }
    });

    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

    // Si el usuario es ADMIN global, tiene acceso a todo
    if (role === Role.ADMIN && !bancaId) return sorteo;

    // Si el usuario tiene una banca activa
    if (bancaId) {
      // Si el sorteo pertenece a OTRA banca, denegar
      if (sorteo.bancaId && sorteo.bancaId !== bancaId) {
        throw new AppError("Acceso denegado: El sorteo pertenece a otra banca", 403);
      }
      
      // Si el sorteo es GLOBAL (bancaId null), permitimos lectura pero NO edición para BANCA admins?
      // Por ahora, si es global, permitimos que lo vean, pero las mutaciones deberían ser restringidas.
      // Sin embargo, en este sistema los sorteos suelen ser compartidos.
      // Si el usuario intenta una MUTACIÓN, debemos ser más estrictos.
    }

    return sorteo;
  },

  async create(data: CreateSorteoDTO, userId: string, bancaId?: string) {
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
      bancaId, // Pasar el bancaId (si viene)
    });

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag(`sorteo:${s.id}`).catch(() => {});

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
      bancaId: s.bancaId,
      action: ActivityType.SORTEO_CREATE,
      targetType: "SORTEO",
      targetId: s.id,
      details,
    });

    return serializeSorteo(s);
  },

  async update(id: string, data: UpdateSorteoDTO, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
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
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    const details: Record<string, any> = {};
    if (data.name && data.name !== existing.name) details.name = data.name;
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) details.loteriaId = data.loteriaId;
    if (data.scheduledAt) {
      details.scheduledAt = formatDateCRWithTZ(normalizeDateCR(data.scheduledAt, 'scheduledAt')); //  Normalizar y formatear con timezone
    }
    if (data.digits && data.digits !== existing.digits) {
      details.digits = data.digits;
    }
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      details.isActive = data.isActive;
    }

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
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
  async setActive(id: string, isActive: boolean, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }

    const s = await SorteoRepository.update(id, {
      isActive,
    } as UpdateSorteoDTO);
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: { 
        isActive, 
        previousIsActive: existing.isActive,
        description: `Sorteo ${sorteoDesc} marcado como ${isActive ? 'ACTIVO' : 'INACTIVO'}`
      },
    });

    return serializeSorteo(s);
  },

  /**
   * Fuerza el cambio de estado a OPEN desde cualquier estado (excepto EVALUATED)
   * Útil para reabrir sorteos que están en CLOSED
   */
  async forceOpen(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    const s = await SorteoRepository.forceOpen(id);
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

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
      bancaId: existing.bancaId,
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
  async activateAndOpen(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
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
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    const details: Prisma.InputJsonObject = {
      from: {
        status: existing.status,
        isActive: existing.isActive,
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
      bancaId: existing.bancaId,
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
        previousIsActive: existing.isActive,
      },
    });

    return serializeSorteo(s);
  },

  /**
   * Actualiza un sorteo a estado SCHEDULED y isActive=true
   * Útil para resetear sorteos a estado inicial
   */
  async resetToScheduled(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }

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
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    const sFormattedAt = formatDateCRWithTZ(s.scheduledAt);
    const lotName = s.loteria?.name || 'Lotería';
    const sorteoDesc = `${s.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        status: SorteoStatus.SCHEDULED,
        isActive: true,
        previousStatus: existing.status,
        previousIsActive: existing.isActive,
        description: `Sorteo ${sorteoDesc} reseteado a estado PROGRAMADO`
      },
    });

    return serializeSorteo(s);
  },

  async open(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.SCHEDULED) {
      throw new AppError("Solo se puede abrir desde SCHEDULED", 409);
    }
    if (!existing.isActive) {
      throw new AppError("No se puede abrir un sorteo inactivo", 409);
    }

    const s = await SorteoRepository.open(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

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

  async close(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.OPEN && existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede cerrar desde OPEN o EVALUATED", 409);
    }

    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxAgeMs) {
      throw new AppError("No se puede cerrar un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico.", 409);
    }

    //  NUEVA: Usar closeWithCascade() para marcar tickets también
    const { sorteo: s, ticketsAffected } = await SorteoRepository.closeWithCascade(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

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
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_CLOSE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  async evaluate(id: string, body: EvaluateSorteoDTO, userId: string, bancaId?: string, role?: Role) {
    // 1) Cargar sorteo y validar propiedad
    const existing = await this.validateSorteoOwnership(id, bancaId, role);

    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxAgeMs) {
      throw new AppError("No se puede evaluar un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico.", 409);
    }

    // 2) Ejecutar la validación SOLID a través del coordinador
    const { extraOutcomeCode } = await SorteoEvaluationCoordinator.validate(
      id,
      body,
      existing,
      bancaId,
      role
    );

    // 3) Ejecutar la evaluación transaccional (ACID) en base de datos
    const evaluated = await SorteoRepository.evaluate(id, {
      winningNumber: body.winningNumber.trim(),
      extraOutcomeCode,
      extraMultiplierId: body.extraMultiplierId && body.extraMultiplierId !== 'none' && body.extraMultiplierId !== ''
        ? body.extraMultiplierId
        : null,
    });

    if (!evaluated) throw new AppError('Error al recuperar el sorteo evaluado', 500);

    // 4) Disparar los efectos secundarios en segundo plano de manera desacoplada (SOLID)
    SorteoEvaluationCoordinator.triggerPostEvaluation(
      id,
      body.winningNumber.trim(),
      body.extraMultiplierId,
      existing,
      evaluated,
      userId
    );

    return serializeSorteo(evaluated);
  },

  async remove(id: string, userId: string, reason?: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para eliminar un sorteo global", 403);
    }

    // Inactivación manual: deletedByCascade = false
    const s = await SorteoRepository.softDelete(id, userId, reason, false);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag('sorteos').catch(() => {});
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    const details: Record<string, any> = {};
    if (reason) details.reason = reason;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SOFT_DELETE,
      targetType: "SORTEO",
      targetId: id,
      details: details as Prisma.InputJsonObject,
    });

    return serializeSorteo(s);
  },

  async restore(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para restaurar un sorteo global", 403);
    }
    const s = await SorteoRepository.restore(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.RESTORE,
      targetType: "SORTEO",
      targetId: id,
      details: { restored: true },
    });

    return serializeSorteo(s);
  },

  async revertEvaluation(id: string, userId: string, reason?: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);
    
    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para revertir un sorteo global", 403);
    }
    if (existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
    }

    // Límite de seguridad: Impedir revertir sorteos de más de 7 días de antigüedad
    const maxRevertAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - existing.scheduledAt.getTime() > maxRevertAgeMs) {
      throw new AppError("No se puede revertir un sorteo con más de 7 días de antigüedad. Contacte a soporte técnico para realizar un ajuste contable.", 409);
    }

    const reverted = await SorteoRepository.revertEvaluation(id);

    // Sincronizar AccountStatements, limpiar caché y notificar por WebSocket tras revertir
    (async () => {
      try {
        const { AccountStatementSyncService } = await import('./accounts/accounts.sync.service');
        await AccountStatementSyncService.syncSorteoStatements(id, existing.scheduledAt);

        // Invalidar cache de sorteos, dashboard y cierres
        const { clearSorteoCache } = require('../../../utils/sorteoCache');
        clearSorteoCache();
        await CacheService.invalidateTag('sorteos').catch(() => {});
        await CacheService.invalidateTag(`sorteo:${id}`).catch(() => {});
        await CacheService.invalidateTag('dashboard').catch(() => {});
        await CacheService.invalidateTag('cierre').catch(() => {});
        await CacheService.invalidateTag('report:summary').catch(() => {});

        // Notificar a clientes conectados que el sorteo fue revertido y los saldos están listos
        const { SocketService } = await import('../../../core/socket.service');
        SocketService.notifySorteoReverted({
          sorteoId: id,
          sorteoNombre: existing.name || 'Sorteo',
          scheduledAt: existing.scheduledAt ? new Date(existing.scheduledAt).toISOString() : new Date().toISOString(),
          bancaId: existing.bancaId || null,
          revertedAt: new Date().toISOString(),
        });
      } catch (err: any) {
        logger.error({
          layer: 'service',
          action: 'ACCOUNT_STATEMENT_SYNC_REVERT_BACKGROUND_ERROR',
          payload: { sorteoId: id, error: (err as Error).message }
        });
      }
    })();

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || 'Lotería';
    const sorteoDesc = `${existing.name || 'Sorteo'} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
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

    return result;
  },

  /**
   *  Helper: Obtener multiplicadores activos tipo NUMERO de una lotería
   */
  async getActiveMultipliers(loteriaId: string): Promise<Array<{ id: string; valueX: number }>> {
    const multipliers = await prisma.loteriaMultiplier.findMany({
      where: {
        loteriaId,
        kind: BetType.NUMERO,
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

    return commissionResolver.parsePolicy(policyJson, 'USER');
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
        if (rule.betType !== null && rule.betType !== BetType.NUMERO) {
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

    // Obtener multiplicadores para todas las loterías en paralelo con límite de concurrencia
    const multiplierTasks = loteriaIds.map((loteriaId) => async () => {
      const multipliers = await this.getActiveMultipliers(loteriaId);
      multipliersByLoteria.set(loteriaId, multipliers);
    });

    await ConcurrencyManager.runLimited(multiplierTasks, { limit: 5 });

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
    includeDeleted?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: "hour" | "loteria-hour";
    lastId?: string;
    lastScheduledAt?: Date;
    //  NUEVO: Información del usuario para filtrado por política de comisiones
    userId?: string;
    role?: Role;
    ventanaId?: string | null;
    bancaId?: string;
  }) {
    // Early return: sin groupBy, usar lógica existente
    if (!params.groupBy) {
      const p = params.page && params.page > 0 ? params.page : 1;
      const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

      const isVendedor = params.role === Role.VENDEDOR;
      const isAdminOrBanca = params.role === Role.ADMIN || params.role === Role.BANCA;

      const cacheKey = `sorteos:list:v3:${params.loteriaId || 'all'}:${params.status || 'all'}:${params.role || 'all'}:${params.bancaId || 'all'}:${params.ventanaId || 'all'}:${params.userId || 'all'}:${p}:${ps}:${params.search || ''}:${params.isActive ?? 'all'}:${params.includeDeleted ? 'incDel' : 'noDel'}:${params.dateFrom?.getTime() || ''}:${params.dateTo?.getTime() || ''}`;

      const tags = ['sorteos'];
      if (params.userId) tags.push(`user:${params.userId}`);
      if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
      if (params.bancaId) tags.push(`banca:${params.bancaId}`);

      return CacheService.wrap(
        cacheKey,
        async () => {
          const { data, total } = await SorteoRepository.list({
            page: p,
            pageSize: ps,
            loteriaId: params.loteriaId,
            status: params.status,
            search: params.search?.trim() || undefined,
            isActive: params.isActive,
            includeDeleted: params.includeDeleted,
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
            lastId: params.lastId,
            lastScheduledAt: params.lastScheduledAt,
            role: params.role,
            userId: params.userId,
            ventanaId: params.ventanaId,
            bancaId: params.bancaId,
          });

          let filteredData = data;
          let filteredTotal = total;

          if (isVendedor && params.userId && params.ventanaId) {
            const filterResult = await this.filterSorteosByCommissionPolicy(
              data.map(s => ({ id: s.id, loteriaId: s.loteriaId })),
              params.userId,
              params.ventanaId
            );

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
          return {
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
        },
        15, // TTL 15 segundos
        tags
      );
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
    bancaId?: string;
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

    if (params.dateFrom) {
      whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'`);
    }
    if (params.dateTo) {
      whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'`);
    }

    if (!params.bancaId) {
      whereConditions.push(Prisma.sql`s."bancaId" IS NULL`);
    } else {
      whereConditions.push(Prisma.sql`s."bancaId" = CAST(${params.bancaId} AS uuid)`);
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
            ${params.dateFrom ? Prisma.sql`AND s2."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'` : Prisma.empty}
            ${params.dateTo ? Prisma.sql`AND s2."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'` : Prisma.empty}
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

    // Formatear respuesta con límite de concurrencia para evitar saturar el pool
    const dataTasks = results.map((row) => async () => {
      // Obtener IDs ordenados por fecha descendente
      const sorteoIdsArray = row.sorteoIds.split(",");
      const sorteosWithDates = await prisma.sorteo.findMany({
        where: {
          id: { in: sorteoIdsArray },
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          ...(params.bancaId ? { bancaId: params.bancaId } : { bancaId: null }),
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
    });

    const data = await ConcurrencyManager.runLimited(dataTasks, { limit: 5 });

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
    bancaId?: string;
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

    if (params.dateFrom) {
      whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'`);
    }
    if (params.dateTo) {
      whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'`);
    }

    if (!params.bancaId) {
      whereConditions.push(Prisma.sql`s."bancaId" IS NULL`);
    } else {
      whereConditions.push(Prisma.sql`s."bancaId" = CAST(${params.bancaId} AS uuid)`);
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
        INNER JOIN "Loteria" l ON l.id = s."loteriaId"
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
            ${params.loteriaId ? Prisma.sql`AND s2."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
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

    // Formatear respuesta con límite de concurrencia
    const dataTasks = results.map((row) => async () => {
      // Obtener IDs ordenados por fecha descendente
      const sorteoIdsArray = row.sorteoIds.split(",");
      const sorteosWithDates = await prisma.sorteo.findMany({
        where: {
          id: { in: sorteoIdsArray },
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          ...(params.bancaId ? { bancaId: params.bancaId } : { bancaId: null }),
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
    });

    const data = await ConcurrencyManager.runLimited(dataTasks, { limit: 5 });

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
  async findById(id: string, role?: string, userId?: string, ventanaId?: string | null) {
    const sorteo = await SorteoRepository.findById(id, role, userId, ventanaId);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return serializeSorteo(sorteo);
  },

  /**
  /**
   * Fast-Path de alto rendimiento para GET /evaluated-summary con summaryOnly=true.
   * Consulta directamente AccountStatement (O(1) B-Tree) y AccountPayment sin escanear Ticket ni Jugada.
   * Resuelve lecturas en frío (Cold/DB) en < 5 ms.
   */
  async evaluatedSummaryFastPath(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      loteriaId?: string;
      status?: string;
      isActive?: string;
      summaryOnly?: boolean;
      ventanaId?: string;
      bancaId?: string;
      sorteoId?: string;
      userRole?: string;
      ignoreReset?: boolean;
      forceRefresh?: boolean;
    },
    vendedorId: string,
    dateRange: { fromAt: Date; toAt: Date },
    rangeEffectiveMonth: string
  ) {
    const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
    const toAtComponents = getCRLocalComponents(dateRange.toAt);
    const startDateStr = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
    const endDateStr = `${toAtComponents.year}-${String(toAtComponents.month).padStart(2, '0')}-${String(toAtComponents.day).padStart(2, '0')}`;

    const [sy, sm, sd] = startDateStr.split('-').map(Number);
    const startDateUTC = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0));
    const [ey, em, ed] = endDateStr.split('-').map(Number);
    const endDateUTC = new Date(Date.UTC(ey, em - 1, ed, 0, 0, 0, 0));

    const monthlyRange = resolveDateRange("month");
    const monthlyStartDate = monthlyRange.fromAt;
    const monthlyEndDate = monthlyRange.toAt;
    const monthlyStartDateStr = crDateService.dateUTCToCRString(monthlyStartDate);
    const monthlyEndDateStr = crDateService.dateUTCToCRString(monthlyEndDate);
    const monthlyStartComponents = getCRLocalComponents(monthlyStartDate);
    const effectiveMonth = `${monthlyStartComponents.year}-${String(monthlyStartComponents.month).padStart(2, '0')}`;

    // 1. Ejecutar en paralelo lecturas indexadas (sin tocar Ticket ni Jugada)
    const [
      statements,
      movementsByDate,
      rangePreviousMonthBalance,
      realMonthlyRemainingBalance,
      rcdCommissionsRows,
      rcdMonthRows,
      monthlyMovementsByDate,
      userSettingsRow,
      totalSorteosCount,
    ] = await Promise.all([
      // A. AccountStatement: lectura directa por índice de vendedorId y rango de fechas
      prisma.accountStatement.findMany({
        where: {
          vendedorId,
          date: {
            gte: startDateUTC,
            lte: endDateUTC,
          },
        },
        select: {
          date: true,
          totalSales: true,
          totalPayouts: true,
          vendedorCommission: true,
          listeroCommission: true,
          ticketCount: true,
          totalPaid: true,
          totalCollected: true,
          balance: true,
          remainingBalance: true,
          accumulatedBalance: true,
        },
        orderBy: { date: 'desc' },
      }),

      // B. Movimientos en AccountPayment del rango
      AccountPaymentRepository.findMovementsByDateRange(
        dateRange.fromAt,
        dateRange.toAt,
        "vendedor",
        undefined,
        vendedorId
      ),

      // C. Balance previo del mes
      getPreviousMonthFinalBalance(
        effectiveMonth,
        "vendedor",
        undefined,
        vendedorId,
        undefined
      ),

      // D. Saldo mensual remanente real
      getMonthlyRemainingBalance(
        effectiveMonth,
        "vendedor",
        undefined,
        vendedorId
      ),

      // E. Desglose de comisiones por tipo (NUMERO vs REVENTADO) desde ResumenCierreDiario
      prisma.$queryRaw<
        Array<{
          businessDate: Date;
          commission_by_number: number;
          commission_by_reventado: number;
          total_sorteos: bigint | number;
        }>
      >(Prisma.sql`
        SELECT 
          rcd."businessDate",
          COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
          COUNT(DISTINCT rcd."sorteoId") as total_sorteos
        FROM "ResumenCierreDiario" rcd
        WHERE rcd."businessDate" >= ${startDateStr}::date
          AND rcd."businessDate" <= ${endDateStr}::date
          AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)
          ${params.loteriaId ? Prisma.sql`AND rcd."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
        GROUP BY rcd."businessDate"
      `),

      // F. Totales mensuales desde ResumenCierreDiario para monthlyAccumulated
      prisma.$queryRaw<
        Array<{
          total_sales: number;
          total_commission: number;
          commission_by_number: number;
          commission_by_reventado: number;
          total_prizes: number;
          total_tickets: bigint | number;
        }>
      >(Prisma.sql`
        SELECT 
          COALESCE(SUM(rcd."totalVendida"), 0) as total_sales,
          COALESCE(SUM(rcd."comisionVendedor"), 0) as total_commission,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
          COALESCE(SUM(rcd.ganado), 0) as total_prizes,
          COALESCE(SUM(rcd."ticketsCount"), 0) as total_tickets
        FROM "ResumenCierreDiario" rcd
        WHERE rcd."businessDate" >= ${monthlyStartDateStr}::date
          AND rcd."businessDate" <= ${monthlyEndDateStr}::date
          AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)
          ${params.loteriaId ? Prisma.sql`AND rcd."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
      `),

      // G. Pagos y cobros mensuales
      AccountPaymentRepository.findMovementsByDateRange(
        monthlyStartDate,
        monthlyEndDate,
        "vendedor",
        undefined,
        vendedorId
      ),

      // H. balanceResetAt del vendedor
      prisma.user.findUnique({
        where: { id: vendedorId },
        select: { settings: true },
      }),

      // I. Total de sorteos evaluados en el rango
      prisma.sorteo.count({
        where: {
          status: SorteoStatus.EVALUATED,
          scheduledAt: {
            gte: dateRange.fromAt,
            lte: dateRange.toAt,
          },
          ...(params.bancaId ? { bancaId: params.bancaId } : {}),
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        },
      }),
    ]);

    // Mapear statements por fecha string (YYYY-MM-DD)
    const statementByDate = new Map<string, (typeof statements)[0]>();
    for (const s of statements) {
      const dStr = crDateService.postgresDateToCRString(s.date);
      statementByDate.set(dStr, s);
    }

    // Mapear comisiones por fecha
    const rcdByDate = new Map<string, (typeof rcdCommissionsRows)[0]>();
    for (const r of rcdCommissionsRows) {
      const dStr = crDateService.postgresDateToCRString(r.businessDate);
      rcdByDate.set(dStr, r);
    }

    // Unir todas las fechas con actividad o statement
    const allDatesSet = new Set<string>();
    for (const dStr of statementByDate.keys()) allDatesSet.add(dStr);
    for (const dStr of movementsByDate.keys()) allDatesSet.add(dStr);

    const sortedDates = Array.from(allDatesSet).sort((a, b) => b.localeCompare(a));
    const daysArray = sortedDates.map((dateStr) => {
      const stmt = statementByDate.get(dateStr);
      const rcd = rcdByDate.get(dateStr);
      const moves = movementsByDate.get(dateStr) || [];

      const totalSales = stmt ? stmt.totalSales : 0;
      const totalCommission = stmt ? stmt.vendedorCommission : 0;
      const commissionByNumber = Number(rcd?.commission_by_number || 0);
      const commissionByReventado = Number(rcd?.commission_by_reventado || 0);
      const totalPrizes = stmt ? stmt.totalPayouts : 0;
      const totalTickets = stmt ? stmt.ticketCount : 0;

      const totalPaid = moves
        .filter((m: any) => m.type === "payment" && !m.id?.includes('previous-month-balance'))
        .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
      const totalCollected = moves
        .filter((m: any) => m.type === "collection" && !m.id?.includes('previous-month-balance'))
        .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);

      const totalBalance = stmt ? stmt.balance : totalSales - totalPrizes - totalCommission;
      const totalRemainingBalance = stmt ? stmt.remainingBalance : totalBalance - totalCollected + totalPaid;
      const totalSubtotal = totalRemainingBalance;
      const accumulated = stmt ? Number(stmt.remainingBalance) || Number(stmt.accumulatedBalance) || 0 : 0;

      return {
        date: dateStr,
        sorteos: [], // summaryOnly: true -> siempre vacío
        dayTotals: {
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
          totalSubtotal,
          accumulated,
        },
      };
    });

    // Fallback: si no hay actividad en el rango pero hay saldo acumulado previo
    if (daysArray.length === 0) {
      const lastStmt = await prisma.accountStatement.findFirst({
        where: {
          vendedorId,
          date: { lt: startDateUTC },
        },
        orderBy: { date: 'desc' },
        select: { accumulatedBalance: true, remainingBalance: true },
      });
      const fallbackAccumulated = lastStmt
        ? Number(lastStmt.remainingBalance) || Number(lastStmt.accumulatedBalance) || 0
        : Number(rangePreviousMonthBalance) || 0;

      if (fallbackAccumulated !== 0) {
        daysArray.push({
          date: startDateStr,
          sorteos: [],
          dayTotals: {
            totalSales: 0,
            totalCommission: 0,
            commissionByNumber: 0,
            commissionByReventado: 0,
            totalPrizes: 0,
            totalTickets: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalBalance: 0,
            totalRemainingBalance: 0,
            totalSubtotal: 0,
            accumulated: fallbackAccumulated,
          },
        });
      }
    }

    // Respetar balanceResetAt si aplica al vendedor
    let balanceResetAt: Date | null = null;
    if (userSettingsRow?.settings && (userSettingsRow.settings as Record<string, any>).balanceResetAt) {
      balanceResetAt = new Date((userSettingsRow.settings as Record<string, any>).balanceResetAt);
    }

    let finalDaysArray = daysArray;
    if (balanceResetAt && params.userRole === Role.VENDEDOR && !params.ignoreReset) {
      const resetAtDayStr = crDateService.dateUTCToCRString(balanceResetAt);
      finalDaysArray = daysArray.filter((day) => day.date >= resetAtDayStr);
    }

    // Totales del período
    const totals = {
      totalSales: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
      totalCommission: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
      commissionByNumber: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
      commissionByReventado: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
      totalPrizes: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
      totalTickets: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
      totalPaid: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
      totalCollected: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
      totalBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0),
      totalRemainingBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
      totalSubtotal: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
    };

    // Totales del mes completo (monthlyAccumulated)
    const monthlyTotals = rcdMonthRows[0] || {
      total_sales: 0,
      total_commission: 0,
      commission_by_number: 0,
      commission_by_reventado: 0,
      total_prizes: 0,
      total_tickets: 0,
    };

    const mTotalSales = Number(monthlyTotals.total_sales) || 0;
    const mTotalCommission = Number(monthlyTotals.total_commission) || 0;
    const mCommissionByNumber = Number(monthlyTotals.commission_by_number) || 0;
    const mCommissionByReventado = Number(monthlyTotals.commission_by_reventado) || 0;
    const mTotalPrizes = Number(monthlyTotals.total_prizes) || 0;
    const mTotalTickets = Number(monthlyTotals.total_tickets) || 0;

    let mTotalPaid = 0;
    let mTotalCollected = 0;
    for (const moves of monthlyMovementsByDate.values()) {
      mTotalPaid += moves
        .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
        .reduce((sum: number, m: any) => sum + m.amount, 0);
      mTotalCollected += moves
        .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
        .reduce((sum: number, m: any) => sum + m.amount, 0);
    }

    const prevBalance = Number(rangePreviousMonthBalance) || 0;
    const mTotalBalance = mTotalSales - mTotalPrizes - mTotalCommission;
    const mTotalRemainingBalance = mTotalBalance - mTotalCollected + mTotalPaid;
    const finalMonthlyRemainingBalance = realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : prevBalance + mTotalRemainingBalance;

    const monthlyAccumulated = {
      totalSales: mTotalSales,
      totalCommission: mTotalCommission,
      commissionByNumber: mCommissionByNumber,
      commissionByReventado: mCommissionByReventado,
      totalPrizes: mTotalPrizes,
      totalTickets: mTotalTickets,
      totalPaid: mTotalPaid,
      totalCollected: mTotalCollected,
      totalBalance: prevBalance + mTotalBalance,
      totalRemainingBalance: finalMonthlyRemainingBalance,
      totalSubtotal: finalMonthlyRemainingBalance,
    };

    return {
      data: finalDaysArray,
      meta: {
        totals,
        monthlyAccumulated,
        dateFilter: params.date || "today",
        ...(params.fromDate ? { fromDate: params.fromDate } : {}),
        ...(params.toDate ? { toDate: params.toDate } : {}),
        totalSorteos: totalSorteosCount,
        totalDays: finalDaysArray.length,
      },
    };
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
      summaryOnly?: boolean;
      ventanaId?: string;
      bancaId?: string;
      sorteoId?: string;
      userRole?: string;
      ignoreReset?: boolean;
      forceRefresh?: boolean;
    },
    vendedorId?: string
  ) {
    //  FASE BE-2: Implementación de Cache-Aside con Coalescing y Normalización
    const normalizedKeyData = {
      date: params.date || "today",
      fromDate: params.fromDate || null,
      toDate: params.toDate || null,
      scope: params.scope || "mine",
      loteriaId: params.loteriaId || null,
      isActive: params.isActive !== "false" && params.isActive !== "0",
      summaryOnly: Boolean(params.summaryOnly),
      vendedorId: vendedorId || null,
      ignoreReset: Boolean(params.ignoreReset),
    };

    const cacheKey = `banca:${params.bancaId || 'all'}:ventana:${params.ventanaId || 'all'}:vendedor:${vendedorId || 'all'}:summary:${crypto
      .createHash('md5')
      .update(JSON.stringify(normalizedKeyData))
      .digest('hex')}`;

    const tags = ['report:summary'];
    if (vendedorId) tags.push(`vendedor:${vendedorId}`);
    if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
    if (params.bancaId) tags.push(`banca:${params.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    const isForceRefresh = Boolean(params.forceRefresh);

    return SingleFlight.do(cacheKey, async () => {
      return CacheService.wrap(
        cacheKey,
        async () => {
          // Mutex distribuido ligero: si múltiples réplicas en Render reciben miss simultáneo,
          // una sola calcula en DB y las demás esperan el resultado en caché L1/L2.
          const redis = getRedisClient();
          const inflightLockKey = `lock:calc:summary:${cacheKey}`;
          let acquiredDistLock = false;

          if (redis && !isForceRefresh) {
            try {
              const lockRes = await (redis as any).set(inflightLockKey, "1", "PX", 8000, "NX");
              if (lockRes !== "OK") {
                // Otra instancia ya está calculando este mismo resumen.
                // Esperar hasta 2500ms sondeando la caché antes de recurrir a la DB.
                const waitStart = Date.now();
                while (Date.now() - waitStart < 2500) {
                  await new Promise((r) => setTimeout(r, 80));
                  const cached = await CacheService.get<any>(cacheKey, true, 90_000);
                  if (cached !== null) {
                    logger.info({
                      layer: "service",
                      action: "DISTRIBUTED_SINGLE_FLIGHT_CACHE_HIT",
                      payload: { cacheKey, waitMs: Date.now() - waitStart },
                    });
                    return cached;
                  }
                }
              } else {
                acquiredDistLock = true;
              }
            } catch (distLockErr: any) {
              logger.warn({
                layer: "service",
                action: "DISTRIBUTED_LOCK_WARN",
                payload: { cacheKey, error: distLockErr?.message },
              });
            }
          }

          try {
            // Resolver rango de fechas
            const dateRange = resolveDateRange(
              params.date || "today",
              params.fromDate,
              params.toDate
            );

            //  FAST-PATH: summaryOnly=true con vendedorId
            // Resuelve desde AccountStatement en < 5 ms evitando escanear Ticket/Jugada
            if (params.summaryOnly && vendedorId) {
              const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
              const rangeEffectiveMonth = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}`;
              return await this.evaluatedSummaryFastPath(params, vendedorId, dateRange, rangeEffectiveMonth);
            }

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


      //  C3.4 OPTIMIZACIÓN: Resolver rango mensual una sola vez (se usa en monthlyAccumulated)
      const monthlyRange = resolveDateRange("month");
      const monthlyStartDate = monthlyRange.fromAt;
      const monthlyEndDate = monthlyRange.toAt;

      const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
      const rangeEffectiveMonth = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}`;

      // Tareas de ejecución paralela para métricas principales
      const [sorteoMetricsRaw, movementsByDate, rangePreviousMonthBalance] = await Promise.all([
        prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT 
            s.id as "sorteoId", s."scheduledAt", s."loteriaId", s.name as "sorteoName", s."extraMultiplierId", s."extraMultiplierX", s."winningNumber",
            l.name as "loteriaName",
            SUM(rcd."totalVendida") as "totalSales",
            SUM(rcd."comisionTotal") as "totalCommission",
            SUM(rcd."ganado") as "totalPrizes",
            SUM(rcd."ticketsCount")::integer as "ticketCount"
          FROM "ResumenCierreDiario" rcd
          JOIN "Sorteo" s ON rcd."sorteoId" = s.id
          JOIN "Loteria" l ON s."loteriaId" = l.id
          WHERE s.status::text = ${SorteoStatus.EVALUATED}
            AND s."scheduledAt" >= CAST(${dateRange.fromAt} AS timestamp)
            AND s."scheduledAt" <= CAST(${dateRange.toAt} AS timestamp)
            ${vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
            ${params.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${params.ventanaId} AS uuid)` : Prisma.empty}
            ${params.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${params.bancaId} AS uuid)` : Prisma.empty}
            ${params.loteriaId ? Prisma.sql`AND s."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
          GROUP BY s.id, s."scheduledAt", s."loteriaId", s.name, s."extraMultiplierId", s."extraMultiplierX", s."winningNumber", l.name
          ORDER BY s."scheduledAt" ASC, s."loteriaId" ASC, s.id ASC
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
        )
      ]);

      const sorteoIds = sorteoMetricsRaw.map((sm) => sm.sorteoId);

      let ticketMetrics: any[] = [];
      let multiplierMetricsRaw: any[] = [];
      let loteriaMultipliers: any[] = [];

      if (sorteoIds.length > 0 && !params.summaryOnly) {
        const ticketMetricsPromise = prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT 
            "sorteoId",
            COUNT(CASE WHEN "isWinner" THEN 1 END) as "winningTicketsCount",
            COUNT(CASE WHEN status::text IN (${TicketStatus.PAID}, ${TicketStatus.PAGADO}) THEN 1 END) as "paidTicketsCount",
            SUM("totalCommission") as "vendedorCommissionSum"
          FROM "Ticket"
          WHERE "sorteoId" IN (${Prisma.join(sorteoIds)})
            AND "isActive" = ${ticketIsActive}
            AND "deletedAt" IS NULL
            ${vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
            ${params.ventanaId ? Prisma.sql`AND "ventanaId" = CAST(${params.ventanaId} AS uuid)` : Prisma.empty}
            ${params.bancaId ? Prisma.sql`AND "bancaId" = CAST(${params.bancaId} AS uuid)` : Prisma.empty}
          GROUP BY "sorteoId"
        `);

        const multiplierMetricsPromise = prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT 
            t."sorteoId", j."multiplierId",
            SUM(j.amount) as "mSales", 
            SUM(j."commissionAmount") as "mCommission",
            SUM(CASE WHEN j.type::text = ${BetType.NUMERO} THEN j."commissionAmount" ELSE 0 END) as "mCommNum",
            SUM(CASE WHEN j.type::text = ${BetType.REVENTADO} THEN j."commissionAmount" ELSE 0 END) as "mCommRev",
            SUM(CASE WHEN j."isWinner" THEN j.payout ELSE 0 END) as "mPrizes",
            COUNT(DISTINCT t.id) as "mTickets", 
            COUNT(CASE WHEN j."isWinner" THEN 1 END) as "mWinningTickets",
            COUNT(CASE WHEN t.status::text IN (${TicketStatus.PAID}, ${TicketStatus.PAGADO}) THEN 1 END) as "mPaidTickets"
          FROM "Ticket" t
          JOIN "Jugada" j ON j."ticketId" = t.id
          WHERE t."sorteoId" IN (${Prisma.join(sorteoIds)})
            AND t."isActive" = ${ticketIsActive}
            AND t."deletedAt" IS NULL
            AND j."deletedAt" IS NULL
            AND j."isActive" = true
            ${vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
            ${params.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${params.ventanaId} AS uuid)` : Prisma.empty}
            ${params.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${params.bancaId} AS uuid)` : Prisma.empty}
          GROUP BY t."sorteoId", j."multiplierId"
        `);

        const loteriaMultipliersPromise = prisma.loteriaMultiplier.findMany({
          select: { id: true, name: true, valueX: true, loteriaId: true, kind: true, isActive: true }
        });

        const detailsResults = await Promise.all([
          ticketMetricsPromise,
          multiplierMetricsPromise,
          loteriaMultipliersPromise,
        ]);

        ticketMetrics = detailsResults[0];
        multiplierMetricsRaw = detailsResults[1];
        loteriaMultipliers = detailsResults[2];
      }

      const sorteoMetrics = sorteoMetricsRaw.map((sm: any) => {
        const tm = ticketMetrics.find((t) => t.sorteoId === sm.sorteoId);
        return {
          ...sm,
          totalCommission: Number(tm?.vendedorCommissionSum || 0),
          winningTicketsCount: Number(tm?.winningTicketsCount || 0),
          paidTicketsCount: Number(tm?.paidTicketsCount || 0)
        };
      });

      const consolidatedMetrics = sorteoMetrics.map((sm: any) => {
        let by_multiplier: any[] = [];
        
        if (!params.summaryOnly) {
          const baseMultipliers = loteriaMultipliers.filter((m: any) => 
            m.loteriaId === sm.loteriaId && (m.isActive || multiplierMetricsRaw.some((mm: any) => mm.sorteoId === sm.sorteoId && mm.multiplierId === m.id))
          );
          
          by_multiplier = baseMultipliers.map((bm: any) => {
            const mm = multiplierMetricsRaw.find((m: any) => m.sorteoId === sm.sorteoId && m.multiplierId === bm.id);

            return {
              multiplierId: bm.id,
              multiplierName: bm.name,
              multiplierValue: Number(bm.valueX),
              totalSales: Number(mm?.mSales || 0),
              totalCommission: Number(mm?.mCommission || 0),
              commissionByNumber: Number(mm?.mCommNum || 0),
              commissionByReventado: Number(mm?.mCommRev || 0),
              totalPrizes: Number(mm?.mPrizes || 0),
              ticketCount: Number(mm?.mTickets || 0),
              winningTicketsCount: Number(mm?.mWinningTickets || 0),
              paidTicketsCount: Number(mm?.mPaidTickets || 0),
              unpaidTicketsCount: Number(mm?.mWinningTickets || 0) - Number(mm?.mPaidTickets || 0)
            };
          }).sort((a: any, b: any) => a.multiplierValue - b.multiplierValue);

          // Manejar jugadas con multiplierId = null.
          // Causa conocida: fn_evaluate_sorteo solo asigna extraMultiplierId a jugadas REVENTADO ganadoras,
          // los perdedores quedan con multiplierId = null. Si el sorteo tiene extraMultiplierId, fusionar
          // esas jugadas en el bucket correcto en lugar de mostrarlas como "Desconocido / Eliminado".
          const nullMetrics = multiplierMetricsRaw.find((m: any) => m.sorteoId === sm.sorteoId && m.multiplierId === null);
          if (nullMetrics) {
            const reventadoBucket = sm.extraMultiplierId
              ? by_multiplier.find((b: any) => b.multiplierId === sm.extraMultiplierId)
              : null;

            if (reventadoBucket) {
              // Fusionar en el bucket del multiplicador REVENTADO del sorteo
              reventadoBucket.totalSales        += Number(nullMetrics.mSales || 0);
              reventadoBucket.totalCommission   += Number(nullMetrics.mCommission || 0);
              reventadoBucket.commissionByNumber   += Number(nullMetrics.mCommNum || 0);
              reventadoBucket.commissionByReventado += Number(nullMetrics.mCommRev || 0);
              reventadoBucket.totalPrizes       += Number(nullMetrics.mPrizes || 0);
              reventadoBucket.ticketCount       += Number(nullMetrics.mTickets || 0);
              reventadoBucket.winningTicketsCount += Number(nullMetrics.mWinningTickets || 0);
              reventadoBucket.paidTicketsCount  += Number(nullMetrics.mPaidTickets || 0);
              reventadoBucket.unpaidTicketsCount = reventadoBucket.winningTicketsCount - reventadoBucket.paidTicketsCount;
            } else if (sm.extraMultiplierId) {
              // El bucket REVENTADO no existe aún (multiplicador inactivo y sin jugadas ganadoras).
              // Crearlo usando los datos del multiplicador.
              const reventadoMul = loteriaMultipliers.find((m: any) => m.id === sm.extraMultiplierId);
              by_multiplier.push({
                multiplierId: sm.extraMultiplierId,
                multiplierName: reventadoMul?.name ?? 'REVENTADO',
                multiplierValue: Number(reventadoMul?.valueX ?? 0),
                totalSales: Number(nullMetrics.mSales || 0),
                totalCommission: Number(nullMetrics.mCommission || 0),
                commissionByNumber: Number(nullMetrics.mCommNum || 0),
                commissionByReventado: Number(nullMetrics.mCommRev || 0),
                totalPrizes: Number(nullMetrics.mPrizes || 0),
                ticketCount: Number(nullMetrics.mTickets || 0),
                winningTicketsCount: Number(nullMetrics.mWinningTickets || 0),
                paidTicketsCount: Number(nullMetrics.mPaidTickets || 0),
                unpaidTicketsCount: Number(nullMetrics.mWinningTickets || 0) - Number(nullMetrics.mPaidTickets || 0)
              });
            } else {
              // No hay extraMultiplierId: multiplicador realmente desconocido/eliminado (fallback)
              by_multiplier.push({
                multiplierId: null,
                multiplierName: 'Desconocido / Eliminado',
                multiplierValue: 0,
                totalSales: Number(nullMetrics.mSales || 0),
                totalCommission: Number(nullMetrics.mCommission || 0),
                commissionByNumber: Number(nullMetrics.mCommNum || 0),
                commissionByReventado: Number(nullMetrics.mCommRev || 0),
                totalPrizes: Number(nullMetrics.mPrizes || 0),
                ticketCount: Number(nullMetrics.mTickets || 0),
                winningTicketsCount: Number(nullMetrics.mWinningTickets || 0),
                paidTicketsCount: Number(nullMetrics.mPaidTickets || 0),
                unpaidTicketsCount: Number(nullMetrics.mWinningTickets || 0) - Number(nullMetrics.mPaidTickets || 0)
              });
            }
          }
        }
        
        return { ...sm, by_multiplier };
      });

      //  PASO 2: Construir datos de sorteos SIN calcular accumulated aún
      const sorteoData = consolidatedMetrics.map((row: any) => {
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
          winningNumber: row.winningNumber ?? null,
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



      // Inyectar movimiento sintético "Saldo del mes anterior" si el rango empieza el día 1
      const firstDayOfRange = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
      if (fromAtComponents.day === 1) {
        const firstDayMovements = movementsByDate.get(firstDayOfRange) || [];
        const movementId = `previous-month-balance-${vendedorId}`;
        const alreadyExists = firstDayMovements.some((m: any) => m.id === movementId);
        const numericPreviousBalance = Number(rangePreviousMonthBalance) || 0;
        if (!alreadyExists && numericPreviousBalance !== 0) {
          firstDayMovements.unshift({
            id: movementId,
            type: "payment" as const,
            amount: numericPreviousBalance,
            method: "Saldo del mes anterior",
            notes: `Saldo arrastrado del mes anterior`,
            isReversed: false,
            createdAt: new Date(`${firstDayOfRange}T00:00:00.000Z`).toISOString(),
            date: firstDayOfRange,
            time: '00:00',
            isOpeningBalance: true,
          });
          movementsByDate.set(firstDayOfRange, firstDayMovements);
        }
      }

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

      let initialAccumulatedForRange = 0;

      // Calcular siempre recursivamente, el frontend ya no nos pasa initialAccumulated
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
            select: { accumulatedBalance: true, remainingBalance: true },
          });

          if (previousDayStatement) {
            //  Si hay statement del día anterior, empezamos desde su acumulado
            // Y no hay gap (porque el día anterior ya tiene su cierre, no hay boletos perdidos)
            initialAccumulatedForRange = Number(previousDayStatement.remainingBalance) || Number(previousDayStatement.accumulatedBalance) || 0;
            // No sumar gap de tickets.
          } else {
            //  Si NO hay statement del día anterior, hay que buscar el último statement válido
            // que exista ANTES del rango consultado, para saber de dónde partir matemáticamente.
            const lastStatementBeforeRange = await prisma.accountStatement.findFirst({
              where: {
                vendedorId,
                date: { lt: previousDay },
              },
              orderBy: { date: 'desc' },
              select: { date: true, accumulatedBalance: true, remainingBalance: true },
            });

            let baseBalance = 0;
            let gapStart = new Date(Date.UTC(firstYear, firstMonth - 1, 1, 0, 0, 0, 0)); // Fallback: inicio de mes

            if (lastStatementBeforeRange) {
              baseBalance = Number(lastStatementBeforeRange.remainingBalance) || Number(lastStatementBeforeRange.accumulatedBalance) || 0;
              // El gap empieza el día DESPUÉS de este último statement válido
              const lsDate = lastStatementBeforeRange.date;
              gapStart = new Date(Date.UTC(lsDate.getUTCFullYear(), lsDate.getUTCMonth(), lsDate.getUTCDate() + 1, 0, 0, 0, 0));
            } else {
              baseBalance = Number(rangePreviousMonthBalance) || 0;
            }

            // Si hay un gap de días sin statement, calcular los movimientos faltantes matemáticamente
            if (!params.summaryOnly && gapStart <= previousDay) {
              const gapTicketsSum = await prisma.$queryRaw<any[]>(Prisma.sql`
                SELECT SUM(t."totalAmount") - SUM(t."totalCommission") - SUM(CASE WHEN t."isWinner" THEN t."totalPayout" ELSE 0 END) as "gapBalance"
                FROM "Ticket" t
                JOIN "Sorteo" s ON t."sorteoId" = s.id
                WHERE t."deletedAt" IS NULL
                  AND t."vendedorId" = CAST(${vendedorId} AS uuid)
                  AND s.status::text = ${SorteoStatus.EVALUATED}
                  AND s."scheduledAt" >= CAST(${gapStart.toISOString().split('T')[0]} AS timestamp)
                  AND s."scheduledAt" < CAST(${new Date(previousDay.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]} AS timestamp)
              `);

              const gapPaymentsSum = await prisma.$queryRaw<any[]>(Prisma.sql`
                SELECT SUM(CASE WHEN m.type = 'payment' THEN m.amount ELSE -m.amount END) as "gapMovements"
                FROM "AccountPayment" m
                WHERE m."vendedorId" = CAST(${vendedorId} AS uuid)
                  AND m.date >= CAST(${gapStart.toISOString().split('T')[0]} AS date)
                  AND m.date <= CAST(${previousDay.toISOString().split('T')[0]} AS date)
                  AND m.status = 'COMPLETED'
              `);

              const gapBalance = Number(gapTicketsSum[0]?.gapBalance) || 0;
              const gapMovements = Number(gapPaymentsSum[0]?.gapMovements) || 0;
              initialAccumulatedForRange = baseBalance + gapBalance + gapMovements;
            } else {
              initialAccumulatedForRange = baseBalance;
            }
          }
        }
      }

      //  PASO 5: Calcular acumulado y chronologicalIndex por evento (sorteo/movimiento)
      //  CRÍTICO: Inicializar con el acumulado del día anterior al rango (o saldo mes anterior si es día 1)
      //  Esto garantiza que el accumulated sea ABSOLUTO, no relativo al período consultado
      let balanceResetAt: Date | null = null;
      if (vendedorId) {
        const user = await prisma.user.findUnique({
          where: { id: vendedorId },
          select: { settings: true }
        });
        if (user?.settings && (user.settings as Record<string, any>).balanceResetAt) {
          balanceResetAt = new Date((user.settings as Record<string, any>).balanceResetAt);
        }
      }

      let eventAccumulated = initialAccumulatedForRange;
      let lastProcessedDate = '';
      const totalEvents = allEvents.length;
      let resetApplied = false;

      const dataWithAccumulated = allEvents.map((event, index) => {
        const eventDate = event.date;

        //  CRÍTICO: Si cambiamos de día dentro del rango, verificar si necesitamos
        //  ajustar el acumulado (en caso de gaps entre días sin el movimiento especial)
        if (lastProcessedDate && eventDate !== lastProcessedDate) {
          //  El acumulado ya incluye todos los eventos del día anterior,
          //  así que solo continuamos sumando (el carry-over es automático)
        }
        lastProcessedDate = eventDate;

        // Si hay balanceResetAt, y el evento ocurre en/después del reset, y no lo hemos reiniciado aún
        if (balanceResetAt && !resetApplied && balanceResetAt.getTime() >= dateRange.fromAt.getTime()) {
          const eventTime = new Date(event.scheduledAt).getTime();
          if (eventTime >= balanceResetAt.getTime()) {
            eventAccumulated = 0;
            resetApplied = true;
          }
        }

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

          // El acumulado real del día (antes de AccountStatement) es el del último evento de ese día.
          // Como eventsDelDia ya está ordenado cronológicamente, el último evento tiene el closing balance.
          const lastEvent = eventsDelDia.length > 0 ? eventsDelDia[eventsDelDia.length - 1] : null;
          const dynamicAccumulated = lastEvent ? lastEvent.accumulated : 0;

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
            accumulated: dynamicAccumulated, // Se inicializa con el calculado (fallback si falta en AccountStatement)
          };

          //  ACTUALIZADO: Formatear todos los eventos (sorteos + movimientos)
          const eventsFormatted = eventsDelDia.map((e) => ({
            ...e,
            scheduledAt: formatIsoLocal(e.scheduledAt),
          }));

          return {
            date,
            sorteos: params.summaryOnly ? [] : eventsFormatted, // Vacío si es solo resumen
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

      //  FIX: Si no hay eventos pero hay saldo acumulado inicial (arrastre de días anteriores),
      //  inyectar un día vacío para "hoy" con ese acumulado visible para el vendedor.
      if (daysArray.length === 0 && vendedorId && initialAccumulatedForRange !== 0) {
        const todayDateStr = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
        daysArray.push({
          date: todayDateStr,
          sorteos: [],
          dayTotals: {
            totalSales: 0,
            totalCommission: 0,
            commissionByNumber: 0,
            commissionByReventado: 0,
            totalPrizes: 0,
            totalTickets: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalBalance: 0,
            totalRemainingBalance: 0,
            totalSubtotal: 0,
            accumulated: initialAccumulatedForRange,
          },
        });
      }

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
          remainingBalance: true,
        },
      });

      // Crear mapa de fecha -> accumulatedBalance
      const accumulatedByDate = new Map<string, number>();
      for (const stmt of statementsForAccumulated) {
        const dateStr = crDateService.postgresDateToCRString(stmt.date);
        const valToUse = Number(stmt.remainingBalance) || Number(stmt.accumulatedBalance) || 0;
        accumulatedByDate.set(dateStr, valToUse);
      }

      // Asignar accumulated a cada día desde AccountStatement.
      //  FIX: Para hoy (día activo), si AccountStatement aún no tiene el acumulado
      //  actualizado (valor 0 o ausente), mantener el valor ya calculado dinámicamente
      //  desde el event flow (initialAccumulatedForRange + subtotales del día).
      const todayStr = crDateService.dateUTCToCRString(new Date());
      for (const day of daysArray) {
        const fromDb = accumulatedByDate.get(day.date);
        if (fromDb !== undefined && fromDb !== 0) {
          // Hay valor guardado en DB y no es 0 → usar el de DB (fuente de verdad)
          day.dayTotals.accumulated = fromDb;
        }
        // Si fromDb === 0 o undefined, mantenemos el dynamicAccumulated que fue 
        // calculado dinámicamente de forma matemática sumando todos los eventos.
      }

      // Ocultar días anteriores al reset únicamente para el vendedor si ignoreReset no está activo
      let finalDaysArray = daysArray;
      if (balanceResetAt && params.userRole === Role.VENDEDOR && !params.ignoreReset) {
        const resetAtDayStr = crDateService.dateUTCToCRString(balanceResetAt);
        finalDaysArray = daysArray.filter(day => day.date >= resetAtDayStr);
      }

      // Calcular totales agregados (suma de todos los días filtrados)
      const totals = {
        totalSales: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
        totalCommission: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
        commissionByNumber: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
        commissionByReventado: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
        totalPrizes: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
        totalTickets: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
        totalPaid: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
        totalCollected: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
        totalBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0),
        totalRemainingBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
        totalSubtotal: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
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

      const realMonthlyRemainingBalance = vendedorId
        ? await getMonthlyRemainingBalance(effectiveMonth, "vendedor", undefined, vendedorId)
        : null;

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
        const monthlyCommissionByNumber = sorteoData.reduce((sum: number, s: any) => sum + s.commissionByNumber, 0);
        const monthlyCommissionByReventado = sorteoData.reduce((sum: number, s: any) => sum + s.commissionByReventado, 0);

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
          totalRemainingBalance: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
          totalSubtotal: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
        };
      } else {
        // ⚡ OPTIMIZACIÓN EXTREMA: Lectura O(1) desde ResumenCierreDiario precalculado
        // Resuelve ventas, premios, comisiones totales y por tipo (Número/Reventado) en <1ms
        const monthlyStartDateStr = crDateService.dateUTCToCRString(monthlyStartDate);
        const monthlyEndDateStr = crDateService.dateUTCToCRString(monthlyEndDate);

        const rcdTotals = await prisma.$queryRaw<Array<{
          total_sales: number;
          total_commission: number;
          commission_by_number: number;
          commission_by_reventado: number;
          total_prizes: number;
          total_tickets: bigint;
        }>>(Prisma.sql`
          SELECT 
            COALESCE(SUM("totalVendida"), 0) as total_sales,
            COALESCE(SUM("comisionVendedor"), 0) as total_commission,
            COALESCE(SUM(CASE WHEN tipo = 'NUMERO' THEN "comisionVendedor" ELSE 0 END), 0) as commission_by_number,
            COALESCE(SUM(CASE WHEN tipo = 'REVENTADO' THEN "comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
            COALESCE(SUM(ganado), 0) as total_prizes,
            COALESCE(SUM("ticketsCount"), 0) as total_tickets
          FROM "ResumenCierreDiario"
          WHERE "businessDate" >= ${monthlyStartDateStr}::date
            AND "businessDate" <= ${monthlyEndDateStr}::date
            ${vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
            ${params.loteriaId ? Prisma.sql`AND "loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
        `);

        const monthlyTotals = rcdTotals[0] || {
          total_sales: 0,
          total_commission: 0,
          commission_by_number: 0,
          commission_by_reventado: 0,
          total_prizes: 0,
          total_tickets: BigInt(0),
        };

        const monthlyTotalSales = Number(monthlyTotals.total_sales) || 0;
        const monthlyTotalCommission = Number(monthlyTotals.total_commission) || 0;
        const monthlyCommissionByNumber = Number(monthlyTotals.commission_by_number) || 0;
        const monthlyCommissionByReventado = Number(monthlyTotals.commission_by_reventado) || 0;
        const monthlyTotalPrizes = Number(monthlyTotals.total_prizes) || 0;
        const monthlyTotalTickets = Number(monthlyTotals.total_tickets) || 0;

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
          totalRemainingBalance: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
          totalSubtotal: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
        };
      }
      const result = {
        data: finalDaysArray,
        meta: {
          totals,
          monthlyAccumulated, //  NUEVO: Acumulado del mes completo
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalSorteos: sorteoData.length,
          totalDays: finalDaysArray.length,
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
    } finally {
      if (acquiredDistLock && redis) {
        await redis.del(inflightLockKey).catch(() => {});
      }
    }
  }, 300, tags, true, 90_000, isForceRefresh);
    });
  },

  /**
   * Espera activa no bloqueante a que otra instancia de Render libere el lock de warmup.
   * Evita que la instancia secundaria emita el broadcast de WebSocket antes de que los datos
   * terminen de escribirse en Redis/L1 por la instancia primaria.
   */
  async waitForWarmupLockRelease(lockKey: string, maxWaitMs = 5000): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const exists = await redis.exists(lockKey);
        if (!exists) return; // Lock liberado por la instancia activa
      } catch {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  },

  /**
   * Precalentamiento atómico O(1) de resúmenes evaluados para todos los vendedores
   * involucrados en un sorteo y su banca.
   * Ejecuta agregaciones en lote en PostgreSQL (<50ms) y puebla simultáneamente L1 (RAM)
   * y L2 (Upstash Redis) mediante un pipeline atómico, eliminando 234+ queries individuales.
   */
  async warmupSorteoSummariesBatch(
    sorteoId: string,
    bancaId?: string | null
  ): Promise<{ totalVendors: number; entriesCached: number }> {
    const redis = getRedisClient();
    const lockKey = `lock:warmup:batch:${sorteoId}`;
    let lockAcquired = false;

    if (redis) {
      try {
        // 1. Idempotencia y exclusión mutua distribuida: prevenir que 2 instancias en Render
        // procesen concurrentemente el mismo batch del sorteo.
        const lockRes = await (redis as any).set(lockKey, "locked", "PX", 15000, "NX");
        if (lockRes !== "OK") {
          logger.info({
            layer: "service",
            action: "WARMUP_BATCH_LOCK_SKIPPED",
            payload: { sorteoId, message: `Omitido para sorteo ${sorteoId}: ya en ejecución por otra instancia. Esperando finalización activa antes de permitir broadcast...` },
          });
          // Esperar activamente a que la instancia que adquirió el lock termine de escribir en Redis/L1
          // para no disparar el broadcast WebSocket prematuramente y causar Cache Stampede.
          await this.waitForWarmupLockRelease(lockKey, 5000);
          return { totalVendors: 0, entriesCached: 0 };
        }
        lockAcquired = true;
      } catch (lockErr: any) {
        logger.warn({
          layer: "service",
          action: "WARMUP_BATCH_LOCK_WARN",
          payload: { sorteoId, error: lockErr?.message },
        });
      }
    }

    const startTime = Date.now();

    try {
      // Resolver rangos de fecha de negocio en Costa Rica (UTC-6)
      const todayRange = resolveDateRange("today");
      const todayComponents = getCRLocalComponents(todayRange.fromAt);
      const todayDateStr = `${todayComponents.year}-${String(todayComponents.month).padStart(2, '0')}-${String(todayComponents.day).padStart(2, '0')}`;
      const effectiveMonth = `${todayComponents.year}-${String(todayComponents.month).padStart(2, '0')}`;

      const [year, month, day] = todayDateStr.split('-').map(Number);
      const todayUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

      const monthlyRange = resolveDateRange("month");
      const monthlyStartDateStr = crDateService.dateUTCToCRString(monthlyRange.fromAt);
      const monthlyEndDateStr = crDateService.dateUTCToCRString(monthlyRange.toAt);

      // 1. Vendedores activos de la estructura
      const activeVendors = await prisma.user.findMany({
        where: {
          role: Role.VENDEDOR,
          isActive: true,
          ...(bancaId ? { ventana: { bancaId } } : {}),
        },
        select: {
          id: true,
          settings: true,
        },
      });

      // 2. Vendedores con AccountStatement hoy (para incluir vendedores sin ventas en este sorteo pero con balance)
      const statementsToday = await prisma.accountStatement.findMany({
        where: {
          date: todayUTC,
          vendedorId: { not: null },
          ...(bancaId ? { bancaId } : {}),
        },
        select: {
          id: true,
          vendedorId: true,
          totalSales: true,
          totalPayouts: true,
          vendedorCommission: true,
          ticketCount: true,
          totalPaid: true,
          totalCollected: true,
          balance: true,
          remainingBalance: true,
          accumulatedBalance: true,
        },
      });

      // 3. Vendedores con registro en ResumenCierreDiario para este sorteo específico
      const rcdSorteoVendors = await prisma.resumenCierreDiario.findMany({
        where: { sorteoId },
        select: { vendedorId: true },
        distinct: ['vendedorId'],
      });

      const allVendorIdsSet = new Set<string>();
      const vendorResetMap = new Map<string, Date | null>();

      for (const v of activeVendors) {
        allVendorIdsSet.add(v.id);
        const resetAt =
          v.settings && (v.settings as Record<string, any>).balanceResetAt
            ? new Date((v.settings as Record<string, any>).balanceResetAt)
            : null;
        vendorResetMap.set(v.id, resetAt);
      }
      for (const s of statementsToday) {
        if (s.vendedorId) allVendorIdsSet.add(s.vendedorId);
      }
      for (const r of rcdSorteoVendors) {
        if (r.vendedorId) allVendorIdsSet.add(r.vendedorId);
      }

      const allVendorIds = Array.from(allVendorIdsSet);

      if (allVendorIds.length === 0) {
        logger.info({
          layer: 'service',
          action: 'WARMUP_BATCH_SKIPPED_NO_VENDORS',
          payload: { sorteoId, bancaId },
        });
        return { totalVendors: 0, entriesCached: 0 };
      }

      logger.info({
        layer: 'service',
        action: 'WARMUP_BATCH_START',
        payload: { sorteoId, bancaId, totalVendors: allVendorIds.length },
      });

      // Indexar statements de hoy por vendedorId
      const statementByVendor = new Map<string, (typeof statementsToday)[0]>();
      for (const s of statementsToday) {
        if (s.vendedorId) statementByVendor.set(s.vendedorId, s);
      }

      const vendorUuids = allVendorIds.map((id) => Prisma.sql`${id}::uuid`);

      // 4. Ejecución en paralelo de métricas consolidadas (PostgreSQL batch)
      const [
        rcdTodayRows,
        rcdMonthRows,
        paymentsMonthRows,
        prevMonthBalancesMap,
        realMonthlyRemainingBalancesMap,
        totalSorteosEvaluatedToday,
      ] = await Promise.all([
        // Desglose de comisiones hoy por tipo (NUMERO vs REVENTADO)
        prisma.$queryRaw<
          Array<{
            vendedorId: string;
            commission_by_number: number;
            commission_by_reventado: number;
            total_sorteos: bigint | number;
          }>
        >(Prisma.sql`
          SELECT 
            rcd."vendedorId",
            COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
            COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
            COUNT(DISTINCT rcd."sorteoId") as total_sorteos
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" = ${todayDateStr}::date
            AND rcd."vendedorId" IN (${Prisma.join(vendorUuids)})
          GROUP BY rcd."vendedorId"
        `),

        // Totales mensuales de ventas, premios y comisiones
        prisma.$queryRaw<
          Array<{
            vendedorId: string;
            total_sales: number;
            total_commission: number;
            commission_by_number: number;
            commission_by_reventado: number;
            total_prizes: number;
            total_tickets: bigint | number;
          }>
        >(Prisma.sql`
          SELECT 
            rcd."vendedorId",
            COALESCE(SUM(rcd."totalVendida"), 0) as total_sales,
            COALESCE(SUM(rcd."comisionVendedor"), 0) as total_commission,
            COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
            COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
            COALESCE(SUM(rcd.ganado), 0) as total_prizes,
            COALESCE(SUM(rcd."ticketsCount"), 0) as total_tickets
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" >= ${monthlyStartDateStr}::date
            AND rcd."businessDate" <= ${monthlyEndDateStr}::date
            AND rcd."vendedorId" IN (${Prisma.join(vendorUuids)})
          GROUP BY rcd."vendedorId"
        `),

        // Pagos y cobros mensuales
        prisma.$queryRaw<
          Array<{
            vendedorId: string;
            total_paid: number;
            total_collected: number;
          }>
        >(Prisma.sql`
          SELECT 
            ap."vendedorId",
            COALESCE(SUM(CASE WHEN ap.type = 'payment' THEN ap.amount ELSE 0 END), 0) as total_paid,
            COALESCE(SUM(CASE WHEN ap.type = 'collection' THEN ap.amount ELSE 0 END), 0) as total_collected
          FROM "AccountPayment" ap
          WHERE ap."date" >= ${monthlyStartDateStr}::date
            AND ap."date" <= ${monthlyEndDateStr}::date
            AND ap."isReversed" = false
            AND ap."vendedorId" IN (${Prisma.join(vendorUuids)})
          GROUP BY ap."vendedorId"
        `),

        // Balances del mes anterior en lote
        getPreviousMonthFinalBalancesBatch(effectiveMonth, "vendedor", allVendorIds, bancaId),

        // Balances mensuales remanentes reales en lote
        getMonthlyRemainingBalancesBatch(effectiveMonth, "vendedor", allVendorIds),

        // Total de sorteos evaluados hoy
        prisma.sorteo.count({
          where: {
            status: SorteoStatus.EVALUATED,
            scheduledAt: {
              gte: todayRange.fromAt,
              lte: todayRange.toAt,
            },
            ...(bancaId ? { bancaId } : {}),
          },
        }),
      ]);

      // Mapear resultados indexados por vendedorId
      const rcdTodayByVendor = new Map<string, (typeof rcdTodayRows)[0]>();
      for (const r of rcdTodayRows) rcdTodayByVendor.set(r.vendedorId, r);

      const rcdMonthByVendor = new Map<string, (typeof rcdMonthRows)[0]>();
      for (const r of rcdMonthRows) rcdMonthByVendor.set(r.vendedorId, r);

      const paymentsMonthByVendor = new Map<string, (typeof paymentsMonthRows)[0]>();
      for (const r of paymentsMonthRows) paymentsMonthByVendor.set(r.vendedorId, r);

      // 5. Construcción de Payloads y Claves de Caché
      const cacheEntries: Array<{
        key: string;
        value: any;
        ttlSeconds: number;
        tags: string[];
        useL1: boolean;
        l1TtlMs: number;
      }> = [];

      for (const vId of allVendorIds) {
        const stmt = statementByVendor.get(vId);
        const rcdToday = rcdTodayByVendor.get(vId);
        const rcdMonth = rcdMonthByVendor.get(vId);
        const payMonth = paymentsMonthByVendor.get(vId);

        const totalSales = stmt ? stmt.totalSales : 0;
        const totalCommission = stmt ? stmt.vendedorCommission : 0;
        const commissionByNumber = Number(rcdToday?.commission_by_number || 0);
        const commissionByReventado = Number(rcdToday?.commission_by_reventado || 0);
        const totalPrizes = stmt ? stmt.totalPayouts : 0;
        const totalTickets = stmt ? stmt.ticketCount : 0;
        const totalPaid = stmt ? stmt.totalPaid : 0;
        const totalCollected = stmt ? stmt.totalCollected : 0;
        const totalBalance = stmt ? stmt.balance : totalSales - totalPrizes - totalCommission;
        const totalRemainingBalance = stmt ? stmt.remainingBalance : totalBalance - totalCollected + totalPaid;
        const totalSubtotal = totalRemainingBalance;
        const accumulated = stmt ? Number(stmt.remainingBalance) || Number(stmt.accumulatedBalance) || 0 : 0;

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
          totalSubtotal,
          accumulated,
        };

        const hasActivityToday =
          totalSales > 0 || totalPrizes > 0 || totalCommission > 0 || totalTickets > 0 || totalPaid > 0 || totalCollected > 0;
        const hasBalance = accumulated !== 0;

        let daysArray: any[] = [];
        if (hasActivityToday || hasBalance) {
          daysArray = [
            {
              date: todayDateStr,
              sorteos: [], // summaryOnly: true -> siempre vacío
              dayTotals,
            },
          ];
        }

        // Respetar balanceResetAt si aplica al vendedor
        const resetAt = vendorResetMap.get(vId);
        let finalDaysArray = daysArray;
        if (resetAt) {
          const resetAtDayStr = crDateService.dateUTCToCRString(resetAt);
          finalDaysArray = daysArray.filter((day) => day.date >= resetAtDayStr);
        }

        const totals = {
          totalSales: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
          totalCommission: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
          commissionByNumber: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
          commissionByReventado: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
          totalPrizes: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
          totalTickets: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
          totalPaid: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
          totalCollected: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
          totalBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0),
          totalRemainingBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
          totalSubtotal: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
        };

        // Métricas de monthlyAccumulated
        const mTotalSales = Number(rcdMonth?.total_sales) || 0;
        const mTotalCommission = Number(rcdMonth?.total_commission) || 0;
        const mCommissionByNumber = Number(rcdMonth?.commission_by_number) || 0;
        const mCommissionByReventado = Number(rcdMonth?.commission_by_reventado) || 0;
        const mTotalPrizes = Number(rcdMonth?.total_prizes) || 0;
        const mTotalTickets = Number(rcdMonth?.total_tickets) || 0;

        const mTotalPaid = Number(payMonth?.total_paid) || 0;
        const mTotalCollected = Number(payMonth?.total_collected) || 0;

        const mTotalBalance = mTotalSales - mTotalPrizes - mTotalCommission;
        const mTotalRemainingBalance = mTotalBalance - mTotalCollected + mTotalPaid;

        const prevBalance = prevMonthBalancesMap.get(vId) || 0;
        const realMonRemaining = realMonthlyRemainingBalancesMap.get(vId) ?? null;

        const finalMonthlyBalance = prevBalance + mTotalBalance;
        const finalMonthlyRemainingBalance =
          realMonRemaining !== null ? realMonRemaining : prevBalance + mTotalRemainingBalance;

        const monthlyAccumulated = {
          totalSales: mTotalSales,
          totalCommission: mTotalCommission,
          commissionByNumber: mCommissionByNumber,
          commissionByReventado: mCommissionByReventado,
          totalPrizes: mTotalPrizes,
          totalTickets: mTotalTickets,
          totalPaid: mTotalPaid,
          totalCollected: mTotalCollected,
          totalBalance: finalMonthlyBalance,
          totalRemainingBalance: finalMonthlyRemainingBalance,
          totalSubtotal: finalMonthlyRemainingBalance,
        };

        const payload = {
          data: finalDaysArray,
          meta: {
            totals,
            monthlyAccumulated,
            dateFilter: "today",
            totalSorteos: Number(rcdToday?.total_sorteos) || totalSorteosEvaluatedToday,
            totalDays: finalDaysArray.length,
          },
        };

        // Construir hash normalizado para summaryOnly: true
        const normalizedKeyData = {
          date: "today",
          fromDate: null,
          toDate: null,
          scope: "mine",
          loteriaId: null,
          isActive: true,
          summaryOnly: true,
          vendedorId: vId,
          ignoreReset: false,
        };

        const hash = crypto.createHash('md5').update(JSON.stringify(normalizedKeyData)).digest('hex');
        const cacheKey = `banca:all:ventana:all:vendedor:${vId}:summary:${hash}`;

        cacheEntries.push({
          key: cacheKey,
          value: payload,
          ttlSeconds: 300, // 5 minutos en Upstash Redis L2
          tags: ['report:summary', `vendedor:${vId}`],
          useL1: true,
          l1TtlMs: 90_000, // 90s en L1 RAM para resiliencia ante ráfagas
        });
      }

      // 6. Inyección masiva y atómica a través de L1 RAM y Pipeline Upstash Redis L2
      await CacheService.setBatch(cacheEntries);

      // Pre-calentamiento selectivo de summaryOnly=false para vendedores con ventas en este sorteo evaluado
      let detailedWarmupCount = 0;
      const targetVendorsWithSales = rcdSorteoVendors
        .map((r) => r.vendedorId)
        .filter((vId): vId is string => Boolean(vId) && allVendorIdsSet.has(vId));

      if (targetVendorsWithSales.length > 0) {
        const detailedTasks = targetVendorsWithSales.map((vId) => async () => {
          try {
            await this.evaluatedSummary(
              {
                date: 'today',
                scope: 'mine',
                isActive: 'true',
                summaryOnly: false,
                userRole: Role.VENDEDOR,
                ignoreReset: false,
                forceRefresh: true,
              },
              vId
            );
            detailedWarmupCount++;
          } catch (err: any) {
            logger.warn({
              layer: 'service',
              action: 'WARMUP_DETAILED_SUMMARY_VENDOR_FAILED',
              payload: { sorteoId, vendedorId: vId, error: err?.message },
            });
          }
        });

        await SharedWarmupPool.runAllSettled(detailedTasks);
      }

      logger.info({
        layer: 'service',
        action: 'WARMUP_BATCH_COMPLETED',
        payload: {
          sorteoId,
          bancaId,
          totalVendors: allVendorIds.length,
          entriesCached: cacheEntries.length + detailedWarmupCount,
          detailedWarmupCount,
          durationMs: Date.now() - startTime,
        },
      });

      return {
        totalVendors: allVendorIds.length,
        entriesCached: cacheEntries.length + detailedWarmupCount,
      };
    } finally {
      // 7. Liberación obligatoria del candado distribuido
      if (lockAcquired && redis) {
        await redis.del(lockKey).catch(() => {});
      }
    }
  },

  /**
   * Pre-calienta el caché de evaluated-summary para los vendedores de la banca
   * justo después de que un sorteo se evalúa y liquida contablemente.
   * Ejecuta primero el batch O(1) masivo, con fallback transparente a SharedWarmupPool.
   */
  async warmupEvaluatedSummaries(
    sorteoId: string,
    bancaId?: string | null
  ): Promise<{ totalVendors: number; entriesCached: number }> {
    try {
      // 1. Camino primario: Batch Aggregation O(1) con Distributed Lock y MSET/Pipeline
      const batchRes = await this.warmupSorteoSummariesBatch(sorteoId, bancaId);
      return batchRes || { totalVendors: 0, entriesCached: 0 };
    } catch (batchErr: any) {
      logger.warn({
        layer: 'service',
        action: 'WARMUP_BATCH_FAILED_FALLBACK_POOL',
        payload: { sorteoId, bancaId, error: batchErr?.message || String(batchErr) },
      });
    }

    // 2. Fallback de seguridad: pool global con límite estricto de concurrencia
    try {
      let vendorIds: string[] = [];

      if (bancaId) {
        const users = await prisma.user.findMany({
          where: {
            role: Role.VENDEDOR,
            isActive: true,
            ventana: { bancaId },
          },
          select: { id: true },
        });
        vendorIds = users.map((u) => u.id);
      } else {
        const users = await prisma.user.findMany({
          where: {
            role: Role.VENDEDOR,
            isActive: true,
          },
          select: { id: true },
        });
        vendorIds = users.map((u) => u.id);
      }

      if (vendorIds.length === 0) {
        const rcdVendors = await prisma.resumenCierreDiario.findMany({
          where: { sorteoId },
          select: { vendedorId: true },
          distinct: ['vendedorId'],
        });
        vendorIds = rcdVendors.map((r) => r.vendedorId);
      }

      if (vendorIds.length === 0) {
        logger.info({
          layer: 'service',
          action: 'WARMUP_SKIPPED_NO_VENDORS',
          payload: { sorteoId, bancaId },
        });
        return { totalVendors: 0, entriesCached: 0 };
      }

      logger.info({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_FALLBACK_START',
        payload: { sorteoId, bancaId, totalVendors: vendorIds.length },
      });

      const startTime = Date.now();

      const warmupTasks = vendorIds.map((vId) => () =>
        this.evaluatedSummary(
          {
            date: 'today',
            scope: 'mine',
            status: 'EVALUATED,OPEN',
            isActive: 'true',
            summaryOnly: true,
            userRole: Role.VENDEDOR,
            ignoreReset: false,
            forceRefresh: true,
          },
          vId
        )
      );

      await SharedWarmupPool.runAllSettled(warmupTasks);

      logger.info({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_FALLBACK_COMPLETED',
        payload: {
          sorteoId,
          bancaId,
          totalVendors: vendorIds.length,
          durationMs: Date.now() - startTime,
        },
      });

      return { totalVendors: vendorIds.length, entriesCached: vendorIds.length };
    } catch (err: any) {
      logger.warn({
        layer: 'service',
        action: 'WARMUP_EVALUATED_SUMMARY_ERROR',
        payload: { sorteoId, bancaId, error: err?.message || String(err) },
      });
      return { totalVendors: 0, entriesCached: 0 };
    }
  },
};

export default SorteoService;
