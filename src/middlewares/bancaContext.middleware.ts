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

    // Para VENTANA/VENDEDOR, usar su banca a través de ventanaId
    if (user.role !== Role.ADMIN) {
      if (user.ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: user.ventanaId },
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

    // Para ADMIN: leer header (solo filtro de vista, sin validación de asignación)
    // Express normaliza headers a lowercase automáticamente, pero verificar todas las variantes
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
    // activeBancaId puede ser null, lo cual significa "ver todas las bancas"
    req.bancaContext = {
      bancaId: activeBancaId, // null = ver todas, string = filtrar por esa banca
      userId: user.id,
      hasAccess: hasAccess || activeBancaId === null, // Si no hay filtro, tiene acceso a todo
    };

    next();
  } catch (error) {
    // Continuar sin contexto de banca (no bloquear request)
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

