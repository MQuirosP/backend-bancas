/**
 * Utilidad para aplicar RBAC autoritario.
 *
 * El backend nunca confía en parámetros de filtro del cliente.
 * Los filtros se aplican estrictamente según el rol del usuario en el JWT.
 */

import { Role } from '../generated/prisma/client';
import { AppError } from '../core/errors';
import prisma from '../core/prismaClient';
import { withConnectionRetry } from '../core/withConnectionRetry';
import logger from '../core/logger';

export interface AuthContext {
  userId: string;         // sub del JWT
  role: Role;             // ADMIN | VENTANA | VENDEDOR
  ventanaId?: string | null; // presente si role === VENTANA
  bancaId?: string | null; // presente si role === ADMIN y tiene banca activa
}

export interface RequestFilters {
  ventanaId?: string;
  vendedorId?: string;
  [key: string]: any; // otros filtros (loteriaId, sorteoId, status, etc.)
}

export interface EffectiveFilters {
  ventanaId?: string | null;
  vendedorId?: string;
  bancaId?: string; // Para ADMIN multibanca
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

    const user = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: userId },
        select: { ventanaId: true }
      }),
      { context: 'rbac.validateVentanaUser' }
    );

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
 * Estrategias de filtrado RBAC por rol
 */
async function applyVendedorStrategy(
  context: AuthContext,
  requestFilters: RequestFilters
): Promise<EffectiveFilters> {
  const effective: EffectiveFilters = { ...requestFilters };
  // VENDEDOR: siempre solo sus propias ventas
  effective.vendedorId = context.userId;

  // Inferir ventanaId para vendedores para ayudar con la indexación en DB
  let ventanaId = context.ventanaId;
  if (!ventanaId) {
    const user = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: context.userId },
        select: { ventanaId: true }
      }),
      { context: 'rbac.applyRbacFilters.vendedorVentana' }
    );
    ventanaId = user?.ventanaId;
  }
  if (ventanaId) {
    effective.ventanaId = ventanaId;
  }
  return effective;
}

async function applyVentanaStrategy(
  context: AuthContext,
  requestFilters: RequestFilters
): Promise<EffectiveFilters> {
  const effective: EffectiveFilters = { ...requestFilters };

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

    const user = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: context.userId },
        select: { ventanaId: true }
      }),
      { context: 'rbac.applyRbacFilters.ventanaVentana' }
    );

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
    const vendedor = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: requestFilters.vendedorId! },
        select: { ventanaId: true }
      }),
      { context: 'rbac.applyRbacFilters.vendedorValidate' }
    );

    if (!vendedor || vendedor.ventanaId !== ventanaId) {
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

  // FIX: Para usuarios VENTANA, ignorar el ventanaId del request y usar siempre el suyo
  if (requestFilters.ventanaId && requestFilters.ventanaId !== ventanaId) {
    logger.warn({
      layer: 'rbac',
      action: 'VENTANA_IGNORING_REQUEST_VENTANAID',
      payload: {
        userId: context.userId,
        requestVentanaId: requestFilters.ventanaId,
        actualVentanaId: ventanaId,
        message: 'Ignoring incorrect ventanaId from request, using user ventanaId instead'
      }
    });
  }
  return effective;
}

async function applyAdminStrategy(
  context: AuthContext,
  requestFilters: RequestFilters
): Promise<EffectiveFilters> {
  const effective: EffectiveFilters = { ...requestFilters };
  // ADMIN: Si tiene banca activa o bancaId en request, filtrar
  const effectiveBancaId = requestFilters.bancaId || context.bancaId;
  if (effectiveBancaId) {
    effective.bancaId = effectiveBancaId;
    if (requestFilters.ventanaId) {
      const ventana = await withConnectionRetry(
        () => prisma.ventana.findUnique({
          where: { id: requestFilters.ventanaId! },
          select: { bancaId: true },
        }),
        { context: 'rbac.applyRbacFilters.adminVentana' }
      );
      
      if (ventana && ventana.bancaId !== effectiveBancaId) {
        delete effective.bancaId;
      }
    }
    if (requestFilters.vendedorId) {
      const vendedor = await withConnectionRetry(
        () => prisma.user.findUnique({
          where: { id: requestFilters.vendedorId! },
          select: { ventana: { select: { bancaId: true } } },
        }),
        { context: 'rbac.applyRbacFilters.adminVendedor' }
      );
      
      if (vendedor && vendedor.ventana?.bancaId !== effectiveBancaId) {
        delete effective.bancaId;
      }
    }
  }
  return effective;
}

async function applyBancaStrategy(
  context: AuthContext,
  requestFilters: RequestFilters
): Promise<EffectiveFilters> {
  const effective: EffectiveFilters = { ...requestFilters };
  // BANCA: siempre filtrar por su propia banca
  const bancaId = context.bancaId;

  if (!bancaId) {
    throw new AppError('BANCA user must have bancaId assigned', 403, {
      code: 'RBAC_006',
      details: [{ field: 'bancaId', reason: 'User configuration error: BANCA role requires bancaId' }]
    });
  }

  effective.bancaId = bancaId;

  // Si solicita un ventanaId específico, validar que pertenezca a su banca
  if (requestFilters.ventanaId) {
    const ventana = await withConnectionRetry(
      () => prisma.ventana.findUnique({
        where: { id: requestFilters.ventanaId! },
        select: { bancaId: true }
      }),
      { context: 'rbac.applyRbacFilters.bancaVentanaValidate' }
    );

    if (!ventana || ventana.bancaId !== bancaId) {
      throw new AppError('Cannot access that ventana', 403, {
        code: 'RBAC_007',
        details: [{ field: 'ventanaId', reason: 'Ventana does not belong to your banca' }]
      });
    }
    effective.ventanaId = requestFilters.ventanaId;
  }

  // Si solicita un vendedorId específico, validar que pertenezca a una ventana de su banca
  if (requestFilters.vendedorId) {
    const vendedor = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: requestFilters.vendedorId! },
        select: { ventana: { select: { bancaId: true } } }
      }),
      { context: 'rbac.applyRbacFilters.bancaVendedorValidate' }
    );

    if (!vendedor || vendedor.ventana?.bancaId !== bancaId) {
      throw new AppError('Cannot access that vendedor', 403, {
        code: 'RBAC_008',
        details: [{ field: 'vendedorId', reason: 'Vendedor does not belong to your banca' }]
      });
    }
    effective.vendedorId = requestFilters.vendedorId;
  }
  return effective;
}

type RbacStrategy = (context: AuthContext, requestFilters: RequestFilters) => Promise<EffectiveFilters>;

const rbacStrategies: Record<Role, RbacStrategy> = {
  [Role.VENDEDOR]: applyVendedorStrategy,
  [Role.VENTANA]: applyVentanaStrategy,
  [Role.ADMIN]: applyAdminStrategy,
  [Role.BANCA]: applyBancaStrategy,
};

/**
 * Aplica filtros de RBAC automáticamente según el rol del usuario.
 *
 * Reglas:
 * - VENDEDOR: siempre filtro vendedorId = userId; ignora otros vendedorId/ventanaId
 * - VENTANA: siempre filtro ventanaId = JWT.ventanaId; permite vendedorId si pertenece a la ventana
 * - BANCA: siempre filtro por su propia banca
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
  const strategy = rbacStrategies[context.role];
  if (!strategy) {
    throw new AppError(`No RBAC strategy defined for role: ${context.role}`, 403);
  }
  return strategy(context, requestFilters);
}
