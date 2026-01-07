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

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      scheduledAt: formatDateCRWithTZ(normalizeDateCR(data.scheduledAt, 'scheduledAt')), //  Normalizar y formatear con timezone
      digits: finalDigits,
      digitsSource: data.digits ? 'explicit' : 'inherited',
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
    const existing = await SorteoRepository.findById(id);
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

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return serializeSorteo(s);
  },

  /**
   * Activa o desactiva un sorteo sin importar su estado
   * Útil para activar sorteos que están en CLOSED o EVALUATED
   */
  async setActive(id: string, isActive: boolean, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const s = await SorteoRepository.update(id, {
      isActive,
    } as UpdateSorteoDTO);

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: { isActive, previousIsActive: (existing as any).isActive },
    });

    return serializeSorteo(s);
  },

  /**
   * Fuerza el cambio de estado a OPEN desde cualquier estado (excepto EVALUATED)
   * Útil para reabrir sorteos que están en CLOSED
   */
  async forceOpen(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status === SorteoStatus.EVALUATED) {
      throw new AppError("No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.", 409);
    }

    const s = await SorteoRepository.forceOpen(id);

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
      forced: true,
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

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details,
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
      },
    });

    return serializeSorteo(s);
  },

  async open(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
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

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.OPEN,
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
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.OPEN && existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede cerrar desde OPEN o EVALUATED", 409);
    }

    //  NUEVA: Usar closeWithCascade() para marcar tickets también
    const { sorteo: s, ticketsAffected } = await SorteoRepository.closeWithCascade(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.CLOSED,
      ticketsClosed: ticketsAffected,  //  NUEVO: Registrar cuántos tickets se marcaron
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
    const existing = await SorteoRepository.findById(id);
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

    // 3) Transacción
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

      // 3.2 Pagar NUMERO
      // IMPORTANTE: Excluir tickets CANCELLED y solo jugadas activas
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: {
            sorteoId: id,
            status: { not: "CANCELLED" }, // Excluir tickets cancelados
            isActive: true, // Solo tickets activos
            deletedAt: null, // Solo tickets no eliminados
            id: { notIn: Array.from(excludedTicketIds) }, //  NUEVO: Excluir tickets de listas bloqueadas
          },
          type: "NUMERO",
          number: winningNumber,
          isActive: true,
        },
        select: {
          id: true,
          amount: true,
          finalMultiplierX: true,
          ticketId: true,
        },
      });

      for (const j of numeroWinners) {
        const payout = j.amount * j.finalMultiplierX;
        await tx.jugada.update({
          where: { id: j.id },
          data: { isWinner: true, payout },
        });
      }

      // 3.3 Pagar REVENTADO (y asignar multiplierId)
      // Solo paga si extraX > 0 (es decir, si salió multiplicador extra)
      let reventadoWinners: { id: string; amount: number; ticketId: string }[] = [];

      if (extraX > 0) {
        // IMPORTANTE: Excluir tickets CANCELLED y solo jugadas activas
        reventadoWinners = await tx.jugada.findMany({
          where: {
            ticket: {
              sorteoId: id,
              status: { not: "CANCELLED" }, // Excluir tickets cancelados
              isActive: true, // Solo tickets activos
              deletedAt: null, // Solo tickets no eliminados
              id: { notIn: Array.from(excludedTicketIds) }, //  NUEVO: Excluir tickets de listas bloqueadas
            },
            type: "REVENTADO",
            reventadoNumber: winningNumber,
            isActive: true,
          },
          select: { id: true, amount: true, ticketId: true },
        });

        for (const j of reventadoWinners) {
          const payout = j.amount * extraX;
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              finalMultiplierX: extraX, // snapshot a la jugada
              payout,
              ...(extraMultiplierId
                ? { multiplier: { connect: { id: extraMultiplierId } } }
                : {}),
            },
          });
        }
      }

      // 3.4 Marcar tickets y calcular totalPayout para ganadores
      const winningTicketIds = new Set<string>([
        ...numeroWinners.map((j) => j.ticketId),
        ...reventadoWinners.map((j) => j.ticketId),
      ]);

      // IMPORTANTE: Solo evaluar tickets activos y no cancelados
      const tickets = await tx.ticket.findMany({
        where: {
          sorteoId: id,
          status: { not: "CANCELLED" }, // Excluir tickets cancelados
          isActive: true, // Solo tickets activos
          deletedAt: null, // Solo tickets no eliminados
          id: { notIn: Array.from(excludedTicketIds) }, //  NUEVO: Excluir tickets de listas bloqueadas
        },
        select: { id: true },
      });

      let winners = 0;
      for (const t of tickets) {
        const tIsWinner = winningTicketIds.has(t.id);
        if (tIsWinner) winners++;

        // Si es ganador, calcular totalPayout sumando jugadas ganadoras
        let totalPayout = 0;
        let remainingAmount = 0;
        if (tIsWinner) {
          const winningJugadas = await tx.jugada.aggregate({
            where: { ticketId: t.id, isWinner: true },
            _sum: { payout: true },
          });
          totalPayout = winningJugadas._sum.payout || 0;
          remainingAmount = totalPayout; // Inicialmente todo pendiente
        }

        await tx.ticket.update({
          where: { id: t.id },
          data: {
            status: "EVALUATED",
            isWinner: tIsWinner,
            ...(tIsWinner ? {
              totalPayout,
              totalPaid: 0,
              remainingAmount,
            } : {}),
          },
        });
      }

      await tx.sorteo.update({
        where: { id },
        data: {
          hasWinner: winningTicketIds.size > 0,
        },
      });

      // 3.5 Auditoría
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
            winners,
          },
        },
      });

      return { winners, extraMultiplierX: extraX };
    });

    // 4) Log adicional
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
      },
    });

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    //  CRÍTICO: Sincronizar AccountStatement de todos los días afectados cuando se evalúa un sorteo
    // La evaluación marca jugadas como ganadoras, afectando totalPayouts del statement
    // Los sorteos se evalúan conforme van sucediendo, y es ahí cuando los tickets se toman en cuenta
    // ️ IMPORTANTE: Usar el nuevo servicio de sincronización que actualiza accumulatedBalance
    try {
      const { AccountStatementSyncService } = await import('./accounts/accounts.sync.service');
      
      // ️ CRÍTICO: Convertir scheduledAt a fecha CR antes de sincronizar
      // existing.scheduledAt está en UTC, convertirlo a fecha CR
      const { crDateService } = await import('../../../utils/crDateService');
      const sorteoDateCR = crDateService.dateUTCToCRString(existing.scheduledAt);
      const [year, month, day] = sorteoDateCR.split('-').map(Number);
      // Crear Date UTC que representa el día calendario en CR
      const sorteoDateUTC = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      
      // Sincronizar todos los statements afectados por el sorteo
      // Esto actualizará accumulatedBalance progresivo para todas las dimensiones afectadas
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
      logger.error({
        layer: 'service',
        action: 'ACCOUNT_STATEMENT_SYNC_ERROR_ON_SORTEO_EVALUATE',
        payload: {
          error: (err as Error).message,
          sorteoId: id,
        }
      });
      // No relanzar - no debe romper la evaluación del sorteo
    }

    // 5) Obtener sorteo evaluado para devolver
    const evaluated = await SorteoRepository.findById(id);
    return evaluated ? serializeSorteo(evaluated) : evaluated;
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
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.EVALUATED) {
      throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
    }

    const reverted = await SorteoRepository.revertEvaluation(id);

    // Invalidar cache de sorteos
    const { clearSorteoCache } = require('../../../utils/sorteoCache');
    clearSorteoCache();

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_REOPEN,
      targetType: "SORTEO",
      targetId: id,
      details: {
        reason: reason ?? null,
        previousWinningNumber: existing.winningNumber,
        previousExtraMultiplierId: existing.extraMultiplierId,
      },
    });

    return serializeSorteo(reverted);
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
   *  Helper: Obtener política de comisiones (USER → VENTANA fallback)
   */
  async getCommissionPolicy(userId: string, ventanaId: string | null | undefined): Promise<CommissionPolicy | null> {
    if (!ventanaId) {
      return null;
    }

    // Obtener políticas en paralelo
    const [user, ventana] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { commissionPolicyJson: true },
      }),
      prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { commissionPolicyJson: true },
      }),
    ]);

    // Prioridad: USER → VENTANA
    const policyJson = user?.commissionPolicyJson ?? ventana?.commissionPolicyJson ?? null;
    if (!policyJson) {
      return null;
    }

    return parseCommissionPolicy(policyJson, user?.commissionPolicyJson ? 'USER' : 'VENTANA');
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
    // Si la lotería no tiene multiplicadores activos, siempre mostrar
    if (!activeMultipliers || activeMultipliers.length === 0) {
      return true;
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

    // Si no hay política, ocultar todos los sorteos con multiplicadores activos
    if (!commissionPolicy) {
      const sorteosWithoutMultipliers: Array<{ id: string; loteriaId: string }> = [];

      for (const sorteo of sorteos) {
        const multipliers = await this.getActiveMultipliers(sorteo.loteriaId);
        // Solo mostrar si no tiene multiplicadores activos
        if (multipliers.length === 0) {
          sorteosWithoutMultipliers.push(sorteo);
        } else {
          logger.debug({
            layer: "service",
            action: "SORTEO_FILTERED_NO_POLICY",
            payload: {
              sorteoId: sorteo.id,
              loteriaId: sorteo.loteriaId,
              userId,
              reason: "NO_COMMISSION_POLICY",
            },
          });
        }
      }

      return {
        filteredSorteos: sorteosWithoutMultipliers,
        filteredTotal: sorteosWithoutMultipliers.length,
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
    },
    vendedorId: string
  ) {
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

      // Construir filtro para sorteos EVALUATED y/o OPEN
      const sorteoWhere: Prisma.SorteoWhereInput = {
        status: {
          in: allowedStatuses,
        },
        scheduledAt: {
          gte: dateRange.fromAt,
          lte: dateRange.toAt,
        },
        ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        // Solo sorteos donde el vendedor tiene tickets (aplicar filtro de isActive)
        tickets: {
          some: {
            vendedorId,
            deletedAt: null,
            isActive: ticketIsActive,
          },
        },
      };

      // Obtener sorteos (EVALUATED y/o OPEN) ordenados por scheduledAt ASC (más antiguo primero)
      // para calcular el acumulado correctamente del más antiguo hacia el más reciente
      const sorteos = await prisma.sorteo.findMany({
        where: sorteoWhere,
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: [
          { scheduledAt: "asc" }, // ASC para calcular acumulado del más antiguo al más reciente
          { loteriaId: "asc" }, // Orden secundario por loteriaId para consistencia cuando hay misma hora
          { id: "asc" }, // Orden terciario por ID para garantizar orden consistente
        ],
      });

      // Obtener datos financieros agregados por sorteo
      const sorteoIds = sorteos.map((s) => s.id);

      // Obtener todas las jugadas con sus multiplicadores para el desglose
      // El multiplicador está en Jugada, no en Ticket
      const jugadas = await prisma.jugada.findMany({
        where: {
          ticket: {
            sorteoId: { in: sorteoIds },
            vendedorId,
            deletedAt: null,
            isActive: ticketIsActive,
          },
          deletedAt: null,
        },
        select: {
          id: true,
          ticketId: true,
          ticket: {
            select: {
              id: true,
              sorteoId: true,
              totalAmount: true,
              totalCommission: true,
              totalPayout: true,
              isWinner: true,
              status: true,
            },
          },
          multiplierId: true,
          multiplier: {
            select: {
              id: true,
              name: true,
              valueX: true,
            },
          },
          amount: true,
          commissionAmount: true,
          payout: true,
          isWinner: true,
          type: true, //  NUEVO: Tipo de jugada (NUMERO o REVENTADO) para desglose de comisión
        },
      });

      // Log de depuración
      logger.info({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_JUGADAS_DEBUG",
        payload: {
          vendedorId,
          sorteoIdsCount: sorteoIds.length,
          jugadasFound: jugadas.length,
          message: "Jugadas encontradas para los sorteos",
        },
      });

      // Agregar datos financieros por sorteo (todos los tickets)
      const financialData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          deletedAt: null,
          isActive: ticketIsActive,
        },
        _sum: {
          totalAmount: true,
          totalCommission: true,
          totalPayout: true,
        },
        _count: {
          id: true,
        },
      });

      // Obtener premios ganados solo de tickets ganadores
      const prizesData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          isWinner: true,
          deletedAt: null,
          isActive: ticketIsActive,
        },
        _sum: {
          totalPayout: true,
        },
      });

      // Obtener conteos de tickets ganadores y pagados
      const winningTicketsData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          isWinner: true,
          deletedAt: null,
          isActive: ticketIsActive,
        },
        _count: {
          id: true,
        },
      });

      // Para tickets pagados, siempre mostrar los que tengan status PAID o PAGADO
      const paidStatusFilter: Prisma.EnumTicketStatusFilter = {
        in: [TicketStatus.PAID, TicketStatus.PAGADO]
      };

      const paidTicketsData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: sorteoIds },
          vendedorId,
          status: paidStatusFilter,
          deletedAt: null,
        },
        _count: {
          id: true,
        },
      });

      // Crear mapas para acceso rápido
      const prizesMap = new Map(
        prizesData.map((p) => [p.sorteoId, p._sum.totalPayout || 0])
      );

      const financialMap = new Map(
        financialData.map((f) => [
          f.sorteoId,
          {
            totalSales: f._sum.totalAmount || 0,
            totalCommission: f._sum.totalCommission || 0,
            totalPrizes: prizesMap.get(f.sorteoId) || 0, // Usar premios solo de tickets ganadores
            ticketCount: f._count.id,
          },
        ])
      );

      const winningMap = new Map(
        winningTicketsData.map((w) => [w.sorteoId, w._count.id])
      );

      const paidMap = new Map(
        paidTicketsData.map((p) => [p.sorteoId, p._count.id])
      );

      // Agrupar jugadas por sorteo y multiplicador para el desglose
      // Un ticket puede tener múltiples jugadas con diferentes multiplicadores
      type JugadaWithMultiplier = typeof jugadas[0];
      const jugadasBySorteoAndMultiplier = new Map<string, Map<string | null, JugadaWithMultiplier[]>>();

      for (const jugada of jugadas) {
        const sorteoId = jugada.ticket.sorteoId;
        const multiplierId = jugada.multiplierId || null;

        if (!jugadasBySorteoAndMultiplier.has(sorteoId)) {
          jugadasBySorteoAndMultiplier.set(sorteoId, new Map());
        }

        const multiplierMap = jugadasBySorteoAndMultiplier.get(sorteoId)!;
        if (!multiplierMap.has(multiplierId)) {
          multiplierMap.set(multiplierId, []);
        }

        multiplierMap.get(multiplierId)!.push(jugada);
      }

      // Crear un mapa de tickets únicos por sorteo para contar tickets por multiplicador
      const ticketsBySorteo = new Map<string, Set<string>>();
      for (const jugada of jugadas) {
        const sorteoId = jugada.ticket.sorteoId;
        const ticketId = jugada.ticketId;
        if (!ticketsBySorteo.has(sorteoId)) {
          ticketsBySorteo.set(sorteoId, new Set());
        }
        ticketsBySorteo.get(sorteoId)!.add(ticketId);
      }

      //  PASO 1: Obtener movimientos de pago/cobro del vendedor ANTES de calcular accumulated
      const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        dateRange.fromAt,
        dateRange.toAt,
        "vendedor",
        undefined,
        vendedorId
      );

      //  PASO 2: Construir datos de sorteos SIN calcular accumulated aún
      const sorteoData = sorteos.map((sorteo, index) => {
        const financial = financialMap.get(sorteo.id) || {
          totalSales: 0,
          totalCommission: 0,
          totalPrizes: 0,
          ticketCount: 0,
        };

        // Calcular isReventado
        const isReventado =
          (sorteo.extraMultiplierId !== null &&
            sorteo.extraMultiplierId !== undefined) ||
          (sorteo.extraMultiplierX !== null &&
            sorteo.extraMultiplierX !== undefined &&
            sorteo.extraMultiplierX > 0);

        // Calcular subtotal
        const subtotal =
          financial.totalSales -
          financial.totalCommission -
          financial.totalPrizes;

        const winningCount = winningMap.get(sorteo.id) || 0;
        const paidCount = paidMap.get(sorteo.id) || 0;
        const unpaidCount = winningCount - paidCount;

        //  NUEVO: Calcular comisiones por tipo (NUMERO vs REVENTADO) a nivel de sorteo
        const jugadasDelSorteo = jugadas.filter(j => j.ticket.sorteoId === sorteo.id);
        const commissionByNumber = jugadasDelSorteo
          .filter(j => j.type === 'NUMERO')
          .reduce((sum, j) => sum + (j.commissionAmount || 0), 0);
        const commissionByReventado = jugadasDelSorteo
          .filter(j => j.type === 'REVENTADO')
          .reduce((sum, j) => sum + (j.commissionAmount || 0), 0);

        // Calcular desglose por multiplicador
        // Agrupar por jugadas (no tickets) porque un ticket puede tener múltiples multiplicadores
        const multiplierMap = jugadasBySorteoAndMultiplier.get(sorteo.id) || new Map();
        const byMultiplier: Array<{
          multiplierId: string | null;
          multiplierName: string;
          multiplierValue: number;
          totalSales: number;
          totalCommission: number;
          commissionByNumber: number; //  NUEVO
          commissionByReventado: number; //  NUEVO
          totalPrizes: number;
          ticketCount: number;
          subtotal: number;
          winningTicketsCount: number;
          paidTicketsCount: number;
          unpaidTicketsCount: number;
        }> = [];

        for (const [multiplierId, jugadasGroup] of multiplierMap.entries()) {
          const multiplier = jugadasGroup[0]?.multiplier;

          // Calcular totales por multiplicador (suma de jugadas)
          const multTotalSales = jugadasGroup.reduce((sum: number, j: JugadaWithMultiplier) => sum + (j.amount || 0), 0);
          const multTotalCommission = jugadasGroup.reduce((sum: number, j: JugadaWithMultiplier) => sum + (j.commissionAmount || 0), 0);

          //  NUEVO: Calcular comisiones por tipo a nivel de multiplicador
          const multCommissionByNumber = jugadasGroup
            .filter((j: JugadaWithMultiplier) => j.type === 'NUMERO')
            .reduce((sum: number, j: JugadaWithMultiplier) => sum + (j.commissionAmount || 0), 0);
          const multCommissionByReventado = jugadasGroup
            .filter((j: JugadaWithMultiplier) => j.type === 'REVENTADO')
            .reduce((sum: number, j: JugadaWithMultiplier) => sum + (j.commissionAmount || 0), 0);

          const multTotalPrizes = jugadasGroup
            .filter((j: JugadaWithMultiplier) => j.isWinner)
            .reduce((sum: number, j: JugadaWithMultiplier) => sum + (j.payout || 0), 0);

          // Contar tickets únicos con este multiplicador en este sorteo
          const ticketIdsWithThisMultiplier = new Set(jugadasGroup.map((j: JugadaWithMultiplier) => j.ticketId));
          const multTicketCount = ticketIdsWithThisMultiplier.size;

          const multSubtotal = multTotalSales - multTotalCommission - multTotalPrizes;

          // Contar tickets ganadores y pagados con este multiplicador
          const winningTicketIds = new Set(
            jugadasGroup
              .filter((j: JugadaWithMultiplier) => j.isWinner)
              .map((j: JugadaWithMultiplier) => j.ticketId)
          );
          const multWinningCount = winningTicketIds.size;

          // Obtener tickets pagados (necesitamos verificar el status del ticket)
          const paidTicketIds = new Set(
            jugadasGroup
              .filter((j: JugadaWithMultiplier) =>
                j.ticket.status === TicketStatus.PAID || j.ticket.status === TicketStatus.PAGADO
              )
              .map((j: JugadaWithMultiplier) => j.ticketId)
          );
          const multPaidCount = paidTicketIds.size;
          const multUnpaidCount = multWinningCount - multPaidCount;

          // Determinar información del multiplicador
          let multiplierName = "Sin multiplicador";
          let multiplierValue = 1;

          if (multiplier) {
            multiplierName = multiplier.name || `x${multiplier.valueX} `;
            multiplierValue = multiplier.valueX || 1;
          } else if (multiplierId) {
            // Si hay multiplierId pero no hay relación cargada, usar valores por defecto
            multiplierName = "x1";
            multiplierValue = 1;
          }

          byMultiplier.push({
            multiplierId,
            multiplierName,
            multiplierValue,
            totalSales: multTotalSales,
            totalCommission: multTotalCommission,
            commissionByNumber: multCommissionByNumber, //  NUEVO
            commissionByReventado: multCommissionByReventado, //  NUEVO
            totalPrizes: multTotalPrizes,
            ticketCount: multTicketCount,
            subtotal: multSubtotal,
            winningTicketsCount: multWinningCount,
            paidTicketsCount: multPaidCount,
            unpaidTicketsCount: multUnpaidCount,
          });
        }

        // Ordenar multiplicadores por multiplierValue ascendente (menor a mayor)
        byMultiplier.sort((a, b) => a.multiplierValue - b.multiplierValue);

        return {
          sorteoId: sorteo.id,
          sorteoName: sorteo.name,
          scheduledAt: sorteo.scheduledAt, // Guardar Date para ordenar después
          date: formatDateOnly(sorteo.scheduledAt),
          time: formatTime12h(sorteo.scheduledAt),
          loteriaId: sorteo.loteriaId,
          loteriaName: sorteo.loteria?.name || "Desconocida",
          winningNumber: sorteo.winningNumber,
          isReventado,
          totalSales: financial.totalSales,
          totalCommission: financial.totalCommission,
          commissionByNumber, //  NUEVO: Comisión por jugadas tipo NÚMERO
          commissionByReventado, //  NUEVO: Comisión por jugadas tipo REVENTADO
          totalPrizes: financial.totalPrizes,
          ticketCount: financial.ticketCount,
          subtotal,
          accumulated: 0, // Se calculará después junto con movimientos
          chronologicalIndex: index + 1, // Índice cronológico: 1 = más antiguo, n = más reciente
          totalChronological: sorteos.length, // Total de sorteos para referencia del FE
          winningTicketsCount: winningCount,
          paidTicketsCount: paidCount,
          unpaidTicketsCount: unpaidCount,
          byMultiplier, //  NUEVO: Desglose por multiplicador
        };
      });

      //  PASO 3: Convertir movimientos a items con la misma estructura que sorteos
      const movementItems: any[] = [];
      for (const [dateStr, movements] of movementsByDate.entries()) {
        for (const movement of movements) {
          if (!movement.isReversed) {
            // Combinar: fecha del usuario + hora de createdAt (en hora CR)
            const createdAtDate = new Date(movement.createdAt);
            // Convertir UTC a CR (UTC-6)
            const crTime = new Date(createdAtDate.getTime() - (6 * 60 * 60 * 1000));
            const hour = crTime.getUTCHours();
            const minute = crTime.getUTCMinutes();
            const seconds = crTime.getUTCSeconds();
            const [year, month, day] = movement.date.split('-').map(Number);
            const scheduledAt = new Date(year, month - 1, day, hour, minute, seconds);

            movementItems.push({
              sorteoId: `mov-${movement.id}`,
              sorteoName: movement.type === 'payment' ? 'Pago recibido' : 'Cobro realizado',
              scheduledAt, //  Fecha del usuario + hora de creación
              date: movement.date, //  Fecha que el usuario indicó
              time: formatTime12h(scheduledAt),
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
              subtotal: movement.type === 'payment' ? (movement.amount || 0) : -(movement.amount || 0),
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
              method: movement.method,
              notes: movement.notes,
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

      //  PASO 5: Calcular acumulado y chronologicalIndex por evento (sorteo/movimiento)
      let eventAccumulated = 0;
      const totalEvents = allEvents.length;
      const dataWithAccumulated = allEvents.map((event, index) => {
        eventAccumulated += event.subtotal;
        return {
          ...event,
          accumulated: eventAccumulated,
          chronologicalIndex: index + 1, // 1 = más antiguo, n = más reciente
          totalChronological: totalEvents,
        };
      });

      //  NUEVO: Calcular rango de fechas para monthlyAccumulated (desde inicio del mes hasta hoy)
      const today = new Date();
      const monthlyStartDate = new Date(today.getFullYear(), today.getMonth(), 1);
      //  FIX: monthlyEndDate debe ser el FINAL del día de hoy (23:59:59.999)
      // para incluir sorteos programados más tarde en el día actual
      const monthlyEndDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

      //  NUEVO: Obtener movimientos del mes completo para monthlyAccumulated
      const monthlyMovementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
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
          const totalPaid = movimientosDelDia
            .filter((m: any) => m.type === "payment")
            .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
          const totalCollected = movimientosDelDia
            .filter((m: any) => m.type === "collection")
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

      //  CRÍTICO: Calcular acumulado histórico por día basado en totalRemainingBalance
      // Ordenar días ASC para calcular acumulado progresivo
      const daysSortedAsc = [...daysArray].sort((a, b) => a.date.localeCompare(b.date));

      let dailyAccumulated = 0;
      for (const day of daysSortedAsc) {
        // Sumar el subtotal del día (que incluye sorteos + movimientos)
        dailyAccumulated += (day.dayTotals.totalRemainingBalance || 0);

        // Actualizar el accumulated en el día original
        const originalDay = daysArray.find(d => d.date === day.date);
        if (originalDay) {
          originalDay.dayTotals.accumulated = dailyAccumulated;
        }
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

      //  NUEVO: Calcular monthlyAccumulated (acumulado del mes completo hasta hoy)
      // Obtener todos los sorteos evaluados del mes completo
      const monthlySorteoWhere: Prisma.SorteoWhereInput = {
        status: {
          in: allowedStatuses,
        },
        scheduledAt: {
          gte: monthlyStartDate,
          lte: monthlyEndDate,
        },
        ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        tickets: {
          some: {
            vendedorId,
            deletedAt: null,
            isActive: ticketIsActive,
          },
        },
      };

      const monthlySorteos = await prisma.sorteo.findMany({
        where: monthlySorteoWhere,
        select: {
          id: true,
        },
      });

      const monthlySorteoIds = monthlySorteos.map((s) => s.id);

      // Obtener datos financieros del mes completo
      const monthlyFinancialData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: monthlySorteoIds },
          vendedorId,
          deletedAt: null,
          isActive: ticketIsActive,
        },
        _sum: {
          totalAmount: true,
          totalCommission: true,
          totalPayout: true,
        },
        _count: {
          id: true,
        },
      });

      const monthlyPrizesData = await prisma.ticket.groupBy({
        by: ["sorteoId"],
        where: {
          sorteoId: { in: monthlySorteoIds },
          vendedorId,
          isWinner: true,
          deletedAt: null,
          isActive: ticketIsActive,
        },
        _sum: {
          totalPayout: true,
        },
      });

      // Calcular totales del mes completo
      const monthlyTotalSales = monthlyFinancialData.reduce((sum, f) => sum + (f._sum.totalAmount || 0), 0);
      const monthlyTotalCommission = monthlyFinancialData.reduce((sum, f) => sum + (f._sum.totalCommission || 0), 0);
      const monthlyTotalPrizes = monthlyPrizesData.reduce((sum, p) => sum + (p._sum.totalPayout || 0), 0);
      const monthlyTotalTickets = monthlyFinancialData.reduce((sum, f) => sum + f._count.id, 0);

      //  NUEVO: Calcular totalPaid y totalCollected del mes completo desde movimientos
      let monthlyTotalPaid = 0;
      let monthlyTotalCollected = 0;
      for (const movements of monthlyMovementsByDate.values()) {
        monthlyTotalPaid += movements
          .filter((m: any) => m.type === "payment" && !m.isReversed)
          .reduce((sum: number, m: any) => sum + m.amount, 0);
        monthlyTotalCollected += movements
          .filter((m: any) => m.type === "collection" && !m.isReversed)
          .reduce((sum: number, m: any) => sum + m.amount, 0);
      }

      //  NUEVO: Calcular comisiones por tipo del mes completo
      const monthlyJugadas = await prisma.jugada.findMany({
        where: {
          ticket: {
            sorteoId: { in: monthlySorteoIds },
            vendedorId,
            deletedAt: null,
            isActive: ticketIsActive,
          },
          deletedAt: null,
        },
        select: {
          commissionAmount: true,
          type: true,
        },
      });

      const monthlyCommissionByNumber = monthlyJugadas
        .filter((j) => j.type === "NUMERO")
        .reduce((sum, j) => sum + (j.commissionAmount || 0), 0);
      const monthlyCommissionByReventado = monthlyJugadas
        .filter((j) => j.type === "REVENTADO")
        .reduce((sum, j) => sum + (j.commissionAmount || 0), 0);

      // Calcular balance y remainingBalance del mes completo
      const monthlyTotalBalance = monthlyTotalSales - monthlyTotalPrizes - monthlyTotalCommission;
      const monthlyTotalRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

      //  NUEVO: Obtener saldo final del mes anterior para este vendedor
      const effectiveMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const previousMonthBalance = await getPreviousMonthFinalBalance(
        effectiveMonth,
        "vendedor",
        undefined,
        vendedorId,
        undefined
      );

      // Sumar saldo del mes anterior al acumulado del mes actual
      const monthlyAccumulated = {
        totalSales: monthlyTotalSales,
        totalCommission: monthlyTotalCommission,
        commissionByNumber: monthlyCommissionByNumber,
        commissionByReventado: monthlyCommissionByReventado,
        totalPrizes: monthlyTotalPrizes,
        totalTickets: monthlyTotalTickets,
        totalPaid: monthlyTotalPaid,
        totalCollected: monthlyTotalCollected,
        totalBalance: previousMonthBalance + monthlyTotalBalance,
        totalRemainingBalance: previousMonthBalance + monthlyTotalRemainingBalance,
        totalSubtotal: previousMonthBalance + monthlyTotalRemainingBalance, //  DEPRECATED: igual a totalRemainingBalance
      };
      const result = {
        data: daysArray,
        meta: {
          totals,
          monthlyAccumulated, //  NUEVO: Acumulado del mes completo
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalSorteos: sorteos.length,
          totalDays: daysArray.length,
        },
      };

      // Log de depuración final
      logger.info({
        layer: "service",
        action: "SORTEO_EVALUATED_SUMMARY_RESULT",
        payload: {
          vendedorId,
          totalSorteos: sorteos.length,
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
  },
};

export default SorteoService;
