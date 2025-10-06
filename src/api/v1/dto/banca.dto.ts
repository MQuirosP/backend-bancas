import { z } from "zod";

// Evitamos depracated de zod: validamos email con reguex

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CreateBancaDto = z.object({
  name: z.string().min(2, "El nombre es obligatorio").max(100),
  code: z.string().min(2, "El código es obligatorio").max(20),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(5)
    .max(100)
    .regex(EMAIL_REGEX, "El email no es válido")
    .optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
  defaultMinBet: z.number().min(100).positive().optional(),
  globalMaxPerNumber: z.number().min(1000).positive().optional(),
});

export const UpdateBancaDto = CreateBancaDto.partial();

export type CreateBancaInput = z.infer<typeof CreateBancaDto>;
export type UpdateBancaInput = z.infer<typeof UpdateBancaDto>;


