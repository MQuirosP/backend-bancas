import { z } from "zod";

export const BancaIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateBancaSchema = z.object({
  name: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres").max(100, "Nombre demasiado largo"),
  code: z.string().trim().min(2, "El código debe tener al menos 2 caracteres").max(20, "Código demasiado largo"),
  email: z.string().email("El correo electrónico no es válido").trim().toLowerCase().optional(),
  address: z.string().trim().max(200, "La dirección es demasiado larga").optional(),
  phone: z.string().trim().max(20, "El teléfono es demasiado largo").optional(),
  isActive: z.coerce.boolean().optional(),
  defaultMinBet: z.coerce.number().positive("La apuesta mínima debe ser mayor a 0").min(1).optional(),
  globalMaxPerNumber: z.coerce.number().positive("El máximo por número debe ser mayor a 0").min(1).optional(),
  salesCutoffMinutes: z.coerce.number().int().positive("Los minutos de cierre deben ser un número positivo").optional(),
  vendorLimit: z.coerce.number().int().nonnegative("El límite de vendedores no puede ser negativo").optional(),
  maxSessionsPerVendedor: z.coerce
    .number()
    .int()
    .min(1, 'Debe permitir al menos 1 sesión por vendedor')
    .max(20, 'El máximo de sesiones por vendedor no puede superar 20')
    .optional(),
  importBaseLoterias: z.coerce.boolean().optional(),
  username: z.string().trim().min(3, "El nombre de usuario debe tener al menos 3 caracteres").max(100).optional(),
  password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres").optional(),
  confirmPassword: z.string().optional(),
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
  isActive: z.coerce.boolean().optional(),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
