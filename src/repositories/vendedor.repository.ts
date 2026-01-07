import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, Role } from "@prisma/client";

type VendedorCreateParams = {
  ventanaId: string; // requerimos explícito para evitar nulls
  name: string;
  username: string;
  email?: string | null;
  passwordHash: string;
  code: string;
};

type VendedorUpdateParams = {
  ventanaId?: string;
  name?: string;
  email?: string | null;
  passwordHash?: string;
  isActive?: boolean;
};

type ListFilters = {
  ventanaId?: string;
  search?: string;
};

const VendedorRepository = {
  async create(data: VendedorCreateParams) {
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: (data.email ?? null) ? data.email?.toLowerCase() : null,
        username: data.username, // citext en DB
        code: data.code,
        password: data.passwordHash,
        role: Role.VENDEDOR,
        ventana: { connect: { id: data.ventanaId } },
      } satisfies Prisma.UserCreateInput,
    });

    logger.info({
      layer: "repository",
      action: "VENDEDOR_CREATE_DB",
      payload: { userId: user.id, email: user.email },
    });
    return user;
  },

  findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { ventana: true },
    });
  },

  findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  },

  findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  },

  findByCode(code: string) {
    return prisma.user.findUnique({ where: { code } });
  },

  async update(id: string, data: VendedorUpdateParams) {
    //  Obtener ventanaId actual para comparar si cambió
    const current = await prisma.user.findUnique({
      where: { id },
      select: { ventanaId: true },
    });

    const updateData: Prisma.UserUpdateInput = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.email !== undefined
        ? { email: data.email ? data.email.toLowerCase() : null }
        : {}),
      ...(data.passwordHash ? { password: data.passwordHash } : {}),
      ...(typeof data.isActive === "boolean"
        ? { isActive: data.isActive }
        : {}),
    };

    //  Manejar cambio de ventana explícitamente
    if (data.ventanaId !== undefined) {
      if (data.ventanaId) {
        // Conectar a nueva ventana (Prisma maneja automáticamente el disconnect de la anterior)
        updateData.ventana = { connect: { id: data.ventanaId } };
      } else {
        // Desconectar de ventana (si ventanaId es null)
        updateData.ventana = { disconnect: true };
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: updateData,
    });

    logger.info({
      layer: "repository",
      action: "VENDEDOR_UPDATE_DB",
      payload: {
        userId: id,
        ventanaIdChanged: data.ventanaId !== undefined && current?.ventanaId !== data.ventanaId,
        oldVentanaId: current?.ventanaId,
        newVentanaId: data.ventanaId,
      },
    });
    return user;
  },

  async softDelete(id: string, actorUserId: string, reason?: string) {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new AppError("Vendedor no encontrado", 404);

    const user = await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    logger.warn({
      layer: "repository",
      action: "VENDEDOR_SOFT_DELETE_DB",
      payload: { userId: id, reason },
    });
    return user;
  },

  async restore(id: string) {
    const existing = await prisma.user.findUnique({
      where: { id },
      include: { ventana: { include: { banca: true } } },
    });
    if (!existing) throw new AppError("Vendedor no encontrado", 404);
    if (existing.isActive) {
      logger.info({
        layer: "repository",
        action: "VENDEDOR_RESTORE_IDEMPOTENT",
        payload: { userId: id },
      });
      return existing;
    }

    if (existing.role !== Role.VENDEDOR) {
      throw new AppError("Cannot restore: user role is not VENDEDOR.", 409);
    }

    if (
      !existing.ventana ||
      !existing.ventana.isActive ||
      !existing.ventana.banca ||
      !existing.ventana.banca.isActive
    ) {
      throw new AppError(
        "Cannot restore: parent Ventana/Banca is inactive. Restore hierarchy first.",
        409
      );
    }

    // email único (contra activos)
    if (existing.email) {
      const dupEmail = await prisma.user.findFirst({
        where: { id: { not: id }, email: existing.email, isActive: true },
      });
      if (dupEmail)
        throw new AppError(
          "Cannot restore: another active user with the same email exists.",
          409
        );
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        isActive: true,
      },
    });

    logger.info({
      layer: "repository",
      action: "VENDEDOR_RESTORE_DB",
      payload: { userId: id },
    });
    return user;
  },

  async list(page = 1, pageSize = 10, filters?: ListFilters) {
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {
      isActive: true,
      role: Role.VENDEDOR,
      ...(filters?.ventanaId ? { ventanaId: filters.ventanaId } : {}),
    };

    const s = (filters?.search ?? "").trim();
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
            { email: { contains: s, mode: "insensitive" } },
            { username: { contains: s, mode: "insensitive" } },
            { code: { contains: s, mode: "insensitive" } },
            // ️ Relational filter correcto en Prisma:
            { ventana: { is: { name: { contains: s, mode: "insensitive" } } } },
          ],
        },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          code: true,
          isActive: true,
          createdAt: true,
          ventana: { select: { id: true, name: true } },
        },
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
