import { z } from "zod";

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().optional(),
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.string().uuid().optional(), // unificado
}).strict();

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  username: z.string().trim().min(3).max(32).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.string().uuid().nullable().optional(),
  isDeleted: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  isDeleted: z.coerce.boolean().optional(),
  // tolerante a vacío: ?search=  -> undefined (no rompe)
  search: z.string().trim().optional().transform(v => (v && v.length > 0 ? v : undefined)),
}).strict();
