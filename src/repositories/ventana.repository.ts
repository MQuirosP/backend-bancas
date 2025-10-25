// repositories/ventana.repository.ts
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

  // ⚠️ Deja de marcar isDeleted: sólo inactiva
  async softDelete(id: string, userId: string, reason?: string) {
    const existing = await prisma.ventana.findUnique({ where: { id } });
    if (!existing) throw new AppError("Ventana not found", 404);

    const ventana = await prisma.ventana.update({
      where: { id },
      data: {
        isActive: false,
        // Campos de borrado lógico deprecated: no se usan
      },
    });
    logger.info({
      layer: "repository",
      action: "VENTANA_SOFT_DELETE_DB",
      payload: { ventanaId: id, reason },
    });
    return ventana;
  },

  async list(page = 1, pageSize = 10, search?: string) {
  const skip = (page - 1) * pageSize
  const s = (search ?? '').trim()

  const where: Prisma.VentanaWhereInput = {
    ...(s ? {
      OR: [
        { code:  { contains: s, mode: 'insensitive' } },
        { name:  { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
      ],
    } : {}),
  }

  // debug
  logger.info({ layer: 'repository', action: 'VENTANA_LIST_WHERE', payload: { where } })

  const [data, total] = await Promise.all([
    prisma.ventana.findMany({ where, include: { banca: true }, skip, take: pageSize, orderBy: { createdAt: 'desc' } }),
    prisma.ventana.count({ where }),
  ])

  return { data, total }
},

  // Si finalmente eliminas “isDeleted” del modelo, elimina también este restore.
  async restore(id: string) {
    // Mantén igual o elimina por completo si ya no habrá soft-delete con isDeleted.
    const existing = await prisma.ventana.findUnique({
      where: { id },
      include: { banca: true },
    });
    console.log(existing);
    if (!existing) throw new AppError("Ventana no encontrada", 404);

    // Con el nuevo modelo, restaurar = volver a activar
    const ventana = await prisma.ventana.update({
      where: { id },
      data: {
        isActive: true,
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
