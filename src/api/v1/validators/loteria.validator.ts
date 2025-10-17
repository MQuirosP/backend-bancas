import { z } from "zod";

export const createLoteriaSchema = z.object({
  name: z.string().min(2, "El nombre de la lotería debe tener al menos 2 caracteres"),
  rulesJson: z.record(z.string(), z.any()).optional().nullable(),
}).strict();

export const updateLoteriaSchema = z.object({
  name: z.string().min(2, "El nombre debe tener al menos 2 caracteres").optional(),
  rulesJson: z.record(z.string(), z.any()).optional().nullable(),
}).strict();

export const loteriaIdSchema = z.object({
  id: z.uuid({ message: "ID de lotería inválido" }),
}).strict();

export const listLoteriaQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  isDeleted: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(100).optional(),
}).strict();
