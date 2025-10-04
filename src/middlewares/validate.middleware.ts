import { Request, Response, NextFunction } from "express";
import { ZodType } from "zod";
import { AppError } from "../core/errors";

export const validateBody = (schema: ZodType<any>) => (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        throw new AppError('Validation failed', 400, parsed.error.issues);
}
req.body = parsed.data;
    next();
}

export const validateParams = (schema: ZodType<any>) => (req: Request, _res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    throw new AppError('Validation error', 400, { issues: result.error.issues });
  }
  req.params = result.data;
  next();
};

export const validateQuery = (schema: ZodType<any>) => (req: Request, _res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new AppError('Validation error', 400, { issues: result.error.issues });
  }
  req.query = result.data as any;
  next();
};