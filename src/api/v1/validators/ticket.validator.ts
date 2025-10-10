import { z } from 'zod';

export const JugadaCreateSchema = z.object({
  type: z.enum(["NUMERO", "REVENTADO"]).default("NUMERO"),
  number: z.string().min(1),             // "00".."99" (valida tu formato si quieres)
  amount: z.number().positive(),
  multiplierId: z.string().min(1),       // requerido por el schema (ver nota abajo)
  // solo si es reventado
  reventadoNumber: z.string().optional(),
});

export const CreateTicketSchema = z.object({
  loteriaId: z.uuid().nonempty("No registra loteriaId"),
  sorteoId: z.uuid().nonempty("No registra sorteoId"),
  ventanaId: z.uuid().nonempty("No registra ventanaId"),
  vendedorId: z.uuid().nonempty("No registra vendedorId"),
  jugadas: z.array(JugadaCreateSchema).min(1),
}).superRefine((val, ctx) => {
  // Regla: reventado solo del mismo número del ticket
  // para evitar "reventados sueltos"
  const nums = new Set(val.jugadas.filter(j => j.type === "NUMERO").map(j => j.number));
  for (const j of val.jugadas) {
    if (j.type === "REVENTADO") {
      if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
        ctx.addIssue({
          code: "custom",
          path: ["jugadas"],
          message: `REVENTADO debe referenciar el mismo número ${j.reventadoNumber === j.number}`,
        })
      }
      if (!nums.has(j.number)) {
        ctx.addIssue({
          code: "custom",
          path: ["jugadas"],
          message: `Debe existir una jugada NUMERO para el ${j.number} en el mismo ticket`
        });
      }
    }
  }
});
