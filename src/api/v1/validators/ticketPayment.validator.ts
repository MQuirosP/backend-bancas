import { z } from "zod";

export const TicketPaymentIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreatePaymentSchema = z.object({
  ticketId: z.uuid("ticketId inválido"),
  amountPaid: z.coerce.number().positive("amountPaid debe ser > 0"), // acepta string numérico
  method: z.string().trim().min(1).max(50).optional(),
  notes: z.string().trim().max(300).optional(),
  idempotencyKey: z.string().min(8, "idempotencyKey debe tener al menos 8 caracteres").optional(),
}).strict();

export const ListPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
