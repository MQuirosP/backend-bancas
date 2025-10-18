import prisma from '../core/prismaClient';
import { Prisma, Role } from '@prisma/client';

export const UserRepository = {
  findById: (id: string) =>
    prisma.user.findUnique({ where: { id } }),

  findByUsername: (username: string) =>
    prisma.user.findUnique({ where: { username } }),

  findByEmail: (email: string) =>
    prisma.user.findUnique({ where: { email } }),

  create: (data: { name: string; email: string | null; username: string; password: string; role: Role; ventanaId?: string | null }) =>
    prisma.user.create({ data }),

  update: (id: string, data: Partial<{ name: string; email: string | null; username: string; password: string; role: Role; ventanaId: string | null; isDeleted: boolean; isActive: boolean }>) =>
    prisma.user.update({ where: { id }, data }),

  async listPaged(args: {
    page: number;
    pageSize: number;
    role?: Role;
    isDeleted?: boolean;
    search?: string;
    select?: Prisma.UserSelect;
    orderBy?: Prisma.UserOrderByWithRelationInput;
  }) {
    const { page, pageSize, role, isDeleted, search, select, orderBy } = args;
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(typeof isDeleted === 'boolean' ? { isDeleted } : { isDeleted: false }),
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
            // relación opcional: usar `is` para filtrar por la entidad relacionada si existe
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
          ventanaId: true, isDeleted: true, createdAt: true, updatedAt: true,
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
