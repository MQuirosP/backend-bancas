import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { AppError } from "../core/errors";
import { AuthenticatedRequest } from "../core/types";
import { Role } from "@prisma/client";

export const protect = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  // 🔧 Opción temporal: permitir solicitudes sin token si está habilitado en .env
  if (process.env.DISABLE_AUTH === "true") {
    req.user = { id: "DEV_USER_ID", role: Role.ADMIN }; // simulamos un usuario
    console.warn("⚠️ [AUTH DISABLED] Autenticación temporalmente deshabilitada.");
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Unauthorized", 401);
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret) as any;
    const role = decoded.role as Role;
    if (!decoded.sub || !role) {
      throw new AppError("Invalid token", 401);
    }
    req.user = { id: decoded.sub, role };
    next();
  } catch {
    throw new AppError("Invalid token", 401);
  }
};

export const restrictTo = (...roles: Role[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as any)?.user?.role as Role | undefined;
    if (!role || !roles.includes(role)) {
      throw new AppError("Forbidden", 403);
    }
    next();
  };
};

// Permite que ADMIN actualice cualquier usuario, o que el usuario se actualice a sí mismo
export const restrictToAdminOrSelf = (req: Request, _res: Response, next: NextFunction) => {
  const user = (req as any)?.user;
  const userId = req.params.id;

  if (!user) {
    throw new AppError("Unauthorized", 401);
  }

  const isAdmin = user.role === Role.ADMIN;
  const isSelf = user.id === userId;

  if (!isAdmin && !isSelf) {
    throw new AppError("Forbidden", 403);
  }

  next();
};
