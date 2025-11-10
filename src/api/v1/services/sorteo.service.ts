// src/modules/sorteos/services/sorteo.service.ts
import { ActivityType, Prisma, SorteoStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import {
  CreateSorteoDTO,
  EvaluateSorteoDTO,
  UpdateSorteoDTO,
} from "../dto/sorteo.dto";
import { formatIsoLocal } from "../../../utils/datetime";

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

function serializeSorteo<T extends { scheduledAt?: Date | null; loteria?: any }>(sorteo: T) {
  if (!sorteo) return sorteo;
  const reventadoEnabled = extractReventadoEnabled(sorteo.loteria);
  const serialized = {
    ...sorteo,
    scheduledAt: sorteo.scheduledAt ? formatIsoLocal(sorteo.scheduledAt) : null,
    reventadoEnabled,
  };
  if (sorteo.loteria) {
    (serialized as any).loteria = sanitizeLoteria(sorteo.loteria);
  }
  return serialized;
}

function serializeSorteos<T extends { scheduledAt?: Date | null }>(sorteos: T[]) {
  return sorteos.map((s) => serializeSorteo(s));
}

export const SorteoService = {
  async create(data: CreateSorteoDTO, userId: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { id: true, isActive: true },
    });
    if (!loteria || !loteria.isActive)
      throw new AppError("Lotería no encontrada", 404);

    const s = await SorteoRepository.create(data);

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      scheduledAt: (data.scheduledAt instanceof Date
        ? data.scheduledAt
        : new Date(data.scheduledAt)
      ).toISOString(),
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
      isActive: data.isActive,
    } as UpdateSorteoDTO);

    const details: Record<string, any> = {};
    if (data.name && data.name !== existing.name) details.name = data.name;
    if (data.loteriaId && data.loteriaId !== existing.loteriaId) details.loteriaId = data.loteriaId;
    if (data.scheduledAt) {
      details.scheduledAt = (
        data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt)
      ).toISOString();
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

  async open(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (existing.status !== SorteoStatus.SCHEDULED) {
      throw new AppError("Solo se puede abrir desde SCHEDULED", 409);
    }

    const s = await SorteoRepository.open(id);

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
    if (existing.status !== SorteoStatus.OPEN) {
      throw new AppError("Solo se puede cerrar desde OPEN", 409);
    }

    const s = await SorteoRepository.close(id);

    const details: Prisma.InputJsonObject = {
      from: existing.status,
      to: SorteoStatus.CLOSED,
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

    // 2) Resolver multiplicador extra (si viene) y etiqueta neutra
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
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: { sorteoId: id },
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
        reventadoWinners = await tx.jugada.findMany({
          where: {
            ticket: { sorteoId: id },
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

      const tickets = await tx.ticket.findMany({
        where: { sorteoId: id },
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

    // 5) Devolver sorteo evaluado (con include para mantener reventadoEnabled)
    const evaluated = await SorteoRepository.findById(id);
    return evaluated ? serializeSorteo(evaluated) : evaluated;
  },

  async remove(id: string, userId: string, reason?: string) {
    const s = await SorteoRepository.softDelete(id, userId, reason);

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

  async list(params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
  }) {
    const p = params.page && params.page > 0 ? params.page : 1;
    const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

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

    const totalPages = Math.ceil(total / ps);
    return {
      data: serializeSorteos(data),
      meta: {
        total,
        page: p,
        pageSize: ps,
        totalPages,
        hasNextPage: p < totalPages,
        hasPrevPage: p > 1,
      },
    };
  },

  async findById(id: string) {
    const sorteo = await SorteoRepository.findById(id);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return serializeSorteo(sorteo);
  },
};

export default SorteoService;
