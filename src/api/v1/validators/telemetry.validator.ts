import { z } from "zod";

export const TelemetryPayloadSchema = z.object({
  event: z.string().min(1, "El nombre del evento es requerido"),
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
  metadata: z.record(z.string(), z.any()).optional(),
});
