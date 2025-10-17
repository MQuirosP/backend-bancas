import { z } from "zod";

export const BancaIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateBancaSchema = z.object({
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().min(2).max(20),
  email: z.string().trim().toLowerCase().email("email inválido").optional(),
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  isActive: z.coerce.boolean().optional(),
  defaultMinBet: z.coerce.number().positive().min(1).optional(),
  globalMaxPerNumber: z.coerce.number().positive().min(1).optional(),
  salesCutoffMinutes: z.coerce.number().int().positive().optional(),
}).strict();

export const UpdateBancaSchema = CreateBancaSchema.partial().strict();

export const ListBancasQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z
      .string()
      .trim()
      .min(2, 'Escribe al menos 2 caracteres')
      .max(100, 'Máximo 100 caracteres')
      .optional(),
}).strict();

export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
