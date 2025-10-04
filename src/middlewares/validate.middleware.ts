import { Request, Response, NextFunction } from "express";
import { ZodType } from "zod";
import { AppError } from "../core/errors";

export const validateBody = (schema: ZodType<any, any, any>) => (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        throw new AppError('Validation failed', 400, true, parsed.error.issues);
}
req.body = parsed.data;
    next();
}