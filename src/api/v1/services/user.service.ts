// src/api/v1/services/user.service.ts
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { CreateUserDTO, UpdateUserDTO } from '../dto/user.dto';
import { paginateOffset } from '../../../utils/pagination';
import { hashPassword } from '../../../utils/crypto';
import UserRepository from '../../../repositories/user.repository';
import { Role } from '@prisma/client';

export const UserService = {
  async create(dto: CreateUserDTO) {
    const username = dto.username.trim();
    const email = dto.email?.trim() ?? null;

    const exists = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (exists) throw new AppError('Username already in use', 409); // 🔧 mensaje correcto

    const hashed = await hashPassword(dto.password);

    const user = await UserRepository.create({
      name: dto.name,
      email,
      username,
      password: hashed,
      role: (dto.role as Role) ?? 'VENTANA',
      ventanaId: dto.ventanaId ?? null,
    });

    // selecciona campos para respuesta
    const result = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, username: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });

    return result!;
  },

  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, username: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });
    if (!user) throw new AppError('User not found', 404);
    return user;
  },

  async list(params: {
    page?: number;
    pageSize?: number;
    role?: string;
    isDeleted?: boolean;
    search?: string; // ✅
  }) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;

    const { data, total } = await UserRepository.listPaged({
      page,
      pageSize,
      role: params.role as Role | undefined,
      isDeleted: params.isDeleted,
      search: params.search?.trim() || undefined,
    });

    const totalPages = Math.ceil(total / pageSize);
    return {
      data,
      meta: { total, page, pageSize, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
    };
  },

  async update(id: string, dto: UpdateUserDTO) {
    const toUpdate: any = { ...dto };
    if (dto.password) {
      toUpdate.password = await hashPassword(dto.password);
    }
    if (dto.email === undefined) {
      // no-op
    } else if (dto.email === null) {
      toUpdate.email = null;
    } else {
      toUpdate.email = dto.email.trim();
    }

    const user = await UserRepository.update(id, toUpdate);

    return await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    }) as any;
  },

  async softDelete(id: string, deletedBy: string, deletedReason?: string) {
    const user = await prisma.user.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy,
        deletedReason: deletedReason ?? 'User soft-deleted',
      },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });
    return user;
  },

  async restore(id: string) {
    const user = await prisma.user.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null, deletedBy: null, deletedReason: null },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });
    return user;
  },
};

export default UserService;
