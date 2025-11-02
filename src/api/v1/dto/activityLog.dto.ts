import { z } from 'zod';
import { ActivityType } from '@prisma/client';

export const listActivityLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().optional().default(10),
  userId: z.string().uuid().optional(),
  action: z.nativeEnum(ActivityType).optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  startDate: z.string().datetime().optional(), // ISO 8601 format
  endDate: z.string().datetime().optional(),
  search: z.string().optional(),
});

export type ListActivityLogsQuery = z.infer<typeof listActivityLogsQuerySchema>;

export const getActivityLogByIdSchema = z.object({
  id: z.string().uuid('ID de registro inválido'),
});

export type GetActivityLogByIdParams = z.infer<typeof getActivityLogByIdSchema>;
