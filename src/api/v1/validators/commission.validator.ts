// src/api/v1/validators/commission.validator.ts
import { z } from "zod";
import { BetType } from "@prisma/client";
import { validateBody } from "../../../middlewares/validate.middleware";
import { v4 as uuidv4 } from "uuid";

/**
 * Schema para MultiplierRange
 * min <= max, ambos inclusivos
 */
const MultiplierRangeSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .strict()
  .refine((data) => data.min <= data.max, {
    message: "min must be less than or equal to max",
    path: ["min"],
  });

/**
 * Schema para CommissionRule
 * - id: string no vacío (si falta, se genera UUID en backend)
 * - loteriaId: UUID | null
 * - betType: "NUMERO" | "REVENTADO" | null
 * - multiplierRange: { min, max } con min <= max
 * - percent: 0..100
 */
const CommissionRuleSchema = z
  .object({
    id: z.string().min(1).optional(), // Opcional, se genera si falta
    loteriaId: z.string().uuid().nullable(),
    betType: z.nativeEnum(BetType).nullable(),
    multiplierRange: MultiplierRangeSchema,
    percent: z.number().min(0).max(100),
  })
  .strict();

/**
 * Schema principal para CommissionPolicy (version 1)
 * - version: literal 1
 * - effectiveFrom/To: ISO 8601 | null
 * - defaultPercent: 0..100
 * - rules: array de CommissionRule
 */
export const CommissionPolicySchema = z
  .object({
    version: z.literal(1),
    effectiveFrom: z.string().datetime().nullable(),
    effectiveTo: z.string().datetime().nullable(),
    defaultPercent: z.number().min(0).max(100),
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
  .transform((data) => {
    // Generar UUIDs para reglas sin ID
    return {
      ...data,
      rules: data.rules.map((rule) => ({
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
