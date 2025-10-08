import { z } from "zod";


export const CreateRestrictionRuleDTO = z.object({
bancaId: z.uuid().optional(),
ventanaId: z.uuid().optional(),
userId: z.uuid().optional(),
number: z.string().trim().min(1).max(3).optional(), // "0".."999"
maxAmount: z.number().positive().optional(),
maxTotal: z.number().positive().optional(),
appliesToDate: z.coerce.date().optional(),
appliesToHour: z.number().int().min(0).max(23).optional(),
});


export const UpdateRestrictionRuleDTO = CreateRestrictionRuleDTO.partial();


export type CreateRestrictionRuleInput = z.infer<typeof CreateRestrictionRuleDTO>;
export type UpdateRestrictionRuleInput = z.infer<typeof UpdateRestrictionRuleDTO>;