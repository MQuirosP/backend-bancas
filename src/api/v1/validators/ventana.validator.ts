import { error } from './../../../utils/responses';
import { CreateVentanaDto, UpdateVentanaDto } from './../dto/ventana.dto';
import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";

export const validateCreateVentana = (req: Request, res: Response, next: NextFunction) => {
    const result = CreateVentanaDto.safeParse(req.body);
    if (!result.success) {
        throw new AppError(result.error.issues.map(e => e.message).join(", "), 400);
    }
    req.body = result.data;
    next();
};

export const validateUpdateVentana = (req: Request, res: Response, next: NextFunction) => {
    const result = UpdateVentanaDto.safeParse(req.body);
    if (!result.success) {
        throw new AppError(result.error.issues.map(e => e.message).join(", "), 400);
    }
    req.body = result.data;
    next();
};