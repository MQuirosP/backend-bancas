import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { AppError } from "../core/errors";
import { AuthenticatedRequest } from "../core/types";
import { Role } from "@prisma/client";
import prisma from "../core/prismaClient";
import { withConnectionRetry } from "../core/withConnectionRetry";
import { CacheService } from "../core/cache.service";

export const protect = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  //  Opción temporal: permitir solicitudes sin token si está habilitado en .env
  if (process.env.DISABLE_AUTH === "true") {
    req.user = { id: "DEV_USER_ID", role: Role.ADMIN }; // simulamos un usuario
    console.warn("️ [AUTH DISABLED] Autenticación temporalmente deshabilitada.");
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Unauthorized", 401);
  }

  const token = header.split(" ")[1];

  // 1) Verificar firma y expiración del JWT.
  //    Solo errores JWT genuinos deben resultar en 401.
  //    Separar este bloque evita que fallos de BD/Redis sean convertidos en 401.
  let decoded: any;
  try {
    decoded = jwt.verify(token, config.jwtAccessSecret);
  } catch {
    throw new AppError("Invalid token", 401);
  }

  const role = decoded.role as Role;
  if (!decoded.sub || !role) {
    throw new AppError("Invalid token", 401);
  }

  // 2) Operaciones de infraestructura (Redis / BD).
  //    Si fallan después de los reintentos, el error se propaga como 500,
  //    no como 401. Esto evita que un blip de Supabase desloguee a todos
  //    los usuarios simultáneamente.
  //    Nota: CacheService ya tiene graceful degradation interna (devuelve null si falla).
  let ventanaId: string | null | undefined = decoded.ventanaId ?? null;

  if (role === Role.VENDEDOR) {
    const cacheKey = `auth:ventana:${decoded.sub}`;
    const cached = await CacheService.get<{ v: string | null }>(cacheKey);

    if (cached !== null) {
      // Cache hit
      if (cached.v !== ventanaId) {
        ventanaId = cached.v;
      }
    } else {
      // Cache miss — consultar BD y cachear 5 min
      const user = await withConnectionRetry(
        () => prisma.user.findUnique({
          where: { id: decoded.sub },
          select: { ventanaId: true }
        }),
        { context: 'authMiddleware.vendedorVentana', maxRetries: 2 }
      );

      const dbVentanaId = user?.ventanaId ?? null;
      await CacheService.set(cacheKey, { v: dbVentanaId }, 300);

      if (dbVentanaId !== ventanaId) {
        ventanaId = dbVentanaId;
      }
    }
  }

  req.user = { id: decoded.sub, role, ventanaId, bancaId: decoded.bancaId ?? null };
  next();
};

export const restrictTo = (...roles: Role[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as any)?.user?.role as Role | undefined;
    if (!role || !roles.includes(role)) {
      throw new AppError("No tienes permisos para acceder a este recurso", 403);
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
    throw new AppError("No tienes permisos para modificar este usuario", 403);
  }

  next();
};

export const restrictToAdminSelfOrVentanaVendor = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const authUser = (req as any)?.user;
  const targetId = req.params.id;

  if (!authUser) {
    throw new AppError("Unauthorized", 401);
  }

  if (!targetId) {
    throw new AppError("User id is required", 400);
  }

  if (authUser.role === Role.ADMIN || authUser.id === targetId) {
    return next();
  }

  if (authUser.role !== Role.VENTANA) {
    throw new AppError("No tienes permisos para realizar esta acción", 403);
  }

  const actor = await withConnectionRetry(
    () => prisma.user.findUnique({
      where: { id: authUser.id },
      select: { ventanaId: true },
    }),
    { context: 'restrictToAdminSelfOrVentanaVendor.actor' }
  );

  if (!actor?.ventanaId) {
    throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
  }

  const target = await withConnectionRetry(
    () => prisma.user.findUnique({
      where: { id: targetId },
      select: { role: true, ventanaId: true },
    }),
    { context: 'restrictToAdminSelfOrVentanaVendor.target' }
  );

  if (!target) {
    throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");
  }

  if (target.role !== Role.VENDEDOR || target.ventanaId !== actor.ventanaId) {
    throw new AppError(
      "Solo puedes gestionar usuarios vendedores de tu ventana",
      403,
      "FORBIDDEN"
    );
  }

  next();
};

export const restrictToCommissionAdminSelfOrVentanaVendor = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const authUser = (req as any)?.user;
  const targetId = req.params.id;

  if (!authUser) {
    throw new AppError("Unauthorized", 401);
  }

  if (!targetId) {
    throw new AppError("User id is required", 400);
  }

  if (authUser.role === Role.ADMIN || authUser.id === targetId) {
    return next();
  }

  if (authUser.role !== Role.VENTANA) {
    throw new AppError("No tienes permisos para realizar esta acción", 403);
  }

  const actor = await withConnectionRetry(
    () => prisma.user.findUnique({
      where: { id: authUser.id },
      select: { ventanaId: true },
    }),
    { context: 'restrictToCommissionAdminSelfOrVentanaVendor.actor' }
  );

  if (!actor?.ventanaId) {
    throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
  }

  const target = await withConnectionRetry(
    () => prisma.user.findUnique({
      where: { id: targetId },
      select: { role: true, ventanaId: true },
    }),
    { context: 'restrictToCommissionAdminSelfOrVentanaVendor.target' }
  );

  if (!target) {
    throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");
  }

  if (target.role !== Role.VENDEDOR || target.ventanaId !== actor.ventanaId) {
    throw new AppError(
      "Solo puedes gestionar políticas de usuarios vendedores de tu ventana",
      403,
      "FORBIDDEN"
    );
  }

  next();
};

/**
 * Middleware para políticas de comisiones de ventanas
 * Permite ADMIN gestionar cualquier ventana, o VENTANA gestionar su propia ventana
 */
export const restrictToAdminOrVentanaSelf = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const authUser = (req as any)?.user;
  const ventanaId = req.params.id;

  if (!authUser) {
    throw new AppError("Unauthorized", 401);
  }

  if (!ventanaId) {
    throw new AppError("Ventana id is required", 400);
  }

  // ADMIN puede gestionar cualquier ventana
  if (authUser.role === Role.ADMIN) {
    return next();
  }

  // VENTANA solo puede gestionar su propia ventana
  if (authUser.role !== Role.VENTANA) {
    throw new AppError("No tienes permisos para acceder a este recurso", 403);
  }

  // Obtener la ventana del usuario autenticado
  const actor = await withConnectionRetry(
    () => prisma.user.findUnique({
      where: { id: authUser.id },
      select: { ventanaId: true },
    }),
    { context: 'restrictToAdminOrVentanaSelf.actor' }
  );

  if (!actor?.ventanaId) {
    throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
  }

  // Verificar que el ventanaId del endpoint coincide con la ventana del usuario
  if (actor.ventanaId !== ventanaId) {
    throw new AppError(
      "Solo puedes gestionar la política de comisiones de tu propia ventana",
      403,
      "FORBIDDEN"
    );
  }

  next();
};
