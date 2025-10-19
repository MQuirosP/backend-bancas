import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import { AppError } from "../core/errors";
import logger from "../core/logger";

type VentanaCreateParams = {
  bancaId: string;
  name: string;
  code: string;
  commissionMarginX: number;
  address?: string;
  phone?: string;
  email?: string;
  isActive?: boolean;
};

type VentanaUpdateParams = Partial<VentanaCreateParams>;

const VentanaRepository = {
  async create(data: VentanaCreateParams) {
    const ventana = await prisma.ventana.create({
      data: {
        name: data.name,
        code: data.code,
        commissionMarginX: data.commissionMarginX,
        address: data.address,
        phone: data.phone,
        email: data.email,
        isActive: data.isActive ?? true,
        banca: { connect: { id: data.bancaId } },
      },
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_CREATE_DB",
      payload: { ventanaId: ventana.id, code: ventana.code },
    });
    return ventana;
  },

  async findById(id: string) {
    return prisma.ventana.findUnique({
      where: { id },
      include: { banca: true },
    });
  },

  async findByCode(code: string) {
    return prisma.ventana.findUnique({
      where: { code },
      include: { banca: true },
    });
  },

  async update(id: string, data: VentanaUpdateParams) {
    const ventana = await prisma.ventana.update({
      where: { id },
      data,
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_UPDATE_DB",
      payload: { ventanaId: ventana.id },
    });
    return ventana;
  },

  async softDelete(id: string, userId: string, reason?: string) {
    const existing = await prisma.ventana.findUnique({ where: { id } });
    if (!existing) {
      throw new AppError("Ventana not found", 404);
    }

    const ventana = await prisma.ventana.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: reason || "No reason provided",
        isActive: false,
      },
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_SOFT_DELETE_DB",
      payload: { ventanaId: id, reason },
    });
    return ventana;
  },

  // ✅ Listado con search (contains, insensitive) + $transaction
  async list(page = 1, pageSize = 10, search?: string, isActive?: boolean) {
    const skip = (page - 1) * pageSize;

    // ✅ Nunca pases undefined como valor de filtro y excluye eliminadas por defecto
    const baseWhere: Prisma.VentanaWhereInput = {
      isDeleted: false,
      ...(typeof isActive === "boolean" ? { isActive } : {}),
    };

    const s = typeof search === "string" ? search.trim() : "";
    const where: Prisma.VentanaWhereInput =
      s.length > 0
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { code: { contains: s, mode: "insensitive" } },
                  { name: { contains: s, mode: "insensitive" } },
                  { email: { contains: s, mode: "insensitive" } },
                  { phone: { contains: s, mode: "insensitive" } },
                ],
              },
            ],
          }
        : baseWhere;

    const [data, total] = await prisma.$transaction([
      prisma.ventana.findMany({
        where,
        include: { banca: true },
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      prisma.ventana.count({ where }),
    ]);

    return { data, total };
  },

  async restore(id: string) {
    const existing = await prisma.ventana.findUnique({
      where: { id },
      include: { banca: true },
    });
    if (!existing) throw new AppError("Ventana no encontrada", 404);
    if (!existing.isDeleted) {
      logger.info({
        layer: "repository",
        action: "VENTANA_RESTORE_IDEMPOTENT",
        payload: { ventanaId: id },
      });
      return existing;
    }

    if (!existing.banca || existing.banca.isDeleted) {
      throw new AppError(
        "Cannot restore Ventana: parent Banca is deleted or missing. Restore Banca first.",
        409
      );
    }

    const dupCode = await prisma.ventana.findFirst({
      where: {
        id: { not: id },
        code: existing.code,
        isDeleted: false,
        isActive: true,
      },
    });
    if (dupCode)
      throw new AppError(
        "Cannot restore: another active Ventana with the same code exists.",
        409
      );

    const ventana = await prisma.ventana.update({
      where: { id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      },
    });

    logger.info({
      layer: "repository",
      action: "VENTANA_RESTORE_DB",
      payload: { ventanaId: id },
    });
    return ventana;
  },
};

export default VentanaRepository;
