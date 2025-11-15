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
const isLotteryMultiplierRule = (d: any) => d.loteriaId != null || d.multiplierId != null;

// CREATE
export const CreateRestrictionRuleSchema = z
  .object({
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    userId: z.uuid().optional(),

    restrictionType: z.string().optional(),

    isAutoDate: z.coerce.boolean().optional(), // Si true, number se actualiza automáticamente al día del mes
    number: NUMBER_VALIDATOR.optional(),
    maxAmount: z.coerce.number().positive().optional(),
    maxTotal: z.coerce.number().positive().optional(),
    baseAmount: z.coerce.number().nonnegative().optional(), // Monto base (>= 0)
    salesPercentage: z.coerce.number().min(0).max(100).optional(), // Porcentaje 0-100
    appliesToVendedor: z.coerce.boolean().optional(), // Si aplica por vendedor
    salesCutoffMinutes: z.coerce.number().int().min(0).max(30).optional(),

    appliesToDate: z.coerce.date().optional(),
    appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
    loteriaId: z.uuid().optional(),
    multiplierId: z.uuid().optional(),
    message: z.string().trim().min(1).max(255).optional(),
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
  const lotteryMult = isLotteryMultiplierRule(data);

  const totalKinds = (amount ? 1 : 0) + (cutoff ? 1 : 0) + (lotteryMult ? 1 : 0);
  if (totalKinds !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe definir exactamente un tipo de restricción: montos, cutoff o lotería/multiplicador.",
    });
  }

  if (cutoff && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Para salesCutoffMinutes, number debe omitirse.",
    });
  }

  if (lotteryMult) {
    if (!data.loteriaId || !data.multiplierId) {
      ctx.addIssue({
        code: "custom",
        path: ["(root)"],
        message: "Para restringir por lotería/multiplicador debe indicar loteriaId y multiplierId.",
      });
    }
    if (amount || cutoff) {
      ctx.addIssue({
        code: "custom",
        path: ["(root)"],
        message: "No puede combinar lotería/multiplicador con montos o cutoff en la misma regla.",
      });
    }
    if (data.number != null) {
      ctx.addIssue({
        code: "custom",
        path: ["number"],
        message: "Las reglas de lotería/multiplicador no aceptan el campo number.",
      });
    }
    if (data.isAutoDate) {
      ctx.addIssue({
        code: "custom",
        path: ["isAutoDate"],
        message: "Las reglas de lotería/multiplicador no pueden usar isAutoDate.",
      });
    }
  }

  // Validación: isAutoDate solo puede usarse con restricciones de montos (amount)
  if (data.isAutoDate && !amount) {
    ctx.addIssue({
      code: "custom",
      path: ["isAutoDate"],
      message: "isAutoDate solo puede usarse con restricciones de montos (maxAmount o maxTotal).",
    });
  }

  // Validación: si isAutoDate es true, number debe ser null o no especificarse
  if (data.isAutoDate && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Si isAutoDate es true, number debe omitirse (se actualiza automáticamente al día del mes).",
    });
  }

  // Validaciones para porcentaje de ventas
  const hasPercentageFields = data.baseAmount != null || data.salesPercentage != null;
  
  if (hasPercentageFields && !amount) {
    ctx.addIssue({
      code: "custom",
      path: ["baseAmount"],
      message: "baseAmount y salesPercentage solo pueden usarse con restricciones de montos (maxAmount o maxTotal).",
    });
  }

  if (data.salesPercentage != null && (data.salesPercentage < 0 || data.salesPercentage > 100)) {
    ctx.addIssue({
      code: "custom",
      path: ["salesPercentage"],
      message: "salesPercentage debe estar entre 0 y 100.",
    });
  }

  if (data.baseAmount != null && data.baseAmount < 0) {
    ctx.addIssue({
      code: "custom",
      path: ["baseAmount"],
      message: "baseAmount debe ser mayor o igual a 0.",
    });
  }

  if (data.appliesToVendedor && data.salesPercentage == null) {
    ctx.addIssue({
      code: "custom",
      path: ["appliesToVendedor"],
      message: "appliesToVendedor solo tiene sentido cuando salesPercentage está presente.",
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

  restrictionType: z.string().optional(),

  isActive: z.coerce.boolean().optional(), // Estado activo/inactivo
  isAutoDate: z.coerce.boolean().optional(), // Si true, number se actualiza automáticamente al día del mes
  number: NUMBER_00_99.optional(), // Solo string en PATCH, no array
  maxAmount: z.coerce.number().positive().optional(),
  maxTotal: z.coerce.number().positive().optional(),
  baseAmount: z.coerce.number().nonnegative().optional(), // Monto base (>= 0)
  salesPercentage: z.coerce.number().min(0).max(100).optional(), // Porcentaje 0-100
  appliesToVendedor: z.coerce.boolean().optional(), // Si aplica por vendedor
  salesCutoffMinutes: z.coerce.number().int().min(0).max(30).optional(),

  appliesToDate: z.coerce.date().optional(),
  appliesToHour: z.coerce.number().int().min(0).max(23).optional(),
  loteriaId: z.uuid().optional(),
  multiplierId: z.uuid().optional(),
  message: z.string().trim().min(1).max(255).optional().nullable(),
})
.strict()
.superRefine((data, ctx) => {
  const amount = isAmountRule(data);
  const cutoff = isCutoffRule(data);
  const lotteryMult = isLotteryMultiplierRule(data);

  if ([amount, cutoff, lotteryMult].filter(Boolean).length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "No puede combinar distintos tipos de restricción en la misma regla.",
    });
  }
  if (cutoff && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Para salesCutoffMinutes, number debe omitirse.",
    });
  }
  if (lotteryMult && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Las reglas de lotería/multiplicador no aceptan el campo number.",
    });
  }
  if (lotteryMult && (data.loteriaId == null || data.multiplierId == null)) {
    ctx.addIssue({
      code: "custom",
      path: ["(root)"],
      message: "Debe indicar loteriaId y multiplierId cuando actualiza una restricción de lotería/multiplicador.",
    });
  }
  if (lotteryMult && data.isAutoDate) {
    ctx.addIssue({
      code: "custom",
      path: ["isAutoDate"],
      message: "Las reglas de lotería/multiplicador no pueden usar isAutoDate.",
    });
  }

  // Validación: isAutoDate solo puede usarse con restricciones de montos (amount)
  if (data.isAutoDate && !amount && !cutoff) {
    // Permitir si es una actualización parcial y no se está cambiando el tipo
    // Esta validación es más permisiva en UPDATE
  }

  // Validación: si isAutoDate es true, number debe ser null o no especificarse
  if (data.isAutoDate && data.number != null) {
    ctx.addIssue({
      code: "custom",
      path: ["number"],
      message: "Si isAutoDate es true, number debe omitirse (se actualiza automáticamente al día del mes).",
    });
  }

  // Validaciones para porcentaje de ventas en UPDATE
  if (data.salesPercentage != null && (data.salesPercentage < 0 || data.salesPercentage > 100)) {
    ctx.addIssue({
      code: "custom",
      path: ["salesPercentage"],
      message: "salesPercentage debe estar entre 0 y 100.",
    });
  }

  if (data.baseAmount != null && data.baseAmount < 0) {
    ctx.addIssue({
      code: "custom",
      path: ["baseAmount"],
      message: "baseAmount debe ser mayor o igual a 0.",
    });
  }

  if (data.appliesToVendedor && data.salesPercentage == null) {
    ctx.addIssue({
      code: "custom",
      path: ["appliesToVendedor"],
      message: "appliesToVendedor solo tiene sentido cuando salesPercentage está presente.",
    });
  }
});

// LIST (query)  ✅ acepta hasAmount / hasCutoff / hasAutoDate y usa isActive
export const ListRestrictionRuleQuerySchema = z.object({
  bancaId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  userId: z.uuid().optional(),
  number: z.string().trim().min(1).optional(),

  // Parseo explícito de booleanos desde string (evita problemas con z.coerce.boolean)
  isActive: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  hasCutoff: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  hasAmount: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  hasAutoDate: z.enum(["true", "false"]).transform(v => v === "true").optional(),

  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

// opcional: body para delete/restore
export const ReasonBodySchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();
