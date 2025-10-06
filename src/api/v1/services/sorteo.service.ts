// src/api/v1/services/sorteo.service.ts
import { ActivityType, Prisma, SorteoStatus, TicketStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../dto/sorteo.dto";

const FINAL_STATES: ReadonlyArray<SorteoStatus> = [
  SorteoStatus.EVALUATED,
  SorteoStatus.CLOSED,
];

const EVALUABLE_STATES: ReadonlyArray<SorteoStatus> = [
  SorteoStatus.OPEN,
  SorteoStatus.CLOSED,
];

export const SorteoService = {
  async create(data: CreateSorteoDTO, userId: string) {
    const loteria = await prisma.loteria.findUnique({ where: { id: data.loteriaId } });
    if (!loteria || loteria.isDeleted) throw new AppError("Lotería no encontrada", 404);

    const s = await SorteoRepository.create(data);

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      scheduledAt: (
        data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt)
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
    if (!existing || existing.isDeleted) throw new AppError("Sorteo no encontrado", 404);

    if (FINAL_STATES.includes(existing.status)) {
      throw new AppError("No se puede editar un sorteo evaluado o cerrado", 409);
    }

    const s = await SorteoRepository.update(id, data);

    const details: Record<string, any> = {};
    if (data.scheduledAt) {
      details.scheduledAt = (
        data.scheduledAt instanceof Date ? data.scheduledAt : new Date(data.scheduledAt)
      ).toISOString();
    }
    if (data.status) details.status = data.status;
    if (data.winningNumber) details.winningNumber = data.winningNumber;

    await ActivityService.log({
      userId,
      action: ActivityType.SYSTEM_ACTION, // no existe SORTEO_UPDATE
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return s;
  },

  async open(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted) throw new AppError("Sorteo no encontrado", 404);
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
      action: ActivityType.SYSTEM_ACTION,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

    return s;
  },

  async close(id: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted) throw new AppError("Sorteo no encontrado", 404);
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

  async evaluate(id: string, winningNumber: string, userId: string) {
    const existing = await SorteoRepository.findById(id);
    if (!existing || existing.isDeleted) throw new AppError("Sorteo no encontrado", 404);
    if (!EVALUABLE_STATES.includes(existing.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN o CLOSED", 409);
    }

    const tickets = await prisma.ticket.findMany({
      where: { sorteoId: id, isDeleted: false },
      include: { jugadas: true },
    });

    let winners = 0;
    await prisma.$transaction(async (tx) => {
      for (const t of tickets) {
        let isWinner = false;
        for (const j of t.jugadas) {
          if (j.number === winningNumber) {
            isWinner = true;
            const payout = j.amount * j.finalMultiplierX;
            await tx.jugada.update({
              where: { id: j.id },
              data: { isWinner: true, payout },
            });
          }
        }
        await tx.ticket.update({
          where: { id: t.id },
          data: { isWinner, status: TicketStatus.EVALUATED, isActive: false },
        });
        if (isWinner) winners++; // 👈 faltaba
      }
    });

    const s = await SorteoRepository.evaluate(id, winningNumber);

    const details: Prisma.InputJsonObject = { winningNumber, winners };

    await ActivityService.log({
      userId,
      action: ActivityType.SORTEO_EVALUATE,
      targetType: "SORTEO",
      targetId: id,
      details,
    });

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
      meta: { total, page: p, pageSize: ps, totalPages, hasNextPage: p < totalPages, hasPrevPage: p > 1 },
    };
  },

  async findById(id: string) {
    const s = await SorteoRepository.findById(id);
    if (!s || s.isDeleted) throw new AppError("Sorteo no encontrado", 404);
    return s;
  },
};
