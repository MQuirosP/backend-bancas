import { z } from "zod";

export const MultiplierKind = z.enum(["NUMERO", "REVENTADO"]);

export const CreateMultiplierDTO = z.object({
    loteriaId: z.uuid(),
    name: z.string().min(2).max(32),
    valueX: z.number().positive(),
    kind: MultiplierKind.default("NUMERO"),
    appliesToDate: z.date().optional().nullable(),
    appliesToSorteoId: z.uuid().optional().nullable(),
    isActive: z.boolean().optional().default(true),
});

export const UpdateMultiplierDTO = z.object({
    name: z.string().min(2).max(32).optional(),
    valueX: z.number().positive().optional(),
    kind: MultiplierKind.optional(),
    appliesToDate: z.date().optional().nullable(),
    appliesToSorteoId: z.uuid().optional().nullable(),
    isActive: z.boolean().optional()
})

export const ListMultiplierQuery = z.object({
    loteriaId: z.uuid().optional(),
    kind: MultiplierKind.optional(),
    isActive: z.coerce.boolean().optional(),
    appliesToSorteoId: z.uuid().optional(),
    q: z.string().optional(),
    page: z.coerce.number().int().min(1).max(100).default(20),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
})