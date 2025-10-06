import bcrypt from 'bcryptjs';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { CreateUserDTO, ListUsersQuery, UpdateUserDTO } from '../dto/user.dto';
import { Role } from '@prisma/client';
import { paginateOffset } from '../../../utils/pagination';
import { hashPassword } from '../../../utils/crypto';

export const UserService = {
  async create(dto: CreateUserDTO) {
    const exists = await prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new AppError('Email already in use', 409);

    const hashed = await hashPassword(dto.password);

    const user = await prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashed,
        role: dto.role ?? 'VENTANA',
        ventanaId: dto.ventanaId ?? null,
      },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });

    return user;
  },

  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });
    if (!user) throw new AppError('User not found', 404);
    return user;
  },

  async list(params: {
    page?: number;
    pageSize?: number;
    role?: string;
    isDeleted?: boolean;
  }) {
    const { page, pageSize, role, isDeleted } = params;

    const where: Record<string, any> = {};
    if (role) where.role = role;
    if (typeof isDeleted === 'boolean') where.isDeleted = isDeleted;

    const result = await paginateOffset(prisma.user, {
      where,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isDeleted: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      pagination: { page, pageSize },
    });

    return result;
  },

  async update(id: string, dto: UpdateUserDTO) {
    const toUpdate: any = { ...dto };
    if (dto.password) {
      toUpdate.password = await hashPassword(dto.password);
    }

    const user = await prisma.user.update({
      where: { id },
      data: toUpdate,
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });

    return user;
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
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      },
      select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
    });

    return user;
  },
};

export default UserService;
