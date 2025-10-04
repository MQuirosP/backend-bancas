import { z } from "zod";

export const createLoteriaSchema = z.object({
  name: z
    .string()
    .min(2, "El nombre de la lotería debe tener al menos 2 caracteres"),
  rulesJson: z
    .record(z.string(), z.any())
    .optional()
    .nullable()
    .describe("Configuraciones dinámicas (opcional)"),
});

export const updateLoteriaSchema = z.object({
  name: z
    .string()
    .min(2, "El nombre debe tener al menos 2 caracteres")
    .optional(),
  rulesJson: z.record(z.string(), z.any()).optional().nullable(),
});

export const loteriaIdSchema = z.object({
  id: z.uuid({ message: "ID de lotería inválido" }),
});

export const listLoteriaQuerySchema = z.object({
  page: z.string().optional(),
  pageSize: z.string().optional(),
  isDeleted: z
    .string()
    .optional()
    .refine((val) => val === "true" || val === "false", {
      message: "isDeleted debe ser 'true' o 'false'",
    }),
});
