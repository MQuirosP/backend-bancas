import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../../core/prismaClient';
import { config } from '../../../config';
import { RegisterDTO, LoginDTO, TokenPair } from '../dto/auth.dto';
import { AppError } from '../../../core/errors';
import { v4 as uuidv4 } from 'uuid';
import { comparePassword, hashPassword } from '../../../utils/crypto';

const ACCESS_SECRET = config.jwtAccessSecret;
const REFRESH_SECRET = config.jwtRefreshSecret;

export const AuthService = {
  async register(data: RegisterDTO) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new AppError('Email is already in use', 409);
    }

    const hashed = await hashPassword(data.password);
    const role = data.role ?? 'VENTANA';

    // Prevent public registration from creating ADMIN users
    if (role === 'ADMIN') {
      throw new AppError('ADMIN users must be created by system administrator', 403);
    }

    // Validar que VENTANA y VENDEDOR tengan ventanaId
    if ((role === 'VENTANA' || role === 'VENDEDOR') && !data.ventanaId) {
      throw new AppError('ventanaId is required for VENTANA and VENDEDOR roles', 400);
    }

    // Validar que ventanaId existe Y está activo (incluyendo parent banca)
    if (data.ventanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: data.ventanaId },
        select: { id: true, isActive: true, banca: { select: { id: true, isActive: true } } },
      });
      if (!ventana || !ventana.isActive) {
        throw new AppError('Ventana not found or inactive', 404);
      }
      if (!ventana.banca || !ventana.banca.isActive) {
        throw new AppError('Parent Banca inactive', 409);
      }
    }

    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        username: data.username,
        password: hashed,
        role,
        ventanaId: data.ventanaId ?? null,
      },
    });

    return user;
  },

  async login(data: LoginDTO): Promise<TokenPair> {
    const user = await prisma.user.findUnique({ where: { username: data.username } });
    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.isActive || user.deletedAt) {
      throw new AppError('La cuenta está inactiva. Contacta al administrador.', 403, 'USER_INACTIVE');
    }

    const match = await comparePassword(data.password, user.password);
    if (!match) {
      throw new AppError('Invalid credentials', 401);
    }

    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        ventanaId: user.ventanaId ?? null,
      },
      ACCESS_SECRET,
      { expiresIn: config.jwtAccessExpires as jwt.SignOptions['expiresIn'] }
    );

    const refreshToken = uuidv4();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpires)),
      },
    });

    const signedRefresh = jwt.sign({ tid: refreshToken }, REFRESH_SECRET, {
      expiresIn: config.jwtRefreshExpires as jwt.SignOptions['expiresIn'],
    });

    return { accessToken, refreshToken: signedRefresh };
  },

  async refresh(refreshToken: string): Promise<TokenPair> {
    try {
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;
      const tokenRecord = await prisma.refreshToken.findUnique({
        where: { token: decoded.tid },
      });

      if (!tokenRecord || tokenRecord.revoked || tokenRecord.expiresAt < new Date()) {
        throw new AppError('Invalid refresh token', 401);
      }

      const user = await prisma.user.findUnique({ where: { id: tokenRecord.userId } });
      if (!user) throw new AppError('User not found', 404);

      const accessToken = jwt.sign(
        {
          sub: user.id,
          role: user.role,
          ventanaId: user.ventanaId ?? null,
        },
        ACCESS_SECRET,
        { expiresIn: config.jwtAccessExpires as jwt.SignOptions['expiresIn'] }
      );

      return { accessToken, refreshToken };
    } catch {
      throw new AppError('Invalid refresh token', 401);
    }
  },

  async logout(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;
      await prisma.refreshToken.update({
        where: { token: decoded.tid },
        data: { revoked: true },
      });
    } catch {
      // ignore errors to avoid leaking info
    }
  },
};

// helper to convert ms-like strings (e.g. "7d") to ms
function ms(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid time format: ${value}`);
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return num * 1000;
    case 'm': return num * 60 * 1000;
    case 'h': return num * 60 * 60 * 1000;
    case 'd': return num * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}
