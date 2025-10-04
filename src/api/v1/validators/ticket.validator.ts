import { z } from 'zod';

export const createTicketSchema = z.object({
  loteriaId: z.uuid(),
  ventanaId: z.uuid(),
  jugadas: z.array(
    z.object({
      number: z.string().min(1),
      amount: z.number().positive(),
      multiplierId: z.uuid(),
    })
  ).min(1),
});
