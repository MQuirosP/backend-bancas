import { z } from "zod";

export const VentanaIdParamSchema = z
  .object({
    id: z.string().uuid("id inválido (UUID)"),
  })
  .strict();

export const CreateVentanaSchema = z
  .object({
    bancaId: z.uuid("bancaId inválido (UUID)"),
    name: z
      .string()
      .trim()
      .min(2, "name debe tener al menos 2 caracteres")
      .max(100),
    code: z
      .string()
      .trim()
      .min(2, "code debe tener al menos 2 caracteres")
      .max(10)
      .optional()
      .nullable()
      .transform((v) => (v === "" ? null : (v ?? null))),
    isActive: z.coerce.boolean().default(true).optional(),
    commissionMarginX: z.coerce
      .number()
      .min(0, "commissionMarginX debe ser >= 0")
      .optional()
      .nullable()
      .transform((v) => (v === undefined ? null : v)),
    address: z
      .string()
      .trim()
      .max(255)
      .optional()
      .nullable()
      .transform((v) => (v === "" ? null : (v ?? null))),
    phone: z
      .string()
      .trim()
      .max(20)
      .optional()
      .nullable()
      .transform((v) => (v === "" ? null : (v ?? null))),
    email: z
      .email("email inválido")
      .trim()
      .optional()
      .nullable()
      .transform((v) => (v === "" ? null : (v ?? null))),
  })
  .strict();

export const UpdateVentanaSchema = CreateVentanaSchema.partial().strict();

// Query: coaccionamos números y boolean para aceptar strings ("1","true", etc.)
export const ListVentanasQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    isActive: z.coerce.boolean().optional(),
    // si más adelante agregas bancaId como filtro:
    // bancaId: z.string().uuid().optional(),
  })
  .strict();

export const ReasonBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(200).optional(),
  })
  .strict();
