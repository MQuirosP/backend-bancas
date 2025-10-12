import {
  ActivityType,
  Prisma,
  SorteoStatus,
  TicketStatus,
} from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import {
  CreateSorteoDTO,
  EvaluateSorteoDTO,
  UpdateSorteoDTO,
} from "../dto/sorteo.dto";

const FINAL_STATES: Set<SorteoStatus> = new Set([
  SorteoStatus.EVALUATED,
  SorteoStatus.CLOSED,
]);

const EVALUABLE_STATES = new Set<SorteoStatus>([SorteoStatus.OPEN]);

export const SorteoService = {
  async create(data: CreateSorteoDTO, userId: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
    });
    if (!loteria || loteria.isDeleted)
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

    return s;
  },

  async update(id: string, data: UpdateSorteoDTO, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted)
      throw new AppError("Sorteo no encontrado", 404);
    if (
      FINAL_STATES.has(existing.status)
    ) {
      throw new AppError(
        "No se puede editar un sorteo evaluado o cerrado",
        409
      );
    }

    // ⬇️ solo pasamos lo permitido por el schema (p. ej. scheduledAt)
    const s = await SorteoRepository.update(id, {
      scheduledAt: data.scheduledAt,
    } as UpdateSorteoDTO);

    const details: Record<string, any> = {};
    if (data.scheduledAt) {
      details.scheduledAt = (
        data.scheduledAt instanceof Date
          ? data.scheduledAt
          : new Date(data.scheduledAt)
      ).toISOString();
    }

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return s;
  },

  async open(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted)
      throw new AppError("Sorteo no encontrado", 404);
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

    return s;
  },

  async close(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted)
      throw new AppError("Sorteo no encontrado", 404);
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

    return s;
  },

  async evaluate(id: string, body: EvaluateSorteoDTO, userId: string) {
    const {
      winningNumber,
      extraOutcomeCode = null,
      extraMultiplierId = null,
    } = body;

    if (!winningNumber || winningNumber.length === 0) {
      throw new AppError("winningNumber es requerido", 400);
    }

    // 1) Cargar sorteo y validar estado
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted)
      throw new AppError("Sorteo no encontrado", 404);
    if (!EVALUABLE_STATES.has(existing.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409); // ✅ mensaje consistente
    }

    // 2) Si viene extraMultiplierId, resolver X (y validar que pertenece a la misma lotería)
    let extraX: number | null = null;
    if (extraMultiplierId) {
      const mul = await prisma.loteriaMultiplier.findUnique({
        where: { id: extraMultiplierId },
        select: { id: true, valueX: true, isActive: true, loteriaId: true },
      });
      if (!mul || !mul.isActive) {
        throw new AppError("extraMultiplierId inválido o inactivo", 400);
      }
      if (mul.loteriaId !== existing.loteriaId) {
        throw new AppError(
          "extraMultiplierId no pertenece a la lotería del sorteo",
          400
        );
      }
      extraX = mul.valueX;
    }

    // 3) Transacción: snapshot + pagos + marcar tickets
    const evaluationResult = await prisma.$transaction(async (tx) => {
      // 3.1) Snapshot en el sorteo (usar relación connect/disconnect para consistencia)
      await tx.sorteo.update({
        where: { id },
        data: {
          status: SorteoStatus.EVALUATED,
          winningNumber,
          extraOutcomeCode,
          ...(extraMultiplierId
            ? { extraMultiplier: { connect: { id: extraMultiplierId } } }
            : { extraMultiplier: { disconnect: true } }),
          extraMultiplierX: extraX,
        },
      });

      // 3.2) Pagar NUMERO (ganan las jugadas con number === winningNumber)
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: { sorteoId: id },
          type: "NUMERO",
          number: winningNumber,
          isDeleted: false,
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

      // 3.3) Pagar REVENTADO (solo si hay extraX > 0 y coincide el número)
      let reventadoWinners: { id: string; amount: number; ticketId: string }[] =
        [];
      if (extraX != null && extraX > 0) {
        reventadoWinners = await tx.jugada.findMany({
          where: {
            ticket: { sorteoId: id },
            type: "REVENTADO",
            reventadoNumber: winningNumber,
            isDeleted: false,
          },
          select: { id: true, amount: true, ticketId: true },
        });

        for (const j of reventadoWinners) {
          const payout = j.amount * extraX;
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              settledMultiplierId: extraMultiplierId ?? undefined,
              settledMultiplierX: extraX,
              payout,
            },
          });
        }
      }

      // 3.4) Marcar tickets (EVALUATED / inactive / isWinner si alguna jugada ganó)
      const winningTicketIds = new Set<string>([
        ...numeroWinners.map((j) => j.ticketId),
        ...reventadoWinners.map((j) => j.ticketId),
      ]);

      const tickets = await tx.ticket.findMany({
        where: { sorteoId: id, isDeleted: false },
        select: { id: true },
      });

      let winners = 0;
      for (const t of tickets) {
        const tIsWinner = winningTicketIds.has(t.id);
        if (tIsWinner) winners++;
        await tx.ticket.update({
          where: { id: t.id },
          data: {
            status: TicketStatus.EVALUATED,
            isActive: false,
            isWinner: tIsWinner,
          },
        });
      }

      // 3.5) Auditoría en la misma tx
      await tx.activityLog.create({
        data: {
          userId,
          action: ActivityType.SORTEO_EVALUATE,
          targetType: "SORTEO",
          targetId: id,
          details: {
            winningNumber,
            extraOutcomeCode,
            extraMultiplierId,
            extraMultiplierX: extraX,
            winners,
          } as Prisma.InputJsonObject,
        },
      });

      return { winners, extraMultiplierX: extraX };
    });

    // 4) Log adicional fuera de la tx
    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_EVALUATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        winningNumber,
        extraOutcomeCode,
        extraMultiplierId,
        extraMultiplierX: evaluationResult.extraMultiplierX,
        winners: evaluationResult.winners,
      },
    });

    // 5) Devuelve el sorteo ya evaluado
    const s = await prisma.sorteo.findUnique({ where: { id } });
    return s;
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

    return s;
  },

  async list(loteriaId?: string, page?: number, pageSize?: number) {
    const p = page && page > 0 ? page : 1;
    const ps = pageSize && pageSize > 0 ? pageSize : 10;
    const { data, total } = await SorteoRepository.list(loteriaId, p, ps);
    const totalPages = Math.ceil(total / ps);
    return {
      data,
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
    const s = await SorteoRepository.findById(id);
    if (!s || s.isDeleted) throw new AppError("Sorteo no encontrado", 404);
    return s;
  },
};
