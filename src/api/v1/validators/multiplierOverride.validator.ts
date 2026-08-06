import { BetType, OverrideScope } from "../../../generated/prisma/client";
import { z } from "zod";

// Enum for scope validation

// Extensible multiplier types - allows both predefined and custom types
const multiplierTypeEnum = z.union([
  z.enum(BetType),
  z.string().min(1),
]);

export const createMultiplierOverrideValidator = z
  .object({
    scope: z.enum(OverrideScope),
    scopeId: z.uuid("scopeId must be a valid UUID"),
    loteriaId: z.uuid("loteriaId must be a valid UUID"),
    multiplierType: multiplierTypeEnum,
    baseMultiplierX: z.number().positive("baseMultiplierX must be positive").max(9999),
  })
  .strict();

export const updateMultiplierOverrideValidator = z
  .object({
    baseMultiplierX: z.number().positive("baseMultiplierX must be positive").max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

export const listMultiplierOverrideQueryValidator = z.object({
  scope: z.enum(OverrideScope).optional(),
  scopeId: z.uuid("scopeId must be a valid UUID").optional(),
  loteriaId: z.uuid("loteriaId must be a valid UUID").optional(),
  multiplierType: z.string().min(1).optional(),
  isActive: z
    .union([z.boolean(), z.string().transform((val) => val === "true")])
    .optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(10).optional(),
});

export const idParamValidator = z.object({
  id: z.uuid("id must be a valid UUID"),
});
