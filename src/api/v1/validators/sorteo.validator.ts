import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";

// 2 dígitos exactos para el número ganador
const twoDigit = z.string().regex(/^\d{2}$/, "winningNumber must be 2 digits (00-99)");

// CREATE: tu repositorio necesita name, así que lo validamos aquí
export const createSorteoSchema = z.object({
  loteriaId: z.uuid(),
  scheduledAt: z.coerce.date(),
  name: z.string().trim().min(1).max(100),
});

// UPDATE: permitir editar opcionalmente outcome/reventado
// - extraMultiplierId: uuid para conectar, null para desconectar, omitido = no tocar
export const updateSorteoSchema = z.object({
  scheduledAt: z.coerce.date().optional(),
  // status: z.enum(["SCHEDULED", "OPEN", "EVALUATED", "CLOSED"]).optional(),
  // winningNumber: twoDigit.optional(),
  // extraOutcomeCode: z.string().trim().min(1).max(50).nullable().optional(),
  // extraMultiplierId: z.uuid().nullable().optional(),
});

// EVALUATE: body completo (winningNumber obligatorio, reventado opcional)
// - extraMultiplierId: si viene (uuid) paga reventado; si viene null ⇒ explícitamente sin reventado
export const evaluateSorteoSchema = z.object({
  winningNumber: twoDigit,
  extraMultiplierId: z.uuid().nullable().optional(),
  extraOutcomeCode: z.string().trim().min(1).max(50).nullable().optional(),
});

export const validateIdParam = (req: Request, _res: Response, next: NextFunction) => {
  const r = z.uuid().safeParse(req.params.id);
  if (!r.success) throw new AppError("Parámetro id inválido (uuid)", 400);
  next();
};

export const validateCreateSorteo = (req: Request, _res: Response, next: NextFunction) => {
  const r = createSorteoSchema.safeParse(req.body);
  if (!r.success) throw new AppError(r.error.issues.map(i => i.message).join(", "), 400);
  req.body = r.data;
  next();
};

export const validateUpdateSorteo = (req: Request, _res: Response, next: NextFunction) => {
  const r = updateSorteoSchema.safeParse(req.body);
  if (!r.success) throw new AppError(r.error.issues.map(i => i.message).join(", "), 400);
  req.body = r.data;
  next();
};

export const validateEvaluateSorteo = (req: Request, _res: Response, next: NextFunction) => {
  const r = evaluateSorteoSchema.safeParse(req.body);
  if (!r.success) throw new AppError(r.error.issues.map(i => i.message).join(", "), 400);
  req.body = r.data;
  next();
};
