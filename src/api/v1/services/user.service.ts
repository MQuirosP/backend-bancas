import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { CreateUserDTO, UpdateUserDTO } from '../dto/user.dto';
import { hashPassword, comparePassword } from '../../../utils/crypto';
import UserRepository from '../../../repositories/user.repository';
import { Role } from '@prisma/client';
import { normalizePhone } from "../../../utils/phoneNormalizer";

/**
 * Deep merge de configuraciones (parcial)
 * newSettings override los valores en currentSettings, manteniendo lo demás
 */
function deepMergeSettings(
  currentSettings: Record<string, any>,
  newSettings: Record<string, any>
): Record<string, any> {
  const merged = { ...currentSettings };

  for (const key in newSettings) {
    const newVal = newSettings[key];

    // Si es null, se borra del merged (null = "remover este campo")
    if (newVal === null || newVal === undefined) {
      delete merged[key];
    } else if (typeof newVal === 'object' && newVal !== null && !Array.isArray(newVal)) {
      // Si es un objeto anidado, mergear recursivamente
      const currentVal = merged[key];
      if (typeof currentVal === 'object' && currentVal !== null && !Array.isArray(currentVal)) {
        merged[key] = deepMergeSettings(currentVal, newVal);
      } else {
        // Si el actual no es objeto, reemplazar completamente
        merged[key] = newVal;
      }
    } else {
      // Para primitivos o arrays, reemplazar completamente
      merged[key] = newVal;
    }
  }

  return merged;
}

async function ensureVentanaActiveOrThrow(ventanaId: string) {
  const v = await prisma.ventana.findUnique({
    where: { id: ventanaId },
    select: { id: true, isActive: true, banca: { select: { id: true, isActive: true } } },
  });
  if (!v || !v.isActive) throw new AppError('Ventana not found or inactive', 404);
  if (!v.banca || !v.banca.isActive) throw new AppError('Parent Banca inactive', 409);
}

