// src/repositories/sorteo.repository.ts
import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, SorteoStatus } from "@prisma/client";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../api/v1/dto/sorteo.dto";

// ⬇️ helper para validar y obtener X del multiplier extra
async function resolveExtraMultiplierX(
  extraMultiplierId: string,
  loteriaId: string,
  tx = prisma
) {
  const mul = await tx.loteriaMultiplier.findUnique({
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

  if (!mul || !mul.isActive) {
    throw new AppError("extraMultiplierId inválido o inactivo", 400);
  }
  if (mul.loteriaId !== loteriaId) {
    throw new AppError(
      "extraMultiplierId no pertenece a la lotería del sorteo",
      400
    );
  }
  if (mul.kind !== "REVENTADO") {
    throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
  }
  if (mul.appliesToSorteoId && mul.appliesToSorteoId !== loteriaId) {
    // Si mul.appliesToSorteoId está seteado, la validación se hace en service.evaluate
    // comparándolo con el id del sorteo (NO con loteriaId).
  }

  return mul.valueX;
}

const toPrismaCreate = (d: CreateSorteoDTO): Prisma.SorteoCreateInput => ({
  name: d.name,
  scheduledAt:
    d.scheduledAt instanceof Date ? d.scheduledAt : new Date(d.scheduledAt),
  loteria: { connect: { id: d.loteriaId } },
  // extraOutcomeCode, extraMultiplierId/X se quedan nulos al crear
});

const toPrismaUpdate = (d: UpdateSorteoDTO): Prisma.SorteoUpdateInput => ({
  // ✅ ÚNICAMENTE se permite reprogramar la fecha/hora (más name/isActive si lo quieres)
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? d.scheduledAt
      : new Date(d.scheduledAt)
    : undefined,
  name: d.name ?? undefined,
  ...(d.loteriaId ? { loteria: { connect: { id: d.loteriaId } } } : {}),
  ...(typeof d.isActive === "boolean" ? { isActive: d.isActive } : {}),
  // No se permite tocar status/winning/extraOutcome/extraMultiplier aquí
});

const SorteoRepository = {
  async create(data: CreateSorteoDTO) {
    const s = await prisma.sorteo.create({ data: toPrismaCreate(data) });
    logger.info({
      layer: "repository",
      action: "SORTEO_CREATE_DB",
      payload: { sorteoId: s.id },
    });
    return s;
  },

  findById(id: string) {
    return prisma.sorteo.findUnique({
      where: { id },
      include: {
        loteria: true,
        extraMultiplier: { select: { id: true, name: true, valueX: true } },
      },
    });
  },

  async update(id: string, data: UpdateSorteoDTO) {
    const s = await prisma.sorteo.update({
      where: { id },
      data: toPrismaUpdate(data),
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_UPDATE_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  async open(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (current.status !== SorteoStatus.SCHEDULED) {
      throw new AppError(
        `Solo se pueden abrir sorteos en estado SCHEDULED (actual: ${current.status})`,
        400
      );
    }
    const s = await prisma.sorteo.update({
      where: { id },
      data: { status: SorteoStatus.OPEN },
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_OPEN_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  async close(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (
      current.status !== SorteoStatus.OPEN &&
      current.status !== SorteoStatus.EVALUATED
    ) {
      throw new AppError(
        `Solo se pueden cerrar sorteos en estado OPEN o EVALUATED (actual: ${current.status})`,
        400
      );
    }
    const s = await prisma.$transaction(async (tx) => {
      const closed = await tx.sorteo.update({
        where: { id },
        data: { status: SorteoStatus.CLOSED },
      });
      await tx.ticket.updateMany({
        where: { sorteoId: id, isDeleted: false },
        data: { isActive: false },
      });
      return closed;
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_CLOSE_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  // ⬇️ evaluate ahora paga jugadas y asigna multiplierId a REVENTADO ganadores
  async evaluate(
    id: string,
    body: {
      winningNumber: string;
      extraOutcomeCode?: string | null;
      extraMultiplierId?: string | null;
    }
  ) {
    const {
      winningNumber,
      extraOutcomeCode = null,
      extraMultiplierId = null,
    } = body;

    const existing = await prisma.sorteo.findUnique({
      where: { id },
      select: { id: true, loteriaId: true, status: true },
    });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (
      existing.status === SorteoStatus.EVALUATED ||
      existing.status === SorteoStatus.CLOSED
    ) {
      throw new AppError("Sorteo ya evaluado/cerrado", 400);
    }

    // Validar y obtener X del multiplicador si viene
    let extraX: number | null = null;
    if (extraMultiplierId) {
      extraX = await resolveExtraMultiplierX(
        extraMultiplierId,
        existing.loteriaId,
        prisma
      );
    }

    // Transacción: actualizar sorteo, pagar jugadas y marcar tickets
    const result = await prisma.$transaction(async (tx) => {
      // 1) Actualizar sorteo con snapshot de extraMultiplierX y relación
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

      // 2) Pagar NUMERO
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: { sorteoId: id },
          type: "NUMERO",
          number: winningNumber,
          isDeleted: false,
        },
        select: { id: true, amount: true, finalMultiplierX: true, ticketId: true },
      });

      for (const j of numeroWinners) {
        const payout = j.amount * j.finalMultiplierX;
        await tx.jugada.update({
          where: { id: j.id },
          data: { isWinner: true, payout },
        });
      }

      // 3) Pagar REVENTADO y asignar multiplierId (obligatorio si hay ganadores)
      let reventadoWinners: { id: string; amount: number; ticketId: string }[] = [];

      // Busca ganadores solo si hay X (>0)
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

        if (reventadoWinners.length > 0 && !extraMultiplierId) {
          throw new AppError(
            "Hay jugadas REVENTADO ganadoras: falta extraMultiplierId para asignar multiplierId",
            400
          );
        }

        for (const j of reventadoWinners) {
          const payout = j.amount * extraX!;
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              finalMultiplierX: extraX!,              // snapshot
              payout,
              ...(extraMultiplierId
                ? { multiplier: { connect: { id: extraMultiplierId } } }
                : {}),                                  // defensa futura
            },
          });
        }
      }

      // 4) Marcar tickets y winners
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

      logger.info({
        layer: "repository",
        action: "SORTEO_EVALUATE_DB",
        payload: {
          sorteoId: id,
          winningNumber,
          extraMultiplierId,
          extraMultiplierX: extraX,
          winners,
        },
      });

      return { winners, extraMultiplierX: extraX };
    });

    // Devolver sorteo evaluado con relaciones útiles
    return prisma.sorteo.findUnique({
      where: { id },
      include: {
        loteria: { select: { id: true, name: true } },
        extraMultiplier: { select: { id: true, name: true, valueX: true } },
      },
    });
  },

  async list(params: {
    loteriaId?: string;
    page: number;
    pageSize: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean
  }) {
    const { loteriaId, page, pageSize, status, search, isActive } = params;

    const where: Prisma.SorteoWhereInput = {
      ...(loteriaId ? { loteriaId } : {}),
      ...(status ? { status } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
    };

    const s = typeof search === "string" ? search.trim() : "";
    if (s.length > 0) {
      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          OR: [
            { name: { contains: s, mode: "insensitive" } },
            { winningNumber: { contains: s, mode: "insensitive" } },
            { loteria: { name: { contains: s, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const skip = (page - 1) * pageSize;

    const [data, total] = await prisma.$transaction([
      prisma.sorteo.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { scheduledAt: "desc" },
        include: {
          loteria: { select: { id: true, name: true } },
          extraMultiplier: { select: { id: true, name: true, valueX: true } },
        },
      }),
      prisma.sorteo.count({ where }),
    ]);

    return { data, total };
  },

  async softDelete(id: string, userId: string, reason?: string) {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        isActive: false,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: reason,
      },
    });

    logger.warn({
      layer: "repository",
      action: "SORTEO_SOFT_DELETE_DB",
      payload: { sorteoId: id, reason },
    });
    return s;
  },
};

export default SorteoRepository;
