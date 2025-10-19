import { z } from "zod";

export const VentanaIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateVentanaSchema = z.object({
  bancaId: z.uuid("bancaId inválido (UUID)"),
  name: z.string().min(2, "name debe tener al menos 2 caracteres").max(100),
  code: z.string().min(2, "code debe tener al menos 2 caracteres").max(10),
  isActive: z.boolean().optional(),
  commissionMarginX: z.coerce.number().int("commissionMarginX debe ser entero").min(0, "commissionMarginX debe ser >= 0"),
  address: z.string().max(255).optional().nullable().default(null),
  phone: z.string().max(20).optional().nullable().default(null),
  email: z.email("email inválido").optional().nullable().default(null),
}).strict();

export const UpdateVentanaSchema = CreateVentanaSchema.partial().strict();

// ✅ Agregamos `search` opcional y mantenemos `.strict()` para evitar claves no whitelisteadas
export const ListVentanasQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
