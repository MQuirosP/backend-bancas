// validators/user.validator.ts
import { z } from "zod";

const emailOptional = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().toLowerCase().email().optional()
);

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: emailOptional,                           // 👈 aquí
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.uuid().optional(),
  code: z.string().trim().min(2).max(32).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: emailOptional,                           // 👈 aquí también
  username: z.string().trim().min(3).max(32).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(["ADMIN","VENTANA","VENDEDOR"]).optional(),
  ventanaId: z.uuid().nullable().optional(),
  isDeleted: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).strict();
