import { CreateMultiplierDTO, UpdateMultiplierDTO } from "./../dto/multiplier.dto";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";

export const validateCreateMultiplier = (req: Request, res: Response, next: NextFunction) => {
    const result = CreateMultiplierDTO.safeParse(req.body);
    if (!result.success) {
        throw new AppError(result.error.issues.map(e => e.message).join(", "), 400);
    }
    req.body = result.data;
    next();
}

export const validateUpdateMultiplier = (req: Request, res: Response, next: NextFunction) => {
    const result = UpdateMultiplierDTO.safeParse(req.body);
    if (!result.success) {
        throw new AppError(result.error.issues.map(e => e.message).join(", "), 400);
    }
    req.body = result.data;
    next();
}