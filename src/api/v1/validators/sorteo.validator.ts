import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";

const IdParamSchema = z.object({ id: z.uuid("id inválido (UUID)") }).strict();
const twoDigit = z.string().regex(/^\d{2}$/, "winningNumber debe ser 2 dígitos (00-99)");

export const CreateSorteoSchema = z.object({
  loteriaId: z.uuid("loteriaId inválido"),
  scheduledAt: z.coerce.date(),
  name: z.string().trim().min(1).max(100),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const UpdateSorteoSchema = z.object({
  scheduledAt: z.coerce.date().optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const EvaluateSorteoSchema = z.object({
  winningNumber: twoDigit,
  extraMultiplierId: z.uuid("extraMultiplierId inválido").nullable().optional(),
  extraOutcomeCode: z.string().trim().min(1).max(50).nullable().optional(),
}).strict();

// ✅ NUEVO: query para listar
export const ListSorteosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  loteriaId: z.string().uuid().optional(),
  status: z.enum(["SCHEDULED","OPEN","EVALUATED","CLOSED"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const validateIdParam = (req: Request, res: Response, next: NextFunction) =>
  validateParams(IdParamSchema)(req, res, next);
export const validateCreateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(CreateSorteoSchema)(req, res, next);
export const validateUpdateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(UpdateSorteoSchema)(req, res, next);
export const validateEvaluateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(EvaluateSorteoSchema)(req, res, next);

// ✅ export helper para rutas
export const validateListSorteosQuery = (req: Request, res: Response, next: NextFunction) =>
  validateQuery(ListSorteosQuerySchema)(req, res, next);
