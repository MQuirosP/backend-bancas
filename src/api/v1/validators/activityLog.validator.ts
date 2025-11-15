import { z } from 'zod';
import { ActivityType } from '@prisma/client';

export const listActivityLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
  userId: z.string().uuid().optional(),
  action: z.nativeEnum(ActivityType).optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  search: z.string().min(1).optional(),
});

export const getActivityLogByIdParamSchema = z.object({
  id: z.string().uuid('ID de registro inválido'),
});

export const getByUserParamSchema = z.object({
  userId: z.string().uuid('ID de usuario inválido'),
});

export const getByTargetParamSchema = z.object({
  targetType: z.string().min(1),
  targetId: z.string(),
});

export const getByActionParamSchema = z.object({
  action: z.nativeEnum(ActivityType),
});

export const cleanupLogsBodySchema = z.object({
  days: z.number().int().positive().optional().default(45),
});
