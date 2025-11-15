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
  loteriaId: z.uuid("loteriaId inválido").optional(),
  name: z.string().trim().min(1).max(100).optional(),
  scheduledAt: z.coerce.date().optional(),
  isActive: z.coerce.boolean().optional(),
}).strict();

export const EvaluateSorteoSchema = z.object({
  winningNumber: twoDigit,
  extraMultiplierId: z.uuid("extraMultiplierId inválido").nullable().optional(),
  extraOutcomeCode: z.string().trim().min(1).max(50).nullable().optional(),
}).strict();

export const RevertSorteoSchema = z.object({
  reason: z.string().trim().min(3).max(200).optional(),
}).strict();

// ✅ NUEVO: query para listar
export const ListSorteosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  loteriaId: z.uuid().optional(),
  status: z.enum(["SCHEDULED","OPEN","EVALUATED","CLOSED"]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  isActive: z.coerce.boolean().optional(),
  // Filtros de fecha (patrón: date=today|yesterday|week|month|year|range)
  date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate debe ser YYYY-MM-DD").optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "toDate debe ser YYYY-MM-DD").optional(),
  groupBy: z.enum(["hour", "loteria-hour"]).optional(),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

export const validateIdParam = (req: Request, res: Response, next: NextFunction) =>
  validateParams(IdParamSchema)(req, res, next);
export const validateCreateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(CreateSorteoSchema)(req, res, next);
export const validateUpdateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(UpdateSorteoSchema)(req, res, next);
export const validateEvaluateSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(EvaluateSorteoSchema)(req, res, next);
export const validateRevertSorteo = (req: Request, res: Response, next: NextFunction) =>
  validateBody(RevertSorteoSchema)(req, res, next);

// ✅ export helper para rutas
export const validateListSorteosQuery = (req: Request, res: Response, next: NextFunction) =>
  validateQuery(ListSorteosQuerySchema)(req, res, next);

// ✅ Query schema para evaluated-summary
export const EvaluatedSummaryQuerySchema = z.object({
  date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate debe ser YYYY-MM-DD").optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "toDate debe ser YYYY-MM-DD").optional(),
  scope: z.enum(["mine"]).optional().default("mine"), // Solo 'mine' para vendedor
  loteriaId: z.uuid().optional(),
  _: z.string().optional(), // Para evitar caché del navegador (ignorado)
}).strict();

export const validateEvaluatedSummaryQuery = (req: Request, res: Response, next: NextFunction) =>
  validateQuery(EvaluatedSummaryQuerySchema)(req, res, next);