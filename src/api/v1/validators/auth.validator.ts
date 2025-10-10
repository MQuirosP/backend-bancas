import { z } from "zod";

// Username: min 3, empieza con letra, luego letras/dígitos/.-
const usernameRegex = /^[a-z][a-z0-9.-]{2,31}$/i;

export const registerSchema = z.object({
  username: z
    .string()
    .regex(usernameRegex, "Invalid username format (e.g. adm.sys.root)"),
  name: z.string().min(2, "Name is too short").max(100, "Name is too long"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters long")
    .max(100, "Password must be at most 100 characters long"),
  // email ahora es opcional
  email: z.string().email("Invalid email address").optional(),
  role: z.enum(["ADMIN", "VENTANA", "VENDEDOR"]).optional(),
});

// Login acepta username o email en "identifier"
export const loginSchema = z.object({
  username: z.string().min(1, "username is required"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters long")
    .max(100, "Password must be at most 100 characters long"),
});
