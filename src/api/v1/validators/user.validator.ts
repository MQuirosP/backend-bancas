import { z } from "zod";

const emailOptional = z.preprocess(
  (v) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.string().trim().toLowerCase().email().optional()
);

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailOptional, // 👈 aquí
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.uuid().optional(),
  code: z.string().trim().min(2).max(32).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.email().trim().toLowerCase().optional(),
  username: z.string().trim().min(3).max(32).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.uuid().nullable().optional(),
  isDeleted: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  isDeleted: z.coerce.boolean().optional(),
  search: z.string().trim().optional().transform(v => (v && v.length > 0 ? v : undefined)),
}).strict();
