import { z } from "zod";
import {
  CreateRestrictionRuleDTO,
  UpdateRestrictionRuleDTO,
} from "../dto/restrictionRule.dto";

export const createRestrictionRuleSchema = CreateRestrictionRuleDTO.refine(
  (data) => !!(data.bancaId || data.ventanaId || data.userId),
  { message: "Debe indicar bancaId, ventanaId o userId (al menos uno)." }
).refine((data) => !!(data.maxAmount || data.maxTotal), {
  message: "Debe definir maxAmount y/o maxTotal.",
});

export const updateRestrictionRuleSchema = UpdateRestrictionRuleDTO;

export const listRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),
  number: z.string().min(1).optional(),
  isDeleted: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
