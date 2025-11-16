import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { logger } from '../../../core/logger';
import prisma from '../../../core/prismaClient';
import { ActivityType, Role } from '@prisma/client';
import { success, created } from '../../../utils/responses';

export const AuthController = {
  async register(req: Request, res: Response) {
    const user = await AuthService.register(req.body);

    logger.info({
      layer: 'controller',
      action: ActivityType.USER_CREATE,
      userId: user.id,
      payload: { email: user.email },
    });

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        action: ActivityType.USER_CREATE,
        targetType: 'USER',
        targetId: user.id,
        details: { email: user.email },
      },
    });

    return created(res, {
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, username: user.username, role: user.role },
    });
  },

  async login(req: Request, res: Response) {
    const tokens = await AuthService.login(req.body);

    const user = await prisma.user.findUnique({ where: { username: req.body.username } });

    if (user) {
      logger.info({
        layer: 'controller',
        action: ActivityType.LOGIN,
        userId: user.id,
        payload: { username: user.username },
      });

      await prisma.activityLog.create({
        data: {
          userId: user.id,
          action: ActivityType.LOGIN,
          targetType: 'USER',
          targetId: user.id,
          details: { email: user.email },
        },
      });
    }
    console.log("")
    return success(res, tokens);
  },

  async refresh(req: Request, res: Response) {
    const { refreshToken } = req.body;
    const tokens = await AuthService.refresh(refreshToken);
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
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        role: true,
        ventanaId: true,
        settings: true,
      },
    });

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
      const allBancas = await prisma.banca.findMany({
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
      });

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
    const banca = await prisma.banca.findUnique({
      where: { id: bancaId },
      select: {
        id: true,
        name: true,
        code: true,
        isActive: true,
      },
    });

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
};
