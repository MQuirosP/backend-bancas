import { z } from "zod";

// número 0..99 (permite "0","00","7","07","99")
const numeroSchema = z
  .string()
  .regex(/^\d{1,2}$/, "Número debe ser 0..99 (uno o dos dígitos)");

const JugadaNumeroSchema = z.object({
  type: z.literal("NUMERO").default("NUMERO"),
  number: numeroSchema,
  amount: z.number().positive(),
  // multiplierId lo resuelve el backend; no lo pedimos al cliente
});

const JugadaReventadoSchema = z.object({
  type: z.literal("REVENTADO"),
  number: numeroSchema,
  amount: z.number().positive(),
  reventadoNumber: numeroSchema, // debe ser igual al number
});

export const CreateTicketSchema = z
  .object({
    loteriaId: z.uuid({ message: "loteriaId inválido" }),
    sorteoId: z.uuid({ message: "sorteoId inválido" }),
    ventanaId: z.uuid({ message: "ventanaId inválido" }),
    jugadas: z
      .array(z.union([JugadaNumeroSchema, JugadaReventadoSchema]))
      .min(1),
  })
  .superRefine((val, ctx) => {
    // REVENTADO debe referenciar el mismo número y existir una jugada NUMERO de ese número
    const numeros = new Set(
      val.jugadas
        .filter((j: any) => j.type === "NUMERO")
        .map((j: any) => j.number)
    );

    for (const j of val.jugadas) {
      if (j.type === "REVENTADO") {
        if (j.reventadoNumber !== j.number) {
          ctx.addIssue({
            code: "custom",
            path: ["jugadas"],
            message: `REVENTADO debe referenciar el mismo número (${j.number})`,
          });
        }
        if (!numeros.has(j.number)) {
          ctx.addIssue({
            code: "custom",
            path: ["jugadas"],
            message: `Debe existir una jugada NUMERO para ${j.number} en el mismo ticket`,
          });
        }
      }
    }
  });
