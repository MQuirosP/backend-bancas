// contrato para servicios (sin Zod)
export type CreatePaymentInput = {
  ticketId: string;      // uuid
  amountPaid: number;    // > 0
  method?: string;       // opcional
  notes?: string;        // opcional
  idempotencyKey?: string; // opcional, min 8
};
