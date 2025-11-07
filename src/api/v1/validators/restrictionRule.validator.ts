// src/modules/restrictions/validators/restrictionRule.validator.ts
import { z } from "zod";

// id param
export const RestrictionRuleIdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

// Validación para número individual (00-99 para restricciones de números)
const NUMBER_00_99 = z
  .string()
  .trim()
  .regex(/^\d{2}$/, "number debe ser de 2 dígitos (00-99)")
  .refine((val) => {
    const num = Number(val);
    return num >= 0 && num <= 99;
  }, "number debe estar entre 00 y 99");

// Validación para number: acepta string (legacy) o array de strings
const NUMBER_VALIDATOR = z.union([
  NUMBER_00_99, // string legacy
  z.array(NUMBER_00_99).min(1).max(100), // array de strings
]).refine(
  (val) => {
    // Si es array, validar que no haya duplicados
    if (Array.isArray(val)) {
      const unique = [...new Set(val)];
      return unique.length === val.length;
    }
    return true;
  },
  {
    message: "No se permiten números duplicados en el array",
  }
);

// --- Helpers lógicos ---
const hasScope = (d: any) => !!(d.bancaId || d.ventanaId || d.userId);
const isAmountRule = (d: any) => d.maxAmount != null || d.maxTotal != null;
const isCutoffRule = (d: any) => d.salesCutoffMinutes != null;

// CREATE
export const CreateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_VALIDATOR.optional(),
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  salesCutoffMinutes: z.coerce.number().int().min(0).max(30).optional(),

  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
})
.strict()
.superRefine((data, ctx) => {
  if (!hasScope(data)) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe indicar bancaId, ventanaId o userId (al menos uno).",
    });
  }

  const amount = isAmountRule(data);
  const cutoff = isCutoffRule(data);

  if ((amount ? 1 : 0) + (cutoff ? 1 : 0) !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Defina maxAmount/maxTotal o salesCutoffMinutes (exclusivo).",
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

// UPDATE
// Nota: PATCH solo acepta string (no array) según recomendación del documento
// Si se necesita cambiar múltiples números, eliminar y recrear
export const UpdateRestrictionRuleSchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),

  number: NUMBER_00_99.optional(), // Solo string en PATCH, no array
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

// LIST (query)  ✅ acepta hasAmount / hasCutoff y usa isActive
export const ListRestrictionRuleQuerySchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),
  number: z.string().trim().min(1).optional(),

  isActive: z.coerce.boolean().optional(),     // ← reemplaza isDeleted
  hasCutoff: z.coerce.boolean().optional(),    // ← NUEVO
  hasAmount: z.coerce.boolean().optional(),    // ← NUEVO

  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

// opcional: body para delete/restore
export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
