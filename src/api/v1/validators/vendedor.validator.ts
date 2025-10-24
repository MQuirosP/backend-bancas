import { z } from "zod";

export const VendedorIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateVendedorSchema = z.object({
  ventanaId: z.uuid("ventanaId inválido"),
  code: z.string().trim().min(1, "code es obligatorio").max(20),

  name: z.string().min(2, "El nombre es obligatorio"),
  username: z.string().min(3).max(12),
  email: z.email("Formato de correo inválido").trim().toLowerCase().optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
}).strict();

export const UpdateVendedorSchema = z.object({
  ventanaId: z.uuid("ventanaId inválido").optional(),
  // code/username/role se marcan como prohibidos para update desde este módulo:
  code: z.never({ message: "code no puede modificarse en vendedores" }).optional(),
  username: z.never({ message: "username no puede modificarse en vendedores" }).optional(),
  // role tampoco se toca desde aquí
  name: z.string().min(2, "El nombre es obligatorio").optional(),
  email: z.email("Formato de correo inválido").trim().toLowerCase().optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").optional(),
  isActive: z.boolean().optional(),
}).strict();

export const ListVendedoresQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().min(1).optional(),
  ventanaId: z.uuid("ventanaId inválido").optional(),
}).strict();
