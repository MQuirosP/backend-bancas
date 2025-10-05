import { z } from "zod";

export const CreateVentanaDto = z.object({
    bancaId: z.uuid("bancaId must be a valid UUID"),
    name: z.string().min(2, "El nombre es obligatorio").max(100),
    code: z.string().min(2, "El código es obligatorio").max(10),
    commissionMarginX: z.number().min(0).positive("El margen debe ser un número positivo"),
    address: z.string().max(255).optional(),
    phone: z.string().max(20).optional(),
    email: z.email().optional(),
});

export const UpdateVentanaDto = CreateVentanaDto.partial();

export type CreateVentanaInput = z.infer<typeof CreateVentanaDto>;
export type UpdateVentanaInput = z.infer<typeof UpdateVentanaDto>;