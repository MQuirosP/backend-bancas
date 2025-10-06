import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, Role } from "@prisma/client";

type VendedorCreateParams = {
  ventanaId: string;
  name: string;
  email: string;
  passwordHash: string;
};

type VendedorUpdateParams = Partial<VendedorCreateParams>;

type ListFilters = {
  ventanaId?: string;
  search?: string;
};

const VendedorRepository = {
  async create(data: VendedorCreateParams) {
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        password: data.passwordHash,
        role: Role.VENDEDOR,
        ventana: { connect: { id: data.ventanaId } },
      } satisfies Prisma.UserCreateInput,
    });

    logger.info({ layer: "repository", action: "VENDEDOR_CREATE_DB", payload: { userId: user.id, email: user.email } });
    return user;
  },

  findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { ventana: true },
    });
  },

  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  async update(id: string, data: VendedorUpdateParams) {
    const user = await prisma.user.update({
      where: { id },
      data: {
        name: data.name,
        email: data.email,
        password: data.passwordHash,
        ...(data.ventanaId ? { ventana: { connect: { id: data.ventanaId } } } : {}),
      } satisfies Prisma.UserUpdateInput,
    });

    logger.info({ layer: "repository", action: "VENDEDOR_UPDATE_DB", payload: { userId: id } });
    return user;
  },

  async softDelete(id: string, actorUserId: string, reason?: string) {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new AppError("Vendedor no encontrado", 404);

    const user = await prisma.user.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actorUserId, deletedReason: reason },
    });

    logger.warn({ layer: "repository", action: "VENDEDOR_SOFT_DELETE_DB", payload: { userId: id, reason } });
    return user;
  },

  async restore(id: string) {
    const existing = await prisma.user.findUnique({
      where: { id },
      include: { ventana: { include: { banca: true } } },
    });
    if (!existing) throw new AppError("Vendedor no encontrado", 404);
    if (!existing.isDeleted) {
      logger.info({ layer: "repository", action: "VENDEDOR_RESTORE_IDEMPOTENT", payload: { userId: id } });
      return existing;
    }

    // Debe seguir siendo vendedor
    if (existing.role !== Role.VENDEDOR) {
      throw new AppError("Cannot restore: user role is not VENDEDOR.", 409);
    }

    // Ventana y Banca deben estar activas
    if (!existing.ventana || existing.ventana.isDeleted || !existing.ventana.banca || existing.ventana.banca.isDeleted) {
      throw new AppError("Cannot restore: parent Ventana/Banca is deleted. Restore hierarchy first.", 409);
    }

    // email único (contra activos)
    const dupEmail = await prisma.user.findFirst({
      where: { id: { not: id }, email: existing.email, isDeleted: false },
    });
    if (dupEmail) throw new AppError("Cannot restore: another active user with the same email exists.", 409);

    const user = await prisma.user.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null, deletedBy: null, deletedReason: null },
    });

    logger.info({ layer: "repository", action: "VENDEDOR_RESTORE_DB", payload: { userId: id } });
    return user;
  },

  async list(page = 1, pageSize = 10, filters?: ListFilters) {
    const skip = (page - 1) * pageSize;
    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      role: Role.VENDEDOR,
      ...(filters?.ventanaId ? { ventanaId: filters.ventanaId } : {}),
      ...(filters?.search
        ? { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include: { ventana: true },
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({ where }),
    ]);

    return { data, total };
  },
};

export default VendedorRepository;
