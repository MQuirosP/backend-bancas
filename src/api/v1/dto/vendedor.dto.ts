import { z } from "zod";

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CreateVendedorDto = z.object({
  ventanaId: z.string().regex(UUID_V4, "ventanaId inválido"),
  name: z.string().min(2, "El nombre es obligatorio"),
  username: z.string().min(3).max(12),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Formato de correo inválido").optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
});

export const UpdateVendedorDto = z.object({
  ventanaId: z.string().regex(UUID_V4, "ventanaId inválido").optional(),
  name: z.string().min(2, "El nombre es obligatorio").optional(),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Formato de correo inválido").optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").optional(),
});

export type CreateVendedorInput = z.infer<typeof CreateVendedorDto>;
export type UpdateVendedorInput = z.infer<typeof UpdateVendedorDto>;
