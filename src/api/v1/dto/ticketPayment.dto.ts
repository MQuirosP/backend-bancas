import { z } from "zod";

export const CreatePaymentDTO = z.object({
  ticketId: z.uuid(),
  amountPaid: z.number().positive(),
  method: z.string().optional(),
  notes: z.string().optional(),
  idempotencyKey: z.string().min(8).optional(), // para evitar doble pago
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentDTO>;
