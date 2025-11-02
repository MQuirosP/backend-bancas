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

    // Normalización según rol:
    // - VENDEDOR: vendedorId = id, ventanaId = u.ventanaId
    // - VENTANA:  ventanaId = u.ventanaId, vendedorId = null
    // - ADMIN:    vendedorId = null, ventanaId = null
    const payload = u && {
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
    };

    return success(res, payload);
  },
};
