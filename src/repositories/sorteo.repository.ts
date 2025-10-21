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
    select: { id: true, valueX: true, isActive: true, loteriaId: true },
  });
  if (!mul || !mul.isActive)
    throw new AppError("extraMultiplierId inválido o inactivo", 400);
  if (mul.loteriaId !== loteriaId) {
    throw new AppError(
      "extraMultiplierId no pertenece a la lotería del sorteo",
      400
    );
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
  // ✅ ÚNICAMENTE se permite reprogramar la fecha/hora
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? d.scheduledAt
      : new Date(d.scheduledAt)
    : undefined,

  // No se permite tocar:
  // - status
  // - winningNumber
  // - extraOutcomeCode
  // - extraMultiplier (connect/disconnect)
  // Esos campos se gestionan solo en PATCH /:id/evaluate
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
        extraMultiplier: { select: { id: true, name: true, valueX: true } }, // ⬅️ útil para inspección
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

  // ⬇️ evaluate ahora acepta body con reventado y snapshot X
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

    // si viene multiplier extra, validar y obtener X
    let extraX: number | null = null;
    if (extraMultiplierId) {
      extraX = await resolveExtraMultiplierX(
        extraMultiplierId,
        existing.loteriaId,
        prisma
      );
    }

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        status: SorteoStatus.EVALUATED,
        winningNumber,
        extraOutcomeCode,
        // ✅ relación con connect/disconnect
        ...(extraMultiplierId
          ? { extraMultiplier: { connect: { id: extraMultiplierId } } }
          : { extraMultiplier: { disconnect: true } }),
        extraMultiplierX: extraX, // snapshot del valor X
      },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_EVALUATE_DB",
      payload: {
        sorteoId: id,
        winningNumber,
        extraMultiplierId,
        extraMultiplierX: extraX,
      },
    });
    return s;
  },

  async list(params: {
    loteriaId?: string;
    page: number;
    pageSize: number;
    status?: SorteoStatus;
    search?: string;
  }) {
    const { loteriaId, page, pageSize, status, search } = params;

    const where: Prisma.SorteoWhereInput = {
      isActive: true,
      ...(loteriaId ? { loteriaId } : {}),
      ...(status ? { status } : {}),
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
            // 👇 permite buscar por nombre de lotería
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
          loteria: { select: { id: true, name: true } }, // 👈 incluir nombre de la lotería
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
