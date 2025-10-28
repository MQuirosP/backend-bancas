// src/modules/tickets/validators/ticket.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

const numeroSchema = z.string().regex(/^\d{1,2}$/, "Número debe ser 0..99 (uno o dos dígitos)");

const JugadaNumeroSchema = z.object({
  type: z.literal("NUMERO"),
  number: numeroSchema,
  amount: z.number().positive(),
  multiplierId: z.uuid().optional(),
  finalMultiplierX: z.number().optional(),
  isActive: z.coerce.boolean().optional(),
});

const JugadaReventadoSchema = z.object({
  type: z.literal("REVENTADO"),
  number: numeroSchema,
  reventadoNumber: numeroSchema,
  amount: z.number().positive(),
});

export const CreateTicketSchema = z
  .object({
    loteriaId: z.uuid("loteriaId inválido"),
    sorteoId: z.uuid("sorteoId inválido"),
    ventanaId: z.uuid("ventanaId inválido").optional(),
    jugadas: z.array(z.union([JugadaNumeroSchema, JugadaReventadoSchema])).min(1),
  }).merge(z.object({ vendedorId: z.string().uuid("vendedorId inválido").optional() }))
  .superRefine((val, ctx) => {
    const numeros = new Set(val.jugadas.filter(j => j.type === "NUMERO").map(j => j.number));
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

export const ListTicketsQuerySchema = z
  .object({
    // Paginación
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),

    // Filtros estándar
    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED", "PAID"]).optional(),
    isActive: z.coerce.boolean().optional(),
    sorteoId: z.uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    scope: z.enum(["mine", "all"]).optional().default("mine"),

    // Filtros de fecha (STANDARDIZADO - mismo patrón que Venta/Dashboard)
    // Fechas: date (today|yesterday|week|month|year|range) + fromDate/toDate (YYYY-MM-DD) cuando date=range
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export const validateListTicketsQuery = validateQuery(ListTicketsQuerySchema);
