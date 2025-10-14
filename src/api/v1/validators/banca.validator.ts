import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { validateBody } from "../../../middlewares/validate.middleware";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CreateBancaSchema = z.object({
  name: z.string().min(2, "El nombre es obligatorio").max(100),
  code: z.string().min(2, "El código es obligatorio").max(20),
  email: z.string().trim().toLowerCase().regex(EMAIL_REGEX, "El email no es válido").optional(),
  address: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  isActive: z.boolean().optional(),
  defaultMinBet: z.coerce.number().min(100).positive().optional(),
  globalMaxPerNumber: z.coerce.number().min(1000).positive().optional(),
}).strict();

export const UpdateBancaSchema = CreateBancaSchema.partial().strict();

// Wrappers delgados que DELEGAN al middleware central (toDetails + summary + allowedKeys)
export const validateCreateBanca = (req: Request, res: Response, next: NextFunction) =>
  validateBody(CreateBancaSchema)(req, res, next);

export const validateUpdateBanca = (req: Request, res: Response, next: NextFunction) =>
  validateBody(UpdateBancaSchema)(req, res, next);
