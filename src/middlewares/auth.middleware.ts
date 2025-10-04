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
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Unauthorized", 401);
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret) as any;
    req.user = { id: decoded.sub, role: decoded.role };
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
