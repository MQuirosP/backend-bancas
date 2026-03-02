import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import UserService from '../services/user.service';
import ActivityService from '../../../core/activity.service';
import { logger } from '../../../core/logger';
import prisma from '../../../core/prismaClient';
import { withConnectionRetry } from '../../../core/withConnectionRetry';
import { ActivityType, Role } from '@prisma/client';
import { success, created } from '../../../utils/responses';
import { RequestContext } from '../dto/auth.dto';
import { AppError } from '../../../core/errors';

// Helper para extraer contexto del request
function getRequestContext(req: Request): RequestContext {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ipAddress = typeof forwardedFor === 'string'
    ? forwardedFor.split(',')[0].trim()
    : req.ip || req.socket?.remoteAddress || undefined;

  return {
    userAgent: req.headers['user-agent'],
    ipAddress,
  };
}

export const AuthController = {
  async register(req: Request, res: Response) {
    const user = await AuthService.register(req.body);

    logger.info({
      layer: 'controller',
      action: ActivityType.USER_CREATE,
      userId: user.id,
      payload: { username: user.username },
    });

    await ActivityService.log({
      userId: user.id,
      action: ActivityType.USER_CREATE,
      targetType: 'USER',
      targetId: user.id,
      details: { 
        username: user.username,
        email: user.email,
        role: user.role,
        description: `Nuevo usuario registrado: ${user.username} (${user.name || 'Sin nombre'}) con rol ${user.role}`
      },
      layer: 'controller'
    });

    return created(res, {
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    });
  },

  async login(req: Request, res: Response) {
    const context = getRequestContext(req);
    const { accessToken, refreshToken } = await AuthService.login(req.body, context);

    return success(res, { accessToken, refreshToken });
  },

  async refresh(req: Request, res: Response) {
    const { refreshToken } = req.body;
    const context = getRequestContext(req);
    const tokens = await AuthService.refresh(refreshToken, context);
    return success(res, tokens);
  },

  async logout(req: Request, res: Response) {
    const { refreshToken } = req.body;
    await AuthService.logout(refreshToken);
    return success(res, { message: 'Logged out successfully' });
  },

  async me(req: Request, res: Response) {
    const userId = (req as any).user?.id;
    const userRole = (req as any).user?.role;
    const u = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          name: true,
          role: true,
          ventanaId: true,
          settings: true,
          platform: true,
          appVersion: true,
        },
      }),
      { context: 'AuthController.me.user' }
    );

    if (!u) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    // Para usuarios ADMIN, obtener todas las bancas activas (filtro de vista)
    let bancas: Array<{
      id: string;
      name: string;
      code: string;
      isActive: boolean;
    }> = [];
    let activeBancaId: string | null = null;

    if (userRole === Role.ADMIN) {
      // Obtener todas las bancas activas (sin asignación)
      const allBancas = await withConnectionRetry(
        () => prisma.banca.findMany({
          where: {
            isActive: true,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
          },
          orderBy: {
            name: 'asc',
          },
        }),
        { context: 'AuthController.me.bancas' }
      );

      bancas = allBancas.map(b => ({
        id: b.id,
        name: b.name,
        code: b.code,
        isActive: b.isActive,
      }));

      // Obtener banca activa del contexto (header X-Active-Banca-Id)
      const bancaContext = (req as any).bancaContext;
      activeBancaId = bancaContext?.bancaId || null;
    }

    // Normalización según rol:
    // - VENDEDOR: vendedorId = id, ventanaId = u.ventanaId
    // - VENTANA:  ventanaId = u.ventanaId, vendedorId = null
    // - ADMIN:    vendedorId = null, ventanaId = null, bancas = [...]
    const payload = {
      id: u.id,
      email: u.email,
      username: u.username,
      name: u.name,
      role: u.role,
      settings: u.settings,
      platform: u.platform,
      appVersion: u.appVersion,
      vendedorId: u.role === Role.VENDEDOR ? u.id : null,
      ventanaId:
        u.role === Role.VENTANA
          ? u.ventanaId
          : u.role === Role.VENDEDOR
            ? u.ventanaId ?? null
            : null,
      ...(userRole === Role.ADMIN && {
        bancas,
        activeBancaId,
      }),
    };

    return success(res, payload);
  },

  async setActiveBanca(req: Request, res: Response) {
    const user = (req as any).user;
    const { bancaId } = req.body;

    // Validar que el usuario es ADMIN
    if (user.role !== Role.ADMIN) {
      return res.status(403).json({
        success: false,
        message: 'Solo usuarios ADMIN pueden cambiar de banca activa',
      });
    }

    // Validar que la banca existe y está activa (sin validar asignación)
    const banca = await withConnectionRetry(
      () => prisma.banca.findUnique({
        where: { id: bancaId },
        select: {
          id: true,
          name: true,
          code: true,
          isActive: true,
        },
      }),
      { context: 'AuthController.setActiveBanca' }
    );

    if (!banca) {
      return res.status(404).json({
        success: false,
        message: 'Banca no encontrada',
      });
    }

    if (!banca.isActive) {
      return res.status(400).json({
        success: false,
        message: 'La banca seleccionada está inactiva',
      });
    }

    // Retornar éxito (el frontend manejará el header en futuras requests)
    return success(res, {
      activeBancaId: bancaId,
      banca: {
        id: banca.id,
        name: banca.name,
        code: banca.code,
      },
    }, {
      message: 'Banca activa establecida correctamente. Usa el header X-Active-Banca-Id en las siguientes peticiones.',
    });
  },

  /**
   * Actualiza el perfil del usuario autenticado
   * Permite actualizar: name, email, phone, username, password, settings
   * NO permite actualizar: role, ventanaId, code, isActive (solo ADMIN puede hacerlo vía /users/:id)
   */
  async updateMe(req: Request, res: Response) {
    const actor = (req as any)?.user;
    const actorId = actor?.id;
    const requestId = (req as any)?.requestId ?? null;

    if (!actorId) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado',
      });
    }

    // Restricciones: el usuario no puede cambiar su propio role, ventanaId, code, isActive
    const restrictedFields = ['role', 'ventanaId', 'code', 'isActive'];
    const body = { ...req.body };
    
    for (const field of restrictedFields) {
      if (body[field] !== undefined) {
        return res.status(403).json({
          success: false,
          message: `No puedes modificar el campo ${field}. Contacta a un administrador.`,
        });
      }
    }

    // Actualizar usando el servicio de usuarios con el ID del usuario autenticado
    const user = await UserService.update(actorId, body, actor);

    logger.info({
      layer: 'controller',
      action: 'USER_UPDATE_SELF',
      userId: actorId,
      payload: { changes: Object.keys(body) },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.USER_UPDATE,
      targetType: 'USER',
      targetId: actorId,
      details: { 
        fields: Object.keys(body), 
        selfUpdate: true,
        description: `El usuario ${actor.username} actualizó su propio perfil. Campos modificados: ${Object.keys(body).join(', ')}`
      },
      layer: 'controller',
      requestId
    }).catch(err => {
      logger.error({
        layer: 'controller',
        action: 'ACTIVITY_LOG_FAIL',
        userId: actorId,
        requestId,
        payload: { error: err.message },
      });
    });

    return success(res, user);
  },

  /**
   * GET /auth/sessions/user/:userId
   * Lista las sesiones activas de un usuario específico (para ADMIN)
   */
  async getUserSessions(req: Request, res: Response) {
    const actor = (req as any).user;
    const { userId } = req.params;

    if (!actor) {
      throw new AppError('Unauthorized', 401);
    }

    // Solo ADMIN puede ver sesiones de otros usuarios
    if (actor.role !== Role.ADMIN && actor.id !== userId) {
      throw new AppError('No tiene permisos para ver las sesiones de este usuario', 403);
    }

    // Verificar que el usuario existe
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });

    if (!targetUser) {
      throw new AppError('Usuario no encontrado', 404);
    }

    const sessions = await AuthService.getUserSessions(userId);

    return success(res, sessions);
  },

  /**
   * DELETE /auth/sessions/:sessionId
   * Revoca una sesión específica
   */
  async revokeSession(req: Request, res: Response) {
    const actor = (req as any).user;
    const { sessionId } = req.params;

    if (!actor) {
      throw new AppError('Unauthorized', 401);
    }

    const isAdmin = actor.role === Role.ADMIN;
    await AuthService.revokeSession(actor.id, sessionId, isAdmin);

    return success(res, { message: 'Session revoked' });
  },

  /**
   * POST /auth/logout/all
   * Cierra todas las sesiones del usuario autenticado
   */
  async logoutAll(req: Request, res: Response) {
    const actor = (req as any).user;

    if (!actor) {
      throw new AppError('Unauthorized', 401);
    }

    const result = await AuthService.logoutAll(actor.id);

    logger.info({
      layer: 'controller',
      action: 'LOGOUT_ALL',
      userId: actor.id,
      payload: { revokedCount: result.count },
    });

    return success(res, { message: `${result.count} sessions revoked` });
  },
};
