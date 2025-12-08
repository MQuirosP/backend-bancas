// src/api/v1/validators/accountStatementSettlement.validator.ts
import { z } from 'zod';

export const UpdateAccountStatementSettlementConfigSchema = z.object({
  enabled: z.boolean().optional(),
  settlementAgeDays: z.number().int().min(1).max(365).optional(),
  cronSchedule: z.string().nullable().optional(),
  batchSize: z.number().int().min(100).max(10000).optional(),
}).strict();

