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

// CREATE
export const CreateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_0_999.optional(),
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
})
.strict()
.superRefine((data, ctx) => {
  // al menos uno de los scopes
  if (!data.bancaId && !data.ventanaId && !data.userId) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe indicar bancaId, ventanaId o userId (al menos uno).",
    });
  }
  // al menos uno de los montos
  if (!data.maxAmount && !data.maxTotal) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe definir maxAmount y/o maxTotal.",
    });
  }
});

// UPDATE (parcial)
export const UpdateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_0_999.optional(),
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
}).strict();

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
