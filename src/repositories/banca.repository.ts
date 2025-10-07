import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma } from "@prisma/client";
import { CreateBancaInput, UpdateBancaInput } from "../api/v1/dto/banca.dto";

// Mapeadores DTO -> Prisma
const toPrismaCreate = (d: CreateBancaInput): Prisma.BancaCreateInput => ({
  name: d.name,
  code: d.code,
  defaultMinBet: d.defaultMinBet,          // si vienen, Prisma los usa; si no, DB defaults
  globalMaxPerNumber: d.globalMaxPerNumber,
  address: d.address,
  phone: d.phone,
  email: d.email,
});

const toPrismaUpdate = (d: UpdateBancaInput): Prisma.BancaUpdateInput => ({
  name: d.name,
  code: d.code,
  defaultMinBet: d.defaultMinBet,
  globalMaxPerNumber: d.globalMaxPerNumber,
  address: d.address,
  phone: d.phone,
  email: d.email,
});

const BancaRepository = {
  async create(data: CreateBancaInput) {
    const banca = await prisma.banca.create({ data: toPrismaCreate(data) });
    logger.info({ layer: "repository", action: "BANCA_CREATE_DB", payload: { bancaId: banca.id, code: banca.code } });
    return banca;
  },

  findById(id: string) {
    return prisma.banca.findUnique({ where: { id } });
  },

  findByCode(code: string) {
    return prisma.banca.findUnique({ where: { code } });
  },

  findByName(name: string) {
    return prisma.banca.findUnique({ where: { name } });
  },

  async update(id: string, data: UpdateBancaInput) {
    const banca = await prisma.banca.update({ where: { id }, data: toPrismaUpdate(data) });
    logger.info({ layer: "repository", action: "BANCA_UPDATE_DB", payload: { bancaId: id } });
    return banca;
  },

  async softDelete(id: string, userId: string, reason?: string) {
    const existing = await prisma.banca.findUnique({ where: { id } });
    if (!existing) throw new AppError("Banca no encontrada", 404);

    const banca = await prisma.banca.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, isActive: false, deletedReason: reason },
    });

    logger.warn({ layer: "repository", action: "BANCA_SOFT_DELETE_DB", payload: { bancaId: id, reason } });
    return banca;
  },

  async list(page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.banca.findMany({
        where: { isDeleted: false },
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      prisma.banca.count({ where: { isDeleted: false } }),
    ]);

    return { data, total };
  },

  async restore(id: string) {
    const existing = await prisma.banca.findUnique({ where: { id } });
    if (!existing) throw new AppError("Banca no encontrada", 404);
    if (!existing.isDeleted) {
      logger.info({ layer: "repository", action: "BANCA_RESTORE_IDEMPOTENT", payload: { bancaId: id } });
      return existing; // idempotente
    }

    // Evita romper unicidad al restaurar
    const [dupCode, dupName] = await Promise.all([
      prisma.banca.findFirst({ where: { id: { not: id }, code: existing.code, isDeleted: false } }),
      prisma.banca.findFirst({ where: { id: { not: id }, name: existing.name, isDeleted: false } }),
    ]);
    if (dupCode) throw new AppError("Cannot restore: another active Banca with the same code exists.", 409);
    if (dupName) throw new AppError("Cannot restore: another active Banca with the same name exists.", 409);

    const banca = await prisma.banca.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null, deletedBy: null, isActive: true, deletedReason: null },
    });

    logger.info({ layer: "repository", action: "BANCA_RESTORE_DB", payload: { bancaId: id } });
    return banca;
  },
};

export default BancaRepository;
