import { z } from "zod";

export const createVMOValidator = z.object({
  ventanaId: z.string().min(1),
  loteriaId: z.string().min(1),
  baseMultiplierX: z.number().positive().max(9999),
  multiplierType: z.string().min(1),
});

export const updateVMOValidator = z.object({
  baseMultiplierX: z.number().positive().max(9999),
});

export const listVMOQueryValidator = z.object({
  ventanaId: z.string().min(1).optional(),
  loteriaId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(10).optional(),
});
