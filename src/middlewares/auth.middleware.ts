import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { AppError } from "../core/errors";
import { AuthenticatedRequest } from "../core/types";
import { Role } from "../generated/prisma/client";
import prisma from "../core/prismaClient";
import { withConnectionRetry, isConnectionError } from "../core/withConnectionRetry";
import { CacheService } from "../core/cache.service";
import { getRequiredApkVersion, isVersionOutdated, isNativeAndroidClient } from "../utils/versionValidator";
import { SingleFlight } from "../utils/concurrency";
import logger from "../core/logger";

/**
 * Interfaz para la sesión cacheada del usuario
 */
export interface UserSession {
  id: string;
  role: Role;
  isActive: boolean;
  ventanaId: string | null;
  bancaId: string | null;
  activeSessionIds: string[]; // List of active/valid session IDs
  appVersion?: string | null;
}

/**
 * OPTIMIZACIÓN: Obtiene el usuario con jerarquía de caché L1 -> L2 -> DB
 * Mitiga el Error P2024 al reducir drásticamente los hits a la base de datos.
 */
export async function getCachedUser(userId: string): Promise<UserSession | null> {
  const cacheKey = `auth:session:${userId}`;
  
  // 1. Intentar obtener de L1 (Memoria) o L2 (Redis) con TTL L1 de 10 min
  const cached = await CacheService.get<UserSession>(cacheKey, true, 600_000);
  if (cached) {
    // Expiración deslizante: refrescar TTL en Redis (1800s / 30m) para mantener caliente la sesión de vendedores activos
    CacheService.touch(cacheKey, 1800).catch(() => {});
    return cached;
  }

  // 2. Coalescencia SingleFlight para evitar que múltiples requests concurrentes
  // para el mismo userId consulten a la base de datos simultáneamente (Thundering Herd)
  return await SingleFlight.do(cacheKey, async () => {
    // Doble verificación dentro de SingleFlight por si otra promesa en vuelo ya pobló la caché
    const doubleCheck = await CacheService.get<UserSession>(cacheKey, true, 600_000);
    if (doubleCheck) {
      return doubleCheck;
    }

    // DB Lean Query: Solo los campos indispensables + Sesiones activas en paralelo
    const [user, activeTokens] = await Promise.all([
      withConnectionRetry(
        () => prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            isActive: true,
            ventanaId: true,
            bancaId: true,
            appVersion: true,
            ventana: {
              select: { bancaId: true }
            }
          }
        }),
        { context: 'authMiddleware.getCachedUser', maxRetries: 1 }
      ),
      withConnectionRetry(
        () => prisma.refreshToken.findMany({
          where: {
            userId,
            OR: [
              { revoked: false },
              {
                revoked: true,
                revokedReason: 'rotation',
                revokedAt: { gt: new Date(Date.now() - 60000) } // Período de gracia de 60 segundos
              }
            ],
            expiresAt: { gt: new Date() }
          },
          select: {
            token: true
          }
        }),
        { context: 'authMiddleware.getActiveSessions', maxRetries: 1 }
      )
    ]);

    if (!user) return null;

    const session: UserSession = {
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      ventanaId: user.ventanaId,
      bancaId: user.bancaId ?? user.ventana?.bancaId ?? null,
      activeSessionIds: activeTokens.map((t) => t.token),
      appVersion: user.appVersion ?? null
    };

    // 3. Persistir en caché (1800s / 30 min en Redis, 600s / 10 min en Memoria L1)
    await CacheService.set(cacheKey, session, 1800, [], true, 600_000);

    return session;
  });
}

