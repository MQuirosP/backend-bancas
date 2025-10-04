import { Request, Response } from 'express';
import { AuthService } from '../services/auth.service';
import { logger } from '../../../core/logger';
import prisma from '../../../core/prismaClient';
import { ActivityType } from '@prisma/client';

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

    res.status(201).json({
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, role: user.role },
    });
  },

  async login(req: Request, res: Response) {
    const tokens = await AuthService.login(req.body);

    // obtener usuario para log y actividad
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });

    if (user) {
      logger.info({
        layer: 'controller',
        action: ActivityType.LOGIN,
        userId: user.id,
        payload: { email: user.email },
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

    res.json(tokens);
  },

  async refresh(req: Request, res: Response) {
    const { refreshToken } = req.body;
    const tokens = await AuthService.refresh(refreshToken);
    res.json(tokens);
  },

  async logout(req: Request, res: Response) {
    const { refreshToken } = req.body;
    await AuthService.logout(refreshToken);
    res.json({ message: 'Logged out successfully' });
  },

  async me(req: Request, res: Response) {
    const userId = (req as any).user?.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true },
    });

    res.json(user);
  },
};
