import { Request, Response, NextFunction } from "express";
import { AppError } from "../../../core/errors";
import { CreateVendedorDto, UpdateVendedorDto } from "../dto/vendedor.dto";

export const validateCreateVendedor = (req: Request, _res: Response, next: NextFunction) => {
  const result = CreateVendedorDto.safeParse(req.body);
  if (!result.success) {
    const msg = result.error.issues.map(i => i.message).join(", ");
    throw new AppError(msg, 400);
  }
  req.body = result.data;
  next();
};

export const validateUpdateVendedor = (req: Request, _res: Response, next: NextFunction) => {
  const result = UpdateVendedorDto.safeParse(req.body);
  if (!result.success) {
    const msg = result.error.issues.map(i => i.message).join(", ");
    throw new AppError(msg, 400);
  }
  req.body = result.data;
  next();
};