export const protect = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
) => {
  if (process.env.NODE_ENV === "development" && process.env.DISABLE_AUTH === "true") {
    req.user = { id: "DEV_USER_ID", role: Role.ADMIN };
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Unauthorized", 401);
  }

  const token = header.split(" ")[1];

  let decoded: any;
  try {
    decoded = jwt.verify(token, config.jwtAccessSecret, { clockTolerance: 90 });
  } catch {
    throw new AppError("Invalid token", 401);
  }

  if (!decoded.sub) {
    throw new AppError("Invalid token", 401);
  }

  // 1) Obtener usuario desde caché jerárquico o DB con timeout preventivo de 1,500ms y fallback JWT
  let user: UserSession | null = null;

  try {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("AUTH_TIMEOUT_EXCEEDED"));
      }, 1500);
    });

    user = await Promise.race([
      getCachedUser(decoded.sub),
      timeoutPromise,
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  } catch (err: any) {
    const isConnErr =
      isConnectionError(err) ||
      err?.message === "AUTH_TIMEOUT_EXCEEDED" ||
      err?.message?.includes("timeout exceeded when trying to connect") ||
      err?.message?.includes("connection timeout") ||
      err?.code === "P1001" ||
      err?.code === "P1017" ||
      err?.code === "P2024";

    if (isConnErr) {
      logger.warn({
        layer: 'middleware',
        action: 'AUTH_FALLBACK_JWT_USED',
        userId: decoded.sub,
        payload: {
          reason: err?.message || String(err),
          role: decoded.role,
          sid: decoded.sid,
        },
      });

      // Construir sesión de contingencia a partir de los claims criptográficamente verificados del JWT
      user = {
        id: decoded.sub,
        role: decoded.role,
        isActive: true,
        ventanaId: decoded.ventanaId ?? null,
        bancaId: decoded.bancaId ?? null,
        activeSessionIds: decoded.sid ? [decoded.sid] : [],
        appVersion: null,
      };

      // Almacenar temporalmente en L1 (60s) para no golpear la DB mientras se recupera
      CacheService.set(`auth:session:${decoded.sub}`, user, 60, [], true, 60_000).catch(() => {});
    } else {
      throw err;
    }
  }

  if (!user) {
    throw new AppError("User not found or session expired", 401);
  }

  // 2) Validar si el usuario está activo
  if (!user.isActive) {
    throw new AppError("Tu cuenta ha sido desactivada. Contacta al administrador.", 401, "USER_INACTIVE");
  }

  // 3) Validar si la sesión específica sigue activa (sid)
  // Para tokens antiguos/migrados que no tengan 'sid', permitimos el acceso temporalmente,
  // pero para los nuevos tokens con 'sid' validamos estrictamente su presencia en la base de datos/caché.
  if (decoded.sid && (!user.activeSessionIds || !user.activeSessionIds.includes(decoded.sid))) {
    throw new AppError("Sesión cerrada en otro dispositivo", 401, "SESSION_REVOKED");
  }

  req.user = { 
    id: user.id, 
    role: user.role, 
    ventanaId: user.ventanaId, 
    bancaId: user.bancaId 
  };

  // 4) Validar versión mínima de APK obligatoria para rol VENDEDOR en cliente nativo Android
  if (user.role === Role.VENDEDOR && isNativeAndroidClient(req)) {
    const minRequired = getRequiredApkVersion();
    const headerVersion = req.headers['x-app-version'] as string | undefined;

    if (!headerVersion || isVersionOutdated(headerVersion, minRequired)) {
      throw new AppError(
        `Versión de aplicación no soportada (${headerVersion || 'desconocida'}). Es obligatorio actualizar a la versión ${minRequired} para continuar.`,
        426,
        'UPGRADE_REQUIRED'
      );
    }
  }

  // Respaldo pasivo: actualizar appVersion en background si viene el header y difiere
  const headerVersion = req.headers['x-app-version'] as string | undefined;
  if (headerVersion && headerVersion !== user.appVersion) {
    const updatedUser = user;
    setImmediate(() => {
      prisma.user.update({
        where: { id: updatedUser.id },
        data: { appVersion: headerVersion },
      }).then(() => {
        return CacheService.set(
          `auth:session:${updatedUser.id}`,
          { ...updatedUser, appVersion: headerVersion },
          1800,
          [],
          true,
          600_000
        );
      }).catch(() => {});
    });
  }
  
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

  // 1. ADMIN o Auto-gestión siempre permitido
  if (authUser.role === Role.ADMIN || authUser.id === targetId) {
    return next();
  }

  // 2. Obtener datos del actor de caché
  const actor = await getCachedUser(authUser.id);
  if (!actor) throw new AppError("Actor not found", 401);

  // 3. Lógica según el rol del actor
  if (authUser.role === Role.BANCA) {
    // Un usuario BANCA puede gestionar a cualquier usuario de su misma banca
    const target = await getCachedUser(targetId);
    if (!target) throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");

    // Evitar que un BANCA edite a otro BANCA (escalada de privilegios horizontales)
    if (target.role === Role.BANCA && actor.id !== target.id) {
      throw new AppError("No puedes modificar a otro administrador de banca", 403);
    }

    const actorBancaId = (req as any).bancaContext?.bancaId || actor.bancaId;
    if (target.bancaId !== actorBancaId) {
      throw new AppError("Solo puedes gestionar usuarios de tu propia banca", 403);
    }
    return next();
  }

  if (authUser.role === Role.VENTANA) {
    if (!actor.ventanaId) {
      throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
    }

    const target = await getCachedUser(targetId);
    if (!target) throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");

    if (target.role !== Role.VENDEDOR || target.ventanaId !== actor.ventanaId) {
      throw new AppError(
        "Solo puedes gestionar usuarios vendedores de tu ventana",
        403,
        "FORBIDDEN"
      );
    }
    return next();
  }

  throw new AppError("No tienes permisos para realizar esta acción", 403);
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

  const actor = await getCachedUser(authUser.id);
  if (!actor) throw new AppError("Actor not found", 401);

  if (authUser.role === Role.BANCA) {
    const target = await getCachedUser(targetId);
    if (!target) throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");

    const actorBancaId = (req as any).bancaContext?.bancaId || actor.bancaId;
    if (target.bancaId !== actorBancaId) {
      throw new AppError("Solo puedes gestionar políticas de usuarios de tu propia banca", 403);
    }
    return next();
  }

  if (authUser.role === Role.VENTANA) {
    if (!actor.ventanaId) {
      throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
    }

    const target = await getCachedUser(targetId);
    if (!target) throw new AppError("Usuario no encontrado", 404, "USER_NOT_FOUND");

    if (target.role !== Role.VENDEDOR || target.ventanaId !== actor.ventanaId) {
      throw new AppError(
        "Solo puedes gestionar políticas de usuarios vendedores de tu ventana",
        403,
        "FORBIDDEN"
      );
    }
    return next();
  }

  throw new AppError("No tienes permisos para realizar esta acción", 403);
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

  // 1. ADMIN puede gestionar cualquier ventana
  if (authUser.role === Role.ADMIN) {
    return next();
  }

  const actor = await getCachedUser(authUser.id);
  if (!actor) throw new AppError("Actor not found", 401);

  // 2. BANCA puede gestionar cualquier ventana de su banca
  if (authUser.role === Role.BANCA) {
    const targetVentana = await prisma.ventana.findUnique({
      where: { id: ventanaId },
      select: { bancaId: true }
    });

    if (!targetVentana) throw new AppError("Ventana no encontrada", 404);

    const actorBancaId = (req as any).bancaContext?.bancaId || actor.bancaId;
    if (targetVentana.bancaId !== actorBancaId) {
      throw new AppError("Solo puedes gestionar ventanas de tu propia banca", 403);
    }
    return next();
  }

  // 3. VENTANA solo puede gestionar su propia ventana
  if (authUser.role === Role.VENTANA) {
    if (!actor.ventanaId) {
      throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
    }

    if (actor.ventanaId !== ventanaId) {
      throw new AppError(
        "Solo puedes gestionar la política de comisiones de tu propia ventana",
        403,
        "FORBIDDEN"
      );
    }
    return next();
  }

  throw new AppError("No tienes permisos para acceder a este recurso", 403);
};
