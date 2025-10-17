import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

const numeroSchema = z
  .string()
  .regex(/^\d{1,2}$/, "Número debe ser 0..99 (uno o dos dígitos)");

const JugadaNumeroSchema = z.object({
  type: z.literal("NUMERO"),
  number: numeroSchema,
  amount: z.number().positive(),
  multiplierId: z.uuid().optional(),
  finalMultiplierX: z.number().optional(),
});

const JugadaReventadoSchema = z.object({
  type: z.literal("REVENTADO"),
  number: numeroSchema, // requerido y debe ser igual a reventadoNumber
  reventadoNumber: numeroSchema,
  amount: z.number().positive(),
});

export const CreateTicketSchema = z
  .object({
    loteriaId: z.uuid("loteriaId inválido"),
    sorteoId: z.uuid("sorteoId inválido"),
    ventanaId: z.uuid("ventanaId inválido").optional(), // hazlo optional si lo infieres por rol
    jugadas: z
      .array(z.union([JugadaNumeroSchema, JugadaReventadoSchema]))
      .min(1),
  })
  .superRefine((val, ctx) => {
    const numeros = new Set(
      val.jugadas.filter((j) => j.type === "NUMERO").map((j) => j.number)
    );

    for (const [i, j] of val.jugadas.entries()) {
      if (j.type === "REVENTADO") {
        if (!numeros.has(j.reventadoNumber)) {
          ctx.addIssue({
            code: "custom",
            path: ["jugadas", i, "reventadoNumber"],
            message: `Debe existir una jugada NUMERO para ${j.reventadoNumber} en el mismo ticket`,
          });
        }
        if (j.number !== j.reventadoNumber) {
          ctx.addIssue({
            code: "custom",
            path: ["jugadas", i, "number"],
            message: `En REVENTADO, ${j.number} debe ser igual a reventadoNumber`,
          });
        }
      }
    }
  });

  export const ListTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["ACTIVE","EVALUATED","CANCELLED","RESTORED"]).optional(),
  isDeleted: z.coerce.boolean().optional(),
  sorteoId: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(), // ✅ unificado
}).strict();

export const validateListTicketsQuery = validateQuery(ListTicketsQuerySchema);
