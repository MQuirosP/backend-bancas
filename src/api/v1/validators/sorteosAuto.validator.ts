// src/api/v1/validators/sorteosAuto.validator.ts
import { z } from 'zod';

export const UpdateSorteosAutoConfigSchema = z.object({
  autoOpenEnabled: z.boolean().optional(),
  autoCreateEnabled: z.boolean().optional(),
  openCronSchedule: z.string().nullable().optional(),
  createCronSchedule: z.string().nullable().optional(),
}).strict();

export const ExecuteAutoOpenQuerySchema = z.object({
  dryRun: z.enum(['true', 'false']).optional().transform(val => val === 'true'),
}).strict();

export const ExecuteAutoCreateQuerySchema = z.object({
  daysAhead: z.coerce.number().int().min(1).max(30).optional().default(7),
  dryRun: z.enum(['true', 'false']).optional().transform(val => val === 'true'),
}).strict();

