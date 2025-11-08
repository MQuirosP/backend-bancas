// src/repositories/user.repository.ts
import prisma from '../core/prismaClient';
import logger from '../core/logger';
import { Prisma, Role } from '@prisma/client';

export const UserRepository = {
  findById: (id: string) =>
    prisma.user.findUnique({ where: { id } }),

  findByUsername: (username: string) =>
    prisma.user.findUnique({ where: { username } }),

  findByEmail: (email: string) =>
    prisma.user.findUnique({ where: { email } }),

  findActiveVendedorById: (id: string) =>
    prisma.user.findFirst({
      where: { id, role: Role.VENDEDOR, isActive: true },
      select: { id: true, role: true, ventanaId: true, isActive: true },
    }),

  // ✅ admitir code e isActive en create
  create: (data: {
    name: string;
    email: string | null;
    username: string;
    password: string;
    phone?: string | null;
    role: Role;
    ventanaId?: string | null;
    code?: string | null;
    isActive?: boolean;
  }) =>
    prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        username: data.username,
        phone: data.phone ?? null,
        password: data.password,
        role: data.role,
        ventanaId: data.ventanaId ?? null,
        ...(data.code !== undefined ? { code: data.code } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    }),

  update: (id: string, data: Partial<{
    name: string; email: string | null; username: string; password: string;
    role: Role; ventanaId: string | null; isActive: boolean; code: string | null; phone: string | null; settings: any;
  }>) =>
    prisma.user.update({ where: { id }, data }),

  async listPaged(args: {
    page: number;
    pageSize: number;
    role?: Role;
    search?: string;
    ventanaId?: string;
    isActive?: boolean;
    select?: Prisma.UserSelect;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  }) {
    const { page, pageSize, role, search, ventanaId, isActive, select, orderBy } = args;
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(ventanaId ? { ventanaId } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
    };

    const s = (search ?? '').trim();
    if (s.length > 0) {
      const existingAnd = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
      where.AND = [
        ...existingAnd,
        {
          OR: [
            { name:     { contains: s, mode: 'insensitive' } },
            { email:    { contains: s, mode: 'insensitive' } },
            { username: { contains: s, mode: 'insensitive' } },
            { code:     { contains: s, mode: 'insensitive' } },
            { ventana:  { is: { name: { contains: s, mode: 'insensitive' } } } },
          ],
        },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        select: select ?? {
          id: true, name: true, email: true, username: true, role: true,
          ventanaId: true, isActive: true, code: true,
          createdAt: true, updatedAt: true, settings: true,
          ventana: { select: { id: true, name: true } },
        },
        orderBy: orderBy ?? { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    return { data, total };
  },
};

export default UserRepository;
