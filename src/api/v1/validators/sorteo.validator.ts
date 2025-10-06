import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";

export const createSorteoSchema = z.object({
  loteriaId: z.uuid(),
  scheduledAt: z.coerce.date(),
});

export const updateSorteoSchema = z.object({
  scheduledAt: z.coerce.date().optional(),
  status: z.enum(["SCHEDULED", "OPEN", "EVALUATED", "CLOSED"]).optional(),
  winningNumber: z.string().optional(),
});

export const evaluateSorteoSchema = z.object({
  winningNumber: z.string().min(1, "winningNumber requerido"),
});

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
