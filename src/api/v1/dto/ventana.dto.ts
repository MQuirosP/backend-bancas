import { z } from "zod";

export const CreateVentanaDto = z.object({
  bancaId: z.uuid("bancaId inválido (UUID)"),
  name: z.string().min(2, "name debe tener al menos 2 caracteres").max(100),
  code: z.string().min(2, "code debe tener al menos 2 caracteres").max(10),
  commissionMarginX: z.number().int("commissionMarginX debe ser entero").nonnegative("commissionMarginX debe ser >= 0"),
  address: z.string().max(255).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email("email inválido").optional(),
}).strict();

export const UpdateVentanaDto = CreateVentanaDto.partial().strict();

export type CreateVentanaInput = z.infer<typeof CreateVentanaDto>;
export type UpdateVentanaInput = z.infer<typeof UpdateVentanaDto>;
