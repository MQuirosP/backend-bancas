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
    if (!existing)
      throw new AppError("Sorteo no encontrado", 404);
    if (FINAL_STATES.has(existing.status)) {
      throw new AppError(
        "No se puede editar un sorteo evaluado o cerrado",
        409
      );
    }

    // solo pasamos lo permitido por el schema (p. ej. scheduledAt)
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
    if (!existing)
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
    if (!existing)
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
      extraMultiplierId = null,
      extraOutcomeCode: extraOutcomeCodeInput = null,
    } = body;

    if (!winningNumber?.length)
      throw new AppError("winningNumber es requerido", 400);

    // 1) Cargar sorteo y validar estado
    const existing = await SorteoRepository.findById(id);
    if (!existing)
      throw new AppError("Sorteo no encontrado", 404);
    if (!EVALUABLE_STATES.has(existing.status)) {
      throw new AppError("Solo se puede evaluar desde OPEN", 409);
    }

    // 2) Resolver multiplicador extra (si viene) sin asumir colores
    let extraX: number | null = null;
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
      // etiqueta neutral: primero la que envía el cliente, si no, tomamos el nombre del multiplicador
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
          extraOutcomeCode, // <- ahora existe y es agnóstico
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

      // 3.3 Pagar REVENTADO
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
          const payout = j.amount * extraX!;
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              finalMultiplierX: extraX!, // snapshot a la jugada; sin settled*
              payout,
            },
          });
        }
      }

      // 3.4 Marcar tickets
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
        await tx.ticket.update({
          where: { id: t.id },
          data: { status: "EVALUATED", isActive: false, isWinner: tIsWinner },
        });
      }

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
            extraOutcomeCode, // etiqueta neutral
            winners,
          },
        },
      });

      return { winners, extraMultiplierX: extraX };
    });

    // 4) Log adicional (opcional)
    await ActivityService.log({
      userId,
      action: "SORTEO_EVALUATE",
      targetType: "SORTEO",
      targetId: id,
      details: {
        winningNumber,
        extraMultiplierId,
        extraMultiplierX: evaluationResult.extraMultiplierX,
        extraOutcomeCode, // idem
        winners: evaluationResult.winners,
      },
    });

    // 5) Devolver sorteo evaluado
    return prisma.sorteo.findUnique({ where: { id } });
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

  async list(params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: SorteoStatus;
    search?: string;        // ✅
  }) {
    const p = params.page && params.page > 0 ? params.page : 1;
    const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

    const { data, total } = await SorteoRepository.list({
      page: p,
      pageSize: ps,
      loteriaId: params.loteriaId,
      status: params.status,
      search: params.search?.trim() || undefined,
    });

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
    const sorteo = await SorteoRepository.findById(id);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return sorteo;
  },
};
