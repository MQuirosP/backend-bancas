// contrato para servicios (sin Zod)
export type CreatePaymentInput = {
  ticketId: string;        // uuid
  amountPaid: number;      // > 0
  method?: string;         // opcional: cash|check|transfer|system
  notes?: string;          // opcional
  isFinal?: boolean;       // opcional, marks partial as final
  idempotencyKey?: string; // opcional, min 8
};
