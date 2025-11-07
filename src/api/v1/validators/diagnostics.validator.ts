import { z } from "zod";

export const CutoffInspectQuerySchema = z
  .object({
    userId: z.uuid().optional(),
    ventanaId: z.uuid(),
    sorteoId: z.uuid(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();
