import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, SorteoStatus, TicketStatus } from "@prisma/client";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../api/v1/dto/sorteo.dto";

const toPrismaCreate = (d: CreateSorteoDTO): Prisma.SorteoCreateInput => ({
  name: d.name,
  scheduledAt:
    d.scheduledAt instanceof Date ? d.scheduledAt : new Date(d.scheduledAt),
  loteria: { connect: { id: d.loteriaId } },
});

const toPrismaUpdate = (d: UpdateSorteoDTO): Prisma.SorteoUpdateInput => ({
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? d.scheduledAt
      : new Date(d.scheduledAt)
    : undefined,
  status: d.status ?? undefined, // ✅ sin `as any`
  winningNumber: d.winningNumber,
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
      include: { loteria: true },
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

    // ✅ Cerrar sorteo y desactivar tickets (isActive = false) en una transacción
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

  async evaluate(id: string, winningNumber: string) {
    // Solo actualiza el estado del sorteo y guarda el número ganador
    const s = await prisma.sorteo.update({
      where: { id },
      data: { status: SorteoStatus.EVALUATED, winningNumber },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_EVALUATE_DB",
      payload: { sorteoId: id, winningNumber },
    });
    return s;
  },

  async list(loteriaId?: string, page = 1, pageSize = 10) {
    const where: Prisma.SorteoWhereInput = {
      isDeleted: false,
      ...(loteriaId ? { loteriaId } : {}),
    };
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.sorteo.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { scheduledAt: "desc" },
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
        isDeleted: true,
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
