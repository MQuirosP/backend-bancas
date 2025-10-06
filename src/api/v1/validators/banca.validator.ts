import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";
import { CreateBancaDto, UpdateBancaDto } from "../dto/banca.dto";

export const validateCreateBanca = (req: Request, res: Response, next: NextFunction) => {
    const result = CreateBancaDto.safeParse(req.body);
    if (!result.success) {
        const msg = result.error.issues.map((err) => err.message).join(", ");
        throw new AppError(msg, 400);
    }
    req.body = result.data;
    next();
}

export const validateUpdateBanca = (req: Request, res: Response, next: NextFunction) => {
    const result = UpdateBancaDto.safeParse(req.body);
    if (!result.success) {
        const msg = result.error.issues.map((err) => err.message).join(", ");
        throw new AppError(msg, 400);
    }
    req.body = result.data;
    next();
}