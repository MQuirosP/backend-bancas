import { NextFunction, Response } from "express";
import { Role } from "@prisma/client";
import { AppError } from "../core/errors";
import { AuthenticatedRequest } from "../core/types";

/** exige que el usuario autenticado tenga alguno de los roles permitidos */
export const requireRole =
  (...roles: Role[]) =>
  (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError("Unauthorized", 401);
    if (!roles.includes(req.user.role)) throw new AppError("Forbidden", 403);
    next();
  };

/** Azúcares sintácticos */
export const requireAdmin = requireRole(Role.ADMIN);
export const requireAdminOrVentana = requireRole(Role.ADMIN, Role.VENTANA);

/** Cualquiera autenticado */
export const requireAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  if (!req.user) throw new AppError("Unauthorized", 401);
  next();
};