export const UserService = {
  async create(dto: CreateUserDTO) {
    const username = dto.username.trim();
    const role: Role = (dto.role as Role) ?? Role.VENTANA;
    const email = dto.email ? dto.email.trim().toLowerCase() : null;
    const code = dto.code?.trim() ? dto.code.trim() : null;
    const phone = dto.phone !== undefined ? normalizePhone(dto.phone) : null;
    const isActive = dto.isActive ?? true;

    // Regla role ↔ ventanaId
    if (role === Role.ADMIN) {
      dto.ventanaId = null as any;
    } else {
      if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + role, 400);
      await ensureVentanaActiveOrThrow(dto.ventanaId);
    }

    // Unicidad username
    const userByUsername = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (userByUsername) throw new AppError('Username already in use', 409);

    // Unicidad email (si viene)
    if (email) {
      const userByEmail = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (userByEmail) throw new AppError('Email already in use', 409);
    }

    // Unicidad code (si viene) – Prisma ya es unique, pero damos error claro
    if (code) {
      const userByCode = await prisma.user.findFirst({ where: { code }, select: { id: true } });
      if (userByCode) throw new AppError('Code already in use', 409);
    }

    const hashed = await hashPassword(dto.password);

    const created = await UserRepository.create({
      name: dto.name,
      email,
      username,
      phone,
      password: hashed,
      role,
      ventanaId: role === Role.ADMIN ? null : dto.ventanaId!,
      code,                 
      isActive,             
    });

    const result = await prisma.user.findUnique({
      where: { id: created.id },
      select: {
        id: true, name: true, username: true, email: true, role: true,
        ventanaId: true, isActive: true, code: true,
        createdAt: true,
      },
    });

    return result!;
  },

  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, username: true, role: true,
        ventanaId: true, isActive: true, code: true,
        createdAt: true,
      },
    });
    if (!user) throw new AppError('User not found', 404);
    return user;
  },

  async list(params: {
    page?: number;
    pageSize?: number;
    role?: string;
    search?: string;
    ventanaId?: string;
    isActive?: boolean;
  }) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

    const { data, total } = await UserRepository.listPaged({
      page,
      pageSize,
      role: params.role as Role | undefined,
      search: params.search?.trim() || undefined,
      ventanaId: params.ventanaId,
      isActive: params.isActive,
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: { total, page, pageSize, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
    };
  },

  async update(id: string, dto: UpdateUserDTO) {
    // Cargar actual para comparaciones
    const current = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, email: true, role: true, ventanaId: true, code: true,
      },
    });
    if (!current) throw new AppError('User not found', 404);

    const toUpdate: any = {};

    // username (unicidad si cambia)
    if (dto.username && dto.username.trim() !== current.username) {
      const newUsername = dto.username.trim();
      const dup = await prisma.user.findUnique({ where: { username: newUsername }, select: { id: true } });
      if (dup && dup.id !== id) throw new AppError('Username already in use', 409);
      toUpdate.username = newUsername;
    }

    // email (normalización + unicidad si cambia)
    if (dto.email !== undefined) {
      const e = dto.email === null ? null : dto.email.trim().toLowerCase();
      if (e !== current.email) {
        if (e) {
          const dupEmail = await prisma.user.findUnique({ where: { email: e }, select: { id: true } });
          if (dupEmail && dupEmail.id !== id) throw new AppError('Email already in use', 409);
        }
        toUpdate.email = e;
      }
    }

    // name
    if (dto.name !== undefined) toUpdate.name = dto.name;

    // password
    if (dto.password) {
      toUpdate.password = await hashPassword(dto.password);
    }

    // role ↔ ventanaId
    if (dto.role) {
      const newRole = dto.role as Role;
      toUpdate.role = newRole;

      if (newRole === Role.ADMIN) {
        // Forzar desvinculación
        toUpdate.ventanaId = null;
      } else {
        // Requiere ventanaId (nuevo o conservar el actual)
        const effectiveVentanaId = dto.ventanaId ?? current.ventanaId;
        if (!effectiveVentanaId) throw new AppError('ventanaId is required for role ' + newRole, 400);
        await ensureVentanaActiveOrThrow(effectiveVentanaId);
        toUpdate.ventanaId = effectiveVentanaId;
      }
    } else if (dto.ventanaId !== undefined) {
      // Cambian solo ventanaId (sin cambiar role): validar si el role actual lo requiere
      if (current.role === Role.ADMIN) {
        // Admin no debería estar ligado a ventana
        toUpdate.ventanaId = null;
      } else {
        if (!dto.ventanaId) throw new AppError('ventanaId is required for role ' + current.role, 400);
        await ensureVentanaActiveOrThrow(dto.ventanaId);
        toUpdate.ventanaId = dto.ventanaId;
      }
    }

    // toggle de actividad (deprecated isDeleted → usar isActive inverso)
    if (dto.isActive !== undefined) toUpdate.isActive = dto.isActive;

    // settings: merge parcial con los settings existentes
    if (dto.settings !== undefined) {
      // Obtener settings actuales (pueden ser null)
      const currentUser = await prisma.user.findUnique({
        where: { id },
        select: { settings: true },
      });

      const currentSettings = currentUser?.settings as Record<string, any> | null || {};

      if (dto.settings === null) {
        // Si envían null explícitamente, limpiar settings
        toUpdate.settings = null;
      } else {
        // Merge parcial: el DTO override los campos que vienen, mantienen los demás
        const mergedSettings = deepMergeSettings(currentSettings, dto.settings);
        toUpdate.settings = mergedSettings;
      }
    }

    const updated = await UserRepository.update(id, toUpdate);

    // Respuesta coherente (incluye username)
    const result = await prisma.user.findUnique({
      where: { id: updated.id },
      select: {
        id: true, name: true, username: true, email: true, role: true,
        ventanaId: true, isActive: true, createdAt: true,
      },
    });

    return result!;
  },

  async softDelete(id: string, _deletedBy: string, _deletedReason?: string) {
    const user = await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
      },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isActive: true, createdAt: true },
    });
    return user;
  },

  async restore(id: string) {
    const user = await prisma.user.update({
      where: { id },
      data: { isActive: true },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isActive: true, createdAt: true },
    });
    return user;
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    // Obtener contraseña actual del usuario
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, name: true },
    });

    if (!user) {
      throw new AppError('Usuario no encontrado', 404, { code: 'USER_NOT_FOUND' });
    }

    // Verificar que la contraseña actual es correcta
    const isPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isPasswordValid) {
      throw new AppError('Contraseña actual incorrecta', 400, { code: 'INVALID_PASSWORD' });
    }

    // Hash de la nueva contraseña
    const hashedNewPassword = await hashPassword(newPassword);

    // Actualizar contraseña
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword },
    });

    return {
      success: true,
      message: 'Contraseña actualizada correctamente',
    };
  },
};

export default UserService;
