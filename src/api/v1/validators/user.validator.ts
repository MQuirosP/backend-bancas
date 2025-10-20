import { z } from "zod";
import { is } from "zod/locales";

const emailOptional = z.preprocess(
  (v) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.email().trim().toLowerCase().nullable().optional()
);

const emailOptionalUpdate = z.preprocess(
  (v) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.email().trim().toLowerCase().nullable().optional()
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
  email: emailOptionalUpdate,
  username: z.string().trim().min(3).max(32).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  code: z.string().trim().min(2).max(32).nullable().optional(),
}).strict();

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  search: z.string().trim().optional().transform(v => (v && v.length > 0 ? v : undefined)),
}).strict();
