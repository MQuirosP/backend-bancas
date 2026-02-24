// src/api/v1/validators/commission.validator.ts
import { z } from "zod";
import { BetType } from "@prisma/client";
import { validateBody } from "../../../middlewares/validate.middleware";
import { v4 as uuidv4 } from "uuid";

/**
 * Schema para MultiplierRange
 * min === max (el FE siempre guarda un multiplicador específico, no un rango)
 */
const MultiplierRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .strict()
  .refine((data) => data.min === data.max, {
    message: "min must equal max — solo se permiten multiplicadores específicos (no rangos)",
    path: ["min"],
  });

/**
 * Schema para CommissionRule
 * - id: string no vacío (si falta, se genera UUID en backend)
 * - loteriaId: UUID | null
 * - betType: "NUMERO" | "REVENTADO" | null
 * - multiplierRange: { min, max } con min === max
 * - percent: 0..100, máximo 2 decimales
 * - multiplier: de solo lectura — el BE lo embebe en GET y lo ignora en PUT
 */
const CommissionRuleSchema = z
  .object({
    id: z.string().min(1).optional(), // Opcional, se genera si falta
    loteriaId: z.string().uuid().nullable(),
    betType: z.nativeEnum(BetType).nullable(),
    multiplierId: z.string().uuid().nullable().optional(), // Nuevo: para distinguir multiplicadores con mismo valor
    multiplierRange: MultiplierRangeSchema,
    percent: z.number().min(0).max(100).refine(
      (val) => /^\d+(\.\d{1,2})?$/.test(val.toString()),
      { message: "Percentage must have maximum 2 decimal places" }
    ),
    multiplier: z.unknown().optional(), // De solo lectura: aceptado pero descartado en PUT
  })
  .strict();

/**
 * Valida que no existan reglas duplicadas en el payload.
 * Un duplicado es el mismo loteriaId, mismo betType Y mismo multiplicador (por ID o valor).
 */
function validateNoDuplicateRules(rules: Array<{
  id?: string;
  loteriaId: string | null;
  betType: BetType | null;
  multiplierId?: string | null;
  multiplierRange: { min: number; max: number };
}>) {
  const keys = new Set<string>();

  for (const rule of rules) {
    // Solo validar duplicados de multiplicadores específicos (min === max)
    if (rule.multiplierRange.min !== rule.multiplierRange.max) continue;

    const loteriaIdKey = rule.loteriaId ?? "global";
    const betTypeKey = rule.betType ?? "all";
    const multiplierKey = rule.multiplierId ?? `val-${rule.multiplierRange.min}`;
    
    // La llave es la combinación única de estos 3 factores
    const key = `${loteriaIdKey}:${betTypeKey}:${multiplierKey}`;

    if (keys.has(key)) {
      return false; // Duplicado encontrado
    }
    keys.add(key);
  }
  
  return true; // No hay duplicados
}

/**
 * Schema principal para CommissionPolicy (version 1)
 * - version: literal 1
 * - effectiveFrom/To: ISO 8601 | null
 * - defaultPercent: 0..100, máximo 2 decimales
 * - rules: array de CommissionRule
 */
export const CommissionPolicySchema = z
  .object({
    version: z.literal(1),
    effectiveFrom: z.string().datetime().nullable(),
    effectiveTo: z.string().datetime().nullable(),
    defaultPercent: z.number().min(0).max(100).refine(
      (val) => /^\d+(\.\d{1,2})?$/.test(val.toString()),
      { message: "Default percentage must have maximum 2 decimal places" }
    ),
    rules: z.array(CommissionRuleSchema),
  })
  .strict()
  .refine(
    (data) => {
      if (data.effectiveFrom && data.effectiveTo) {
        return new Date(data.effectiveFrom) <= new Date(data.effectiveTo);
      }
      return true;
    },
    {
      message: "effectiveFrom must be before or equal to effectiveTo",
      path: ["effectiveFrom"],
    }
  )
  .refine(
    (data) => validateNoDuplicateRules(data.rules),
    {
      message: "Ya existe una regla para este multiplicador en esta lotería y tipo",
      path: ["rules"],
    }
  )
  .transform((data) => {
    // Generar UUIDs para reglas sin ID y descartar el campo multiplier (de solo lectura)
    return {
      ...data,
      rules: data.rules.map(({ multiplier: _ignored, ...rule }) => ({
        ...rule,
        id: rule.id || uuidv4(),
      })),
    };
  });

/**
 * Schema para PUT /bancas/:id/commission-policy
 */
export const UpdateBancaCommissionPolicyBodySchema = z
  .object({
    commissionPolicyJson: CommissionPolicySchema.nullable(),
  })
  .strict();

/**
 * Schema para PUT /ventanas/:id/commission-policy
 */
export const UpdateVentanaCommissionPolicyBodySchema = z
  .object({
    commissionPolicyJson: CommissionPolicySchema.nullable(),
  })
  .strict();

/**
 * Schema para PUT /users/:id/commission-policy
 */
export const UpdateUserCommissionPolicyBodySchema = z
  .object({
    commissionPolicyJson: CommissionPolicySchema.nullable(),
  })
  .strict();

/**
 * Schema para parámetros de ID (UUID)
 */
export const IdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

// Middlewares de validación
export const validateUpdateBancaCommissionPolicyBody = validateBody(
  UpdateBancaCommissionPolicyBodySchema
);
export const validateUpdateVentanaCommissionPolicyBody = validateBody(
  UpdateVentanaCommissionPolicyBodySchema
);
export const validateUpdateUserCommissionPolicyBody = validateBody(
  UpdateUserCommissionPolicyBodySchema
);
export const validateIdParam = validateBody(IdParamSchema);
