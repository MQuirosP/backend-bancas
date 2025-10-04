import bcrypt from 'bcryptjs';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { CreateUserDTO, ListUsersQuery, UpdateUserDTO } from '../dto/user.dto';
import { Role } from '@prisma/client';

export const UserService = {
  async create(dto: CreateUserDTO) {
    const exists = await prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new AppError('Email already in use', 409);

    const hashed = await bcrypt.hash(dto.password, 10);

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

  async list(query: ListUsersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: any = {};
    if (typeof query.isDeleted === 'boolean') where.isDeleted = query.isDeleted;
    if (query.role) where.role = query.role as Role;

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, name: true, email: true, role: true, ventanaId: true, isDeleted: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  async update(id: string, dto: UpdateUserDTO) {
    const toUpdate: any = { ...dto };
    if (dto.password) {
      toUpdate.password = await bcrypt.hash(dto.password, 10);
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
