import { z } from "zod";

// id param
export const RestrictionRuleIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

// helper: number 0..999 exacto (string)
const NUMBER_0_999 = z
  .string()
  .trim()
  .regex(/^\d{1,3}$/, "number debe ser un entero de 1 a 3 dígitos (0..999)");

// --- Helpers lógicos ---
const hasScope = (d: any) => !!(d.bancaId || d.ventanaId || d.userId);
const isAmountRule = (d: any) => d.maxAmount != null || d.maxTotal != null;
const isCutoffRule = (d: any) => d.salesCutoffMinutes != null;

// CREATE: scope requerido + (montos XOR cutoff) + si cutoff => sin number
export const CreateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_0_999.optional(), // solo sentido para reglas de monto
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  salesCutoffMinutes: z.coerce.number().int().min(0).max(30).optional(),

  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
})
.strict()
.superRefine((data, ctx) => {
  // 1) Alcance: al menos uno
  if (!hasScope(data)) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe indicar bancaId, ventanaId o userId (al menos uno).",
    });
  }

  const amount = isAmountRule(data);
  const cutoff = isCutoffRule(data);

  // 2) Debe ser exactamente uno de los dos tipos de regla
  if ((amount ? 1 : 0) + (cutoff ? 1 : 0) !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Defina maxAmount/maxTotal o salesCutoffMinutes (exclusivo).",
    });
  }

  // 3) Si es cutoff, number NO debe venir
  if (cutoff && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Para salesCutoffMinutes, number debe omitirse.",
    });
  }
});

// UPDATE: parcial, pero si mandan campos conflictivos, marcar
export const UpdateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_0_999.optional(),
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  salesCutoffMinutes: z.coerce.number().int().min(0).max(30).optional(),

  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
})
.strict()
.superRefine((data, ctx) => {
  const amount = isAmountRule(data);
  const cutoff = isCutoffRule(data);

  // En update no exigimos scope (puede heredar del existente),
  // pero sí evitamos combinaciones inválidas si las envían:
  if (amount && cutoff) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "No puede enviar salesCutoffMinutes junto con maxAmount/maxTotal.",
    });
  }
  if (cutoff && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Para salesCutoffMinutes, number debe omitirse.",
    });
  }
});

// LIST (query)
export const ListRestrictionRuleQuerySchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),
  number: z.string().trim().min(1).optional(),
  isDeleted: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

// opcional: body para delete/restore que acepten "reason"
export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
