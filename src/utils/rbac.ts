/**
 * Utilidad para aplicar RBAC autoritario.
 *
 * El backend nunca confía en parámetros de filtro del cliente.
 * Los filtros se aplican estrictamente según el rol del usuario en el JWT.
 */

import { Role } from '@prisma/client';
import { AppError } from '../core/errors';
import prisma from '../core/prismaClient';
import logger from '../core/logger';

export interface AuthContext {
  userId: string;         // sub del JWT
  role: Role;             // ADMIN | VENTANA | VENDEDOR
  ventanaId?: string | null; // presente si role === VENTANA
}

export interface RequestFilters {
  ventanaId?: string;
  vendedorId?: string;
  [key: string]: any; // otros filtros (loteriaId, sorteoId, status, etc.)
}

export interface EffectiveFilters {
  ventanaId?: string | null;
  vendedorId?: string;
  [key: string]: any;
}

/**
 * Valida que un usuario VENTANA tenga ventanaId asignado.
 * Si no está en JWT, lo busca en la base de datos.
 *
 * @param role Rol del usuario
 * @param ventanaId ventanaId del usuario (puede ser null/undefined)
 * @param userId userId para buscar en BD si es necesario
 * @returns ventanaId garantizado (del JWT o de la BD)
 * @throws AppError(403) si no tiene ventanaId en BD
 */
export async function validateVentanaUser(role: Role, ventanaId?: string | null, userId?: string): Promise<string | null | undefined> {
  if (role === Role.VENTANA && !ventanaId && userId) {
    // JWT antiguo sin ventanaId - buscar en base de datos
    logger.warn({
      layer: 'rbac',
      action: 'VENTANA_FETCHING_FROM_DB_VALIDATE',
      payload: {
        userId,
        message: 'JWT missing ventanaId - fetching from database (validateVentanaUser)'
      }
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { ventanaId: true }
    });

    if (!user?.ventanaId) {
      // Usuario no tiene ventanaId en BD tampoco - error crítico
      throw new AppError('VENTANA user must have ventanaId assigned in database', 403, {
        code: 'RBAC_003',
        details: [
          {
            field: 'ventanaId',
            reason: 'User configuration error: VENTANA role requires ventanaId'
          }
        ]
      });
    }

    logger.info({
      layer: 'rbac',
      action: 'VENTANA_VENTANAID_LOADED_VALIDATE',
      payload: {
        userId,
        ventanaId: user.ventanaId,
        message: 'VentanaId loaded from database (validateVentanaUser) - user should logout/login'
      }
    });

    return user.ventanaId;
  }

  return ventanaId;
}

/**
 * Aplica filtros de RBAC automáticamente según el rol del usuario.
 *
 * Reglas:
 * - VENDEDOR: siempre filtro vendedorId = userId; ignora otros vendedorId/ventanaId
 * - VENTANA: siempre filtro ventanaId = JWT.ventanaId; permite vendedorId si pertenece a la ventana
 * - ADMIN: aplica filtros tal cual; si ausente, sin filtro
 *
 * @param context Información del usuario desde JWT
 * @param requestFilters Parámetros de filtro del cliente
 * @returns Filtros efectivos a aplicar a la query
 * @throws AppError(403) si intenta acceder fuera de scope
 */
export async function applyRbacFilters(
  context: AuthContext,
  requestFilters: RequestFilters
): Promise<EffectiveFilters> {
  const effective: EffectiveFilters = { ...requestFilters };

  if (context.role === Role.VENDEDOR) {
    // VENDEDOR: siempre solo sus propias ventas
    effective.vendedorId = context.userId;
    delete effective.ventanaId; // ignorar cualquier ventanaId
  } else if (context.role === Role.VENTANA) {
    // VENTANA: todas las ventas de su ventana
    // CRITICAL: Si ventanaId no está en JWT, buscar en BD
    let ventanaId = context.ventanaId;

    if (!ventanaId) {
      // JWT antiguo sin ventanaId - buscar en base de datos
      logger.warn({
        layer: 'rbac',
        action: 'VENTANA_FETCHING_FROM_DB',
        payload: {
          userId: context.userId,
          message: 'JWT missing ventanaId - fetching from database'
        }
      });

      const user = await prisma.user.findUnique({
        where: { id: context.userId },
        select: { ventanaId: true }
      });

      if (!user?.ventanaId) {
        // Usuario no tiene ventanaId en BD tampoco - error crítico
        throw new AppError('VENTANA user must have ventanaId assigned in database', 403, {
          code: 'RBAC_003',
          details: [
            {
              field: 'ventanaId',
              reason: 'User configuration error: VENTANA role requires ventanaId'
            }
          ]
        });
      }

      ventanaId = user.ventanaId;

      logger.info({
        layer: 'rbac',
        action: 'VENTANA_VENTANAID_LOADED',
        payload: {
          userId: context.userId,
          ventanaId,
          message: 'VentanaId loaded from database - user should logout/login to refresh JWT'
        }
      });
    }

    effective.ventanaId = ventanaId;

    // Si solicita un vendedorId específico, validar que pertenezca a la ventana
    if (requestFilters.vendedorId) {
      const vendedor = await prisma.user.findUnique({
        where: { id: requestFilters.vendedorId },
        select: { ventanaId: true }
      });

      if (!vendedor || vendedor.ventanaId !== context.ventanaId) {
        throw new AppError('Cannot access that vendedor', 403, {
          code: 'RBAC_002',
          details: [
            {
              field: 'vendedorId',
              reason: 'Vendedor does not belong to your ventana'
            }
          ]
        });
      }

      effective.vendedorId = requestFilters.vendedorId;
    }

    // Si solicita un ventanaId diferente, rechazar
    if (requestFilters.ventanaId && requestFilters.ventanaId !== context.ventanaId) {
      throw new AppError('Cannot access that ventana', 403, {
        code: 'RBAC_001',
        details: [
          {
            field: 'ventanaId',
            reason: 'You can only access your own ventana'
          }
        ]
      });
    }
  } else if (context.role === Role.ADMIN) {
    // ADMIN: aplica filtros tal cual
    // No hay restricciones; permite ventanaId, vendedorId, etc.
  }

  return effective;
}
