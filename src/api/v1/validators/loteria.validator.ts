import { z } from "zod";

export const createLoteriaSchema = z.object({
  name: z.string().min(2, "El nombre de la lotería debe tener al menos 2 caracteres"),
  rulesJson: z.record(z.string(), z.any()).optional().nullable(),
  isActive: z.boolean().optional(),
}).strict();

export const updateLoteriaSchema = z.object({
  name: z.string().min(2, "El nombre debe tener al menos 2 caracteres").optional(),
  rulesJson: z.record(z.string(), z.any()).optional().nullable(),
  isActive: z.boolean().optional(),
}).strict();

export const loteriaIdSchema = z.object({
  id: z.uuid({ message: "ID de lotería inválido" }),
}).strict();

export const listLoteriaQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

export const previewScheduleQuerySchema = z.object({
  start: z.coerce.date().optional(),             // ISO opcional; default = ahora
  days: z.coerce.number().int().min(1).max(31).optional(),   // default 1
  limit: z.coerce.number().int().min(1).max(1000).optional(), // top 200 por default
  allowPast: z.enum(["true", "false"]).optional(), //  NUEVO: permitir fechas pasadas
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

// Body para seed_sorteos: subset de fechas específicas (ISO). Opcional.
// Permite body vacío {}, undefined o con scheduledDates opcional
export const seedSorteosBodySchema = z
  .object({
    scheduledDates: z
      .array(
        z.preprocess((v) => (typeof v === 'string' || v instanceof Date ? new Date(v as any) : v), z.date())
      )
      .optional(),
  })
  .passthrough(); // Permite campos adicionales pero valida scheduledDates si viene

