import { z } from 'zod';

export const createUserSchema = z.object({
  name: z.string().min(2, 'Name is too short'),
  email: z.string().email('Invalid email'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
  ventanaId: z.string().uuid('Invalid ventanaId').optional(),
});

export const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
  ventanaId: z.string().uuid('Invalid ventanaId').optional().nullable(),
});

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
  role: z.enum(['ADMIN', 'VENTANA', 'VENDEDOR']).optional(),
  isDeleted: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .optional(),
});
