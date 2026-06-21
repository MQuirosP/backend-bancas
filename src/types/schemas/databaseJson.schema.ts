import { z } from "zod";

/**
 * Esquema de validación estricta para políticas de comisión
 */
export const CommissionPolicySchema = z.object({
  version: z.number().default(1),
  defaultPercent: z.number().min(0).max(100).default(0),
  rules: z.array(
    z.object({
      id: z.string(), // ID de la lotería o regla
      percent: z.number().min(0).max(100),
      overrides: z.array(
        z.object({
          number: z.union([z.string(), z.number()]).transform(val => String(val)),
          percent: z.number().min(0).max(100),
        }).passthrough()
      ).optional(),
    }).passthrough()
  ).default([]),
  effectiveFrom: z.preprocess((val) => (val ? new Date(val as string) : val), z.date()).optional().nullable(),
  effectiveTo: z.preprocess((val) => (val ? new Date(val as string) : val), z.date()).optional().nullable(),
}).passthrough();

/**
 * Esquema de validación para las reglas de lotería (rulesJson en Loteria)
 */
export const LoteriaRulesSchema = z.object({
  minBetAmount: z.number().positive().default(100),
  maxBetAmount: z.number().positive(),
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/).optional(),
  allowReventado: z.boolean().default(false),
  multipliers: z.object({
    direct: z.number().positive().default(80),
    reventado: z.number().positive().optional(),
  }),
});

export type CommissionPolicy = z.infer<typeof CommissionPolicySchema>;
export type LoteriaRules = z.infer<typeof LoteriaRulesSchema>;

/**
 * Helper para Parsear de forma segura la política de comisiones de una banca/ventana
 */
export function safeParseCommissionPolicy(json: any): CommissionPolicy {
  const result = CommissionPolicySchema.safeParse(json);
  if (!result.success) {
    return {
      version: 1,
      defaultPercent: 0,
      rules: []
    };
  }
  return result.data;
}

/**
 * Helper para Parsear de forma segura las reglas de una lotería
 */
export function safeParseLoteriaRules(json: any, defaultMaxBet: number = 5000): LoteriaRules {
  const result = LoteriaRulesSchema.safeParse(json);
  if (!result.success) {
    return {
      minBetAmount: 100,
      maxBetAmount: defaultMaxBet,
      allowReventado: false,
      multipliers: {
        direct: 80
      }
    };
  }
  return result.data;
}
