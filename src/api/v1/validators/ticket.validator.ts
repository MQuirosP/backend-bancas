import { z } from "zod";

const numeroSchema = z.string().regex(/^\d{1,2}$/, "Número debe ser 0..99 (uno o dos dígitos)");

const JugadaNumeroSchema = z.object({
  type: z.literal("NUMERO"),
  number: numeroSchema,
  amount: z.number().positive(),
});

const JugadaReventadoSchema = z.object({
  type: z.literal("REVENTADO"),
  reventadoNumber: numeroSchema,
  amount: z.number().positive(),
});

export const CreateTicketSchema = z.object({
  loteriaId: z.uuid("loteriaId inválido"),
  sorteoId: z.uuid("sorteoId inválido"),
  ventanaId: z.uuid("ventanaId inválido").optional(), // hazlo optional si lo infieres por rol
  jugadas: z.array(z.union([JugadaNumeroSchema, JugadaReventadoSchema])).min(1),
}).superRefine((val, ctx) => {
  const numeros = new Set(
    val.jugadas.filter(j => j.type === "NUMERO").map(j => j.number)
  );
  for (const j of val.jugadas) {
    if (j.type === "REVENTADO" && !numeros.has(j.reventadoNumber)) {
      ctx.addIssue({
        code: "custom",
        path: ["jugadas"],
        message: `Debe existir una jugada NUMERO para ${j.reventadoNumber} en el mismo ticket`,
      });
    }
  }
});
