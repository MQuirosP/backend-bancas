import { z } from "zod";

export const VendedorIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateVendedorSchema = z.object({
  // Requeridos
  ventanaId: z.uuid("ventanaId inválido"),
  code: z.string().trim().min(1, "code es obligatorio").max(20),

  // Datos del vendedor
  name: z.string().min(2, "El nombre es obligatorio"),
  username: z.string().min(3).max(12),
  email: z.email("Formato de correo inválido").trim().toLowerCase().optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
}).strict();

export const UpdateVendedorSchema = z.object({
  // Opcionales (puedes cambiar uno u otro)
  ventanaId: z.uuid("ventanaId inválido").optional(),
  code: z.string().trim().min(1).max(20).optional(),

  name: z.string().min(2, "El nombre es obligatorio").optional(),
  username: z.string().min(3).max(12).optional(),
  email: z.email("Formato de correo inválido").optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").optional(),
  isActive: z.boolean().optional(),
}).strict();

export const ListVendedoresQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().min(1).optional(),
  ventanaId: z.uuid("ventanaId inválido").optional(),
}).strict();
