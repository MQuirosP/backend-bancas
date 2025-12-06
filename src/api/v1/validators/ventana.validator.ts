import { z } from "zod";

const emptyToNull = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
};

const bluetoothMacRegex = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const bluetoothMacCompactRegex = /^[0-9A-Fa-f]{8}$/;

const PrintSettingsSchema = z
  .object({
    name: z.string().trim().max(100).nullable().optional(),
    phone: z.string().trim().max(32).nullable().optional(),
    width: z.union([z.literal(58), z.literal(88)]).nullable().optional(),
    footer: z.string().trim().max(200).nullable().optional(),
    barcode: z.boolean().nullable().optional(),
    bluetoothMacAddress: z
      .string()
      .trim()
      .nullable()
      .optional()
      .refine(
        (value) => !value || bluetoothMacRegex.test(value) || bluetoothMacCompactRegex.test(value),
        "Formato inválido. Usa AA:BB:CC:DD:EE:FF o AABBCCDD"
      ),
  })
  .strict();

const VentanaSettingsSchema = z
  .object({
    print: PrintSettingsSchema.optional(),
    theme: z.enum(["light", "dark"]).nullable().optional(),
  })
  .strict();

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
      .transform(emptyToNull),
    phone: z
      .string()
      .trim()
      .max(20)
      .optional()
      .nullable()
      .transform(emptyToNull),
    email: z
      .email("email inválido")
      .trim()
      .optional()
      .nullable()
      .transform((v) => (v === "" ? null : (v ?? null))),
    settings: VentanaSettingsSchema.nullable().optional(),
    // ✅ NUEVOS CAMPOS requeridos para creación de usuario
    username: z
      .string()
      .trim()
      .min(3, "username debe tener al menos 3 caracteres")
      .max(100, "username debe tener máximo 100 caracteres")
      .regex(/^[a-zA-Z0-9_-]+$/, "username solo puede contener letras, números, guiones bajos y guiones"),
    password: z
      .string()
      .min(6, "La contraseña debe tener al menos 6 caracteres"),
  })
  .strict();

export const UpdateVentanaSchema = CreateVentanaSchema.partial()
  .extend({
    // ✅ Campos opcionales para actualizar usuario asociado
    username: z
      .string()
      .trim()
      .min(3, "username debe tener al menos 3 caracteres")
      .max(100, "username debe tener máximo 100 caracteres")
      .regex(/^[a-zA-Z0-9_-]+$/, "username solo puede contener letras, números, guiones bajos y guiones")
      .optional(),
    password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres").optional(),
  })
  .strict();

// Query: coaccionamos números y boolean para aceptar strings ("1","true", etc.)
export const ListVentanasQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    isActive: z.coerce.boolean().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
    // si más adelante agregas bancaId como filtro:
    // bancaId: z.string().uuid().optional(),
  })
  .strict();

export const ReasonBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(200).optional(),
  })
  .strict();
