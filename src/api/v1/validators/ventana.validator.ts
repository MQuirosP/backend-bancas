import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { validateBody, validateParams } from "../../../middlewares/validate.middleware";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

const IdParamSchema = z.object({
  id: z.uuid("id inválido (UUID)"),
}).strict();

export const CreateVendedorSchema = z.object({
  ventanaId: z.uuid("ventanaId inválido"),
  name: z.string().min(2, "El nombre es obligatorio"),
  username: z.string().min(3).max(12),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Formato de correo inválido").optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
}).strict();

export const UpdateVendedorSchema = z.object({
  ventanaId: z.uuid("ventanaId inválido").optional(),
  name: z.string().min(2, "El nombre es obligatorio").optional(),
  username: z.string().min(3).max(12).optional(),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, "Formato de correo inválido").optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").optional(),
  isActive: z.boolean().optional(),
}).strict();

// Wrappers delgados que delegan a TU middleware central
export const validateVendedorIdParam = (req: Request, res: Response, next: NextFunction) =>
  validateParams(IdParamSchema)(req, res, next);

export const validateCreateVendedor = (req: Request, res: Response, next: NextFunction) =>
  validateBody(CreateVendedorSchema)(req, res, next);

export const validateUpdateVendedor = (req: Request, res: Response, next: NextFunction) =>
  validateBody(UpdateVendedorSchema)(req, res, next);
