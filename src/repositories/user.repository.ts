// src/repositories/user.repository.ts
import prisma from '../core/prismaClient';
import { Role } from '@prisma/client';

export const UserRepository = {
  findById: (id: string) =>
    prisma.user.findUnique({ where: { id } }),

  findByEmail: (username: string) =>
    prisma.user.findUnique({ where: { username } }),

  create: (data: { name: string; email: string; username: string, password: string; role: Role; ventanaId: string }) =>
    prisma.user.create({ data }),

  update: (id: string, data: Partial<{ name: string; email: string; password: string; role: Role; ventanaId: string; isDeleted: boolean, isActive: boolean }>) =>
    prisma.user.update({ where: { id }, data }),

  list: (args: {
    where?: any;
    skip?: number;
    take?: number;
    select?: any;
    orderBy?: any;
  }) => prisma.user.findMany(args),

  count: (where?: any) => prisma.user.count({ where }),
};

export default UserRepository;
