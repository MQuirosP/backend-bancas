import { z } from "zod";

// Username: min 3, empieza con letra, luego letras/dígitos/.-
const usernameRegex = /^[a-z][a-z0-9.-]{2,31}$/i;

export const registerSchema = z
  .object({
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
    // Public registration only allows VENTANA/VENDEDOR (not ADMIN)
    role: z.enum(["VENTANA", "VENDEDOR"]).optional(),
    // ventanaId es requerido para VENTANA/VENDEDOR roles
    ventanaId: z.uuid("ventanaId inválido").nullable().optional(),
  })
  .superRefine((val, ctx) => {
    // Public registration defaults to VENTANA if no role specified
    const role = val.role ?? "VENTANA";

    // ventanaId is always required for public registration (no ADMIN allowed)
    if (!val.ventanaId || typeof val.ventanaId !== "string" || val.ventanaId.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["ventanaId"],
        message: "Selecciona una ventana",
      });
    }
  })
  .strict();

// Login acepta username o email en "identifier"
export const loginSchema = z.object({
  username: z.string().min(1, "username is required"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters long")
    .max(100, "Password must be at most 100 characters long"),
  platform: z.enum(['web', 'android', 'ios']).optional(),  // Opcional: Plataforma del cliente
  appVersion: z.string().max(50, "appVersion must be at most 50 characters long").optional(),  // Opcional: Versión de la app
  // Campos para tracking de dispositivos (multi-dispositivo)
  deviceId: z.string().max(255).optional(),    // UUID persistente generado por el cliente
  deviceName: z.string().max(255).optional(),  // Nombre legible: "Chrome · Windows", "Samsung Galaxy S23"
});

// Schema para establecer banca activa
export const setActiveBancaSchema = z.object({
  bancaId: z.string().uuid('bancaId debe ser un UUID válido'),
});
