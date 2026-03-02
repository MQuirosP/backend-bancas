// src/repositories/user.repository.ts
import { withConnectionRetry } from '../core/withConnectionRetry';
import prisma from '../core/prismaClient';
import logger from '../core/logger';
import { Prisma, Role } from '@prisma/client';

export const UserRepository = {
  findById: (id: string) =>
    withConnectionRetry(
      () => prisma.user.findUnique({ where: { id } }),
      { context: 'UserRepository.findById' }
    ),

  findByUsername: (username: string) =>
    withConnectionRetry(
      () => prisma.user.findUnique({ where: { username } }),
      { context: 'UserRepository.findByUsername' }
    ),

  findByEmail: (email: string) =>
    withConnectionRetry(
      () => prisma.user.findUnique({ where: { email } }),
      { context: 'UserRepository.findByEmail' }
    ),

  findActiveVendedorById: (id: string) =>
    withConnectionRetry(
      () => prisma.user.findFirst({
        where: { id, role: Role.VENDEDOR, isActive: true },
        select: { id: true, role: true, ventanaId: true, isActive: true },
      }),
      { context: 'UserRepository.findActiveVendedorById' }
    ),

  //  admitir code e isActive en create
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
    withConnectionRetry(
      () => prisma.user.create({
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
      { context: 'UserRepository.create' }
    ),

  update: (id: string, data: Partial<{
    name: string; email: string | null; username: string; password: string;
    role: Role; ventanaId: string | null; isActive: boolean; code: string | null; phone: string | null; settings: any;
  }>) =>
    withConnectionRetry(
      () => prisma.user.update({ where: { id }, data }),
      { context: 'UserRepository.update' }
    ),

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

    const [rawData, total] = await withConnectionRetry(
      () => prisma.$transaction([
        prisma.user.findMany({
          where,
          skip,
          take: pageSize,
          select: select ?? {
            id: true, name: true, email: true, username: true, role: true,
            ventanaId: true, isActive: true, code: true,
            createdAt: true, updatedAt: true, settings: true,
            platform: true, appVersion: true,
            ventana: {
              select: {
                id: true,
                name: true,
                banca: { select: { id: true, name: true } },
              }
            },
          },
          orderBy: orderBy ?? { createdAt: 'desc' },
        }),
        prisma.user.count({ where }),
      ]),
      { context: 'UserRepository.listPaged' }
    );

    // Aplanar banca al mismo nivel que ventana
    const data = rawData.map((user: any) => {
      const { ventana, ...rest } = user;
      return {
        ...rest,
        ventana: ventana ? { id: ventana.id, name: ventana.name } : null,
        banca: ventana?.banca ?? null,
      };
    });

    return { data, total };
  },
};

export default UserRepository;
