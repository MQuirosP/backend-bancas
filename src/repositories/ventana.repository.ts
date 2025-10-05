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
        banca: { connect: { id: (data.bancaId ) } },
      },
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_CREATE_DB",
      payload: { ventanaId: ventana.id, code: ventana },
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
    // valida existencia
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
      },
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_SOFT_DELETE_DB",
      payload: { ventanaId: id, reason },
    });
    return ventana;
  },

  // Listado con paginación simple como en ticket.respository.ts
  async list(page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      prisma.ventana.findMany({
        where: { isDeleted: false },
        include: { banca: true },
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      prisma.ventana.count({
        where: { isDeleted: false },
      }),
    ]);
    return { data, total };
  },
};

export default VentanaRepository;
