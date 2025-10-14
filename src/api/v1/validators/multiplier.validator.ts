import { z } from "zod";

export const MultiplierKindSchema = z.enum(["NUMERO", "REVENTADO"]);

export const MultiplierIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateMultiplierSchema = z.object({
  loteriaId: z.uuid("loteriaId inválido"),
  name: z.string().min(2).max(32),
  valueX: z.coerce.number().positive(),                 // tolera string numérico
  kind: MultiplierKindSchema.default("NUMERO"),
  appliesToDate: z.coerce.date().nullable().optional(), // ISO -> Date
  appliesToSorteoId: z.uuid().nullable().optional(),
  isActive: z.coerce.boolean().default(true).optional(),
}).strict();

export const UpdateMultiplierSchema = z.object({
  name: z.string().min(2).max(32).optional(),
  valueX: z.coerce.number().positive().optional(),
  kind: MultiplierKindSchema.optional(),
  appliesToDate: z.coerce.date().nullable().optional(),
  appliesToSorteoId: z.uuid().nullable().optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const ListMultipliersQuerySchema = z.object({
  loteriaId: z.uuid("loteriaId inválido").optional(),
  kind: MultiplierKindSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  appliesToSorteoId: z.uuid("appliesToSorteoId inválido").optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const ToggleMultiplierSchema = z.object({
  isActive: z.coerce.boolean(),
}).strict();
