import { Response, NextFunction } from 'express';
import prisma from '../core/prismaClient';
import logger from '../core/logger';
import { AppError } from '../core/errors';
import { AuthenticatedRequest, BancaContext } from '../core/types';
import { Role } from '@prisma/client';

/**
 * Middleware para establecer el contexto de banca activa (filtro de vista)
 * 
 * Funcionamiento:
 * 1. Lee el header X-Active-Banca-Id
 * 2. Si el usuario es ADMIN, puede usar cualquier banca activa (solo filtro de vista)
 * 3. Si no hay header, no filtra por banca (ADMIN ve todas)
 * 4. Para VENTANA/VENDEDOR, usa su banca a través de ventanaId
 * 5. Establece req.bancaContext con la banca activa
 */
export async function bancaContextMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      return next();
    }

    // ========================================================================
    // 1. CASO: USUARIO BANCA (Multi-tenant Admin)
    // ========================================================================
    if (user.role === Role.BANCA) {
      // Leer header de banca activa solicitado por el FE
      const headerLower = req.headers['x-active-banca-id'] as string | undefined;
      const headerUpper = req.headers['X-Active-Banca-Id'] as string | undefined;
      const requestedBancaId = headerLower || headerUpper || undefined;

      // Obtener todas las bancas asignadas al usuario en UserBanca
      const userBancas = await prisma.userBanca.findMany({
        where: { userId: user.id },
        select: { bancaId: true },
      });

      const assignedBancaIds = userBancas.map(ub => ub.bancaId);

      if (assignedBancaIds.length === 0) {
        // Fallback: si no tiene bancas en UserBanca, intentar usar la de su perfil (si existe)
        if (user.bancaId) {
          req.bancaContext = {
            bancaId: user.bancaId,
            userId: user.id,
            hasAccess: true,
          };
          return next();
        }
        // No tiene acceso a ninguna banca
        throw new AppError("No tienes bancas asignadas", 403, "FORBIDDEN");
      }

      let activeBancaId: string | null = null;

      if (requestedBancaId && assignedBancaIds.includes(requestedBancaId)) {
        // La banca solicitada es una de sus bancas asignadas
        activeBancaId = requestedBancaId;
      } else {
        // Fallback: usar la banca por defecto del perfil o la primera asignada
        activeBancaId = (user.bancaId && assignedBancaIds.includes(user.bancaId))
          ? user.bancaId
          : assignedBancaIds[0];
      }

      req.bancaContext = {
        bancaId: activeBancaId,
        userId: user.id,
        hasAccess: true,
      };

      //  NUEVO: Informar al FE si el contexto cambió respecto a lo solicitado
      // Esto ayuda a que el Store de la banca en el FE se sincronice
      if (requestedBancaId && requestedBancaId !== activeBancaId) {
        res.setHeader('X-Banca-Context-Fallback', activeBancaId);
      }

      return next();
    }

    // ========================================================================
    // 2. CASO: VENTANA / VENDEDOR (Single-tenant)
    // ========================================================================
    if (user.role === Role.VENTANA || user.role === Role.VENDEDOR) {
      if (user.bancaId) {
        // bancaId ya viene en el JWT — sin query
        req.bancaContext = {
          bancaId: user.bancaId,
          userId: user.id,
          hasAccess: true,
        };
        return next();
      }

      // Fallback: JWT viejo sin bancaId — resolver desde BD
      let ventanaId = user.ventanaId;

      if (!ventanaId) {
        const userWithVentana = await prisma.user.findUnique({
          where: { id: user.id },
          select: { ventanaId: true },
        });
        ventanaId = userWithVentana?.ventanaId;

        if (ventanaId && req.user) {
          req.user.ventanaId = ventanaId;
        }
      }

      if (ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: { bancaId: true },
        });

        if (ventana) {
          req.bancaContext = {
            bancaId: ventana.bancaId,
            userId: user.id,
            hasAccess: true,
          };
        }
      }
      return next();
    }

    // ========================================================================
    // 3. CASO: ADMIN (Global Admin)
    // ========================================================================
    // Para ADMIN: leer header (solo filtro de vista, sin validación de asignación)
    const headerLower = req.headers['x-active-banca-id'] as string | undefined;
    const headerUpper = req.headers['X-Active-Banca-Id'] as string | undefined;
    const requestedBancaId = headerLower || headerUpper || undefined;

    let activeBancaId: string | null = null;
    let hasAccess = false;

    if (requestedBancaId) {
      // Solo validar que la banca existe y está activa (no validar asignación)
      const banca = await prisma.banca.findUnique({
        where: { id: requestedBancaId },
        select: {
          id: true,
          isActive: true,
        },
      });

      if (banca && banca.isActive) {
        activeBancaId = requestedBancaId;
        hasAccess = true;
      }
    }

    // Si no hay header o la banca no es válida, no filtrar (ADMIN ve todas)
    req.bancaContext = {
      bancaId: activeBancaId, // null = ver todas, string = filtrar por esa banca
      userId: user.id,
      hasAccess: hasAccess || activeBancaId === null, // Si no hay filtro, tiene acceso a todo
    };

    next();
  } catch (error) {
    logger.error({
      layer: 'middleware',
      action: 'BANCA_CONTEXT_ERROR',
      payload: { error: (error as Error).message, userId: req.user?.id },
    });
    next();
  }
}

/**
 * Helper para obtener la banca activa del contexto
 */
export function getActiveBancaId(req: AuthenticatedRequest): string | null {
  return req.bancaContext?.bancaId || null;
}

/**
 * Helper para validar que una banca existe y está activa
 * (Ya no valida asignación, solo existencia y estado)
 */
export async function validateBancaExists(
  bancaId: string
): Promise<boolean> {
  const banca = await prisma.banca.findUnique({
    where: { id: bancaId },
    select: {
      id: true,
      isActive: true,
    },
  });
  return !!banca && banca.isActive;
}

