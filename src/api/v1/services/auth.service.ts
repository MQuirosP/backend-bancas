import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../../core/prismaClient';
import { config } from '../../../config';
import { RegisterDTO, LoginDTO, TokenPair, RequestContext } from '../dto/auth.dto';
import { AppError } from '../../../core/errors';
import { v4 as uuidv4 } from 'uuid';
import { comparePassword, hashPassword } from '../../../utils/crypto';
import { logger } from '../../../core/logger';
import ActivityService from '../../../core/activity.service';
import { ActivityType, Role, Prisma } from '@prisma/client';
import { withConnectionRetry } from '../../../core/withConnectionRetry';
import { CacheService } from '../../../core/cache.service';

const ACCESS_SECRET = config.jwtAccessSecret;
const REFRESH_SECRET = config.jwtRefreshSecret;

// Interface para sesiones activas
export interface Session {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  ipAddress: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  current?: boolean;
}

export const AuthService = {
  async register(data: RegisterDTO) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing) {
      throw new AppError('Email is already in use', 409);
    }

    const hashed = await hashPassword(data.password);
    const role = data.role ?? Role.VENTANA;

    // Prevent public registration from creating ADMIN or BANCA users
    if (role === Role.ADMIN || role === Role.BANCA) {
      throw new AppError('ADMIN and BANCA users must be created by system administrator', 403);
    }

    // Validar que VENTANA y VENDEDOR tengan ventanaId
    if ((role === Role.VENTANA || role === Role.VENDEDOR) && !data.ventanaId) {
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

  async login(
    data: LoginDTO,
    context?: RequestContext
  ): Promise<TokenPair & { user: { id: string; username: string; email: string | null; role: Role; ventanaId: string | null; bancaId: string | null; ventana?: any } }> {
    const { username, password } = data;
    const { ipAddress, userAgent } = context || {};

    const user = await withConnectionRetry(
      () => prisma.user.findUnique({
        where: { username },
        include: {
          ventana: {
            include: {
              banca: true,
            },
          },
        },
      }),
      { context: 'auth.login' }
    );
    
    if (!user) {
      await ActivityService.log({
        action: ActivityType.LOGIN,
        targetType: 'USER',
        bancaId: null,
        details: { 
          username, ipAddress, userAgent,
          reason: 'User not found',
          description: `Intento de inicio de sesión FALLIDO para el usuario ${username}. Razón: Usuario no encontrado.`
        },
        layer: 'service'
      });
      throw new AppError('Invalid credentials', 401);
    }

    if (!user.isActive || user.deletedAt) {
      await ActivityService.log({
        userId: user.id,
        bancaId: user.bancaId,
        action: ActivityType.LOGIN,
        targetType: 'USER',
        targetId: user.id,
        details: { 
          username, ipAddress, userAgent,
          reason: 'User inactive',
          description: `Intento de inicio de sesión FALLIDO para el usuario ${username} (${user.name}). Razón: Cuenta inactiva.`
        },
        layer: 'service'
      });
      throw new AppError('La cuenta está inactiva. Contacta al administrador.', 403, 'USER_INACTIVE');
    }

    const match = await comparePassword(password, user.password);
    if (!match) {
      await ActivityService.log({
        userId: user.id,
        bancaId: user.bancaId,
        action: ActivityType.LOGIN,
        targetType: 'USER',
        targetId: user.id,
        details: { 
          username, ipAddress, userAgent,
          reason: 'Invalid password',
          description: `Intento de inicio de sesión FALLIDO para el usuario ${username} (${user.name}). Razón: Contraseña incorrecta.`
        },
        layer: 'service'
      });
      throw new AppError('Invalid credentials', 401);
    }

    // Actualizar platform y appVersion si vienen en el request
    const updateData: { platform?: string; appVersion?: string } = {};
    if (data.platform) {
      updateData.platform = data.platform;
    }
    if (data.appVersion) {
      updateData.appVersion = data.appVersion;
    }

    // Si hay datos para actualizar, hacerlo ahora
    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: updateData,
      });
    }

    // Obtener bancaId desde ventana para incluirlo en JWT (evita query en bancaContext middleware)
    let bancaId: string | null = null;
    if (user.ventanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: user.ventanaId },
        select: { bancaId: true },
      });
      bancaId = ventana?.bancaId ?? null;
    } else {
      // Fallback para usuarios con rol BANCA o ADMIN que tienen bancaId directo
      bancaId = user.bancaId;
    }

    let refreshTokenRaw: string;

    if (user.role === Role.VENDEDOR && bancaId) {
      // VENDEDOR: Transacción con pool check
      refreshTokenRaw = await withConnectionRetry(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // STEP 1: Lock exclusivo en Banca
        const [banca] = await tx.$queryRaw<
          [{ vendorLimit: number | null; maxSessionsPerVendedor: number }]
        >`
          SELECT "vendorLimit", "maxSessionsPerVendedor"
          FROM "Banca"
          WHERE id = ${bancaId}::uuid
          FOR UPDATE
        `;

        // Límite de sesiones individuales de este vendedor
        // User settings could override banca setting, but for now we query the user's direct maxSessionsPerVendedor
        // We already fetched user, let's see if we have maxSessionsPerVendedor on user object. Wait, it's not in the select of findUnique in login. Let's do a quick query.
        const userOverride = await tx.user.findUnique({
          where: { id: user.id },
          select: { maxSessionsPerVendedor: true },
        });

        const sessionLimit = userOverride?.maxSessionsPerVendedor ?? banca?.maxSessionsPerVendedor ?? 1;

        // STEP 2: Obtener sesiones activas del propio VENDEDOR ordenadas por desuso (FIFO)
        const activeSessions = await tx.refreshToken.findMany({
          where: {
            userId: user.id,
            revoked: false,
            expiresAt: { gt: new Date() },
          },
          orderBy: {
            lastUsedAt: 'asc', // De la más antigua (inactiva) a la más nueva
          },
          select: {
            id: true,
          },
        });

        const userSessionCount = activeSessions.length;

        // STEP 3: Si se supera o iguala el límite, desplazar la más antigua
        if (userSessionCount >= sessionLimit) {
          const sessionsToRevokeCount = userSessionCount - sessionLimit + 1;
          const sessionsToRevoke = activeSessions.slice(0, sessionsToRevokeCount);
          const sessionIdsToRevoke = sessionsToRevoke.map((s) => s.id);

          await tx.refreshToken.updateMany({
            where: {
              id: { in: sessionIdsToRevoke },
            },
            data: {
              revoked: true,
              revokedAt: new Date(),
              revokedReason: 'fifo_displacement',
            },
          });

          // Invalida el caché en memoria para este usuario
          await CacheService.del(`auth:session:${user.id}`);

          logger.info({
            layer: 'service',
            action: 'SESSION_FIFO_DISPLACEMENT',
            userId: user.id,
            payload: {
              revokedSessions: sessionIdsToRevoke,
              totalSessions: userSessionCount,
              limit: sessionLimit,
            },
          });
        }

        // STEP 4: COUNT sesiones activas del pool de la banca
        if (banca?.vendorLimit != null) {
          const poolCount = await tx.refreshToken.count({
            where: {
              bancaId,
              revoked: false,
              expiresAt: { gt: new Date() },
            },
          });

          // STEP 5: Validar pool global
          if (poolCount >= banca.vendorLimit) {
            throw new AppError(
              `El pool de vendedores está lleno (${poolCount}/${banca.vendorLimit} sesiones activas).`,
              429,
              'POOL_EXHAUSTED'
            );
          }
        }

        // STEP 6: Crear nueva sesión dentro de la misma TX
        const token = uuidv4();
        await tx.refreshToken.create({
          data: {
            userId: user.id,
            bancaId,
            token,
            expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpires)),
            deviceId: data.deviceId ?? null,
            deviceName: data.deviceName ?? null,
            userAgent: context?.userAgent ?? null,
            ipAddress: context?.ipAddress ?? null,
            lastUsedAt: new Date(),
          },
        });

        return token;
      }, { isolationLevel: 'Serializable' }), { context: 'login.poolCheck' });

    } else {
      // No-VENDEDOR: comportamiento actual sin cambios
      if (data.deviceId) {
        const revokedCount = await prisma.refreshToken.updateMany({
          where: {
            userId: user.id,
            deviceId: data.deviceId,
            revoked: false,
          },
          data: {
            revoked: true,
            revokedAt: new Date(),
            revokedReason: 'new_login',
          },
        });

        if (revokedCount.count > 0) {
          logger.info({
            layer: 'service',
            action: 'REVOKE_DEVICE_TOKENS',
            userId: user.id,
            payload: { deviceId: data.deviceId, revokedCount: revokedCount.count },
          });
        }
      }

      refreshTokenRaw = uuidv4();

      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          bancaId,
          token: refreshTokenRaw,
          expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpires)),
          deviceId: data.deviceId ?? null,
          deviceName: data.deviceName ?? null,
          userAgent: context?.userAgent ?? null,
          ipAddress: context?.ipAddress ?? null,
          lastUsedAt: new Date(),
        },
      });
    }

    // Invalida el caché de sesión de forma incondicional para asegurar que el nuevo token
    // esté en la lista activeSessionIds en la próxima consulta
    await CacheService.del(`auth:session:${user.id}`).catch(() => {});

    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        ventanaId: user.ventanaId ?? null,
        bancaId,
        sid: refreshTokenRaw, // Unique session identifier for real-time verification
      },
      ACCESS_SECRET,
      { expiresIn: config.jwtAccessExpires as jwt.SignOptions['expiresIn'] }
    );

    const signedRefresh = jwt.sign({ tid: refreshTokenRaw }, REFRESH_SECRET, {
      expiresIn: config.jwtRefreshExpires as jwt.SignOptions['expiresIn'],
    });

    // Log success asíncrono
    ActivityService.log({
      userId: user.id,
      bancaId: user.bancaId,
      action: ActivityType.LOGIN,
      targetType: 'USER',
      targetId: user.id,
      details: {
        username: user.username,
        deviceId: data.deviceId,
        deviceName: data.deviceName,
        ipAddress,
        userAgent,
        description: `Inicio de sesión exitoso para el usuario ${user.username} (${user.name})${data.deviceName ? ` desde el dispositivo ${data.deviceName}` : ''}`
      },
      layer: 'service'
    }).catch(err => {
      logger.error({
        layer: 'service',
        action: 'ACTIVITY_LOG_FAIL',
        payload: { error: err.message, userId: user.id },
      });
    });

    return {
      accessToken,
      refreshToken: signedRefresh,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        ventanaId: user.ventanaId,
        bancaId: bancaId,
        ventana: (user as any).ventana ? {
          id: (user as any).ventana.id,
          bancaId: (user as any).ventana.bancaId,
          name: (user as any).ventana.name,
          code: (user as any).ventana.code,
          banca: (user as any).ventana.banca ? {
            id: (user as any).ventana.banca.id,
            name: (user as any).ventana.banca.name,
            code: (user as any).ventana.banca.code,
          } : null
        } : null
      }
    };
  },

  async refresh(refreshToken: string, context?: RequestContext): Promise<TokenPair> {
    let decoded: { tid: string };
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET) as { tid: string };
    } catch {
      throw new AppError('Invalid refresh token', 401);
    }

    const tokenRecord = await withConnectionRetry(
      () => prisma.refreshToken.findUnique({
        where: { token: decoded.tid },
      }),
      { context: 'authRefresh.findToken', maxRetries: 2 }
    );

    if (!tokenRecord || tokenRecord.revoked || tokenRecord.expiresAt < new Date()) {
      throw new AppError('Invalid refresh token', 401);
    }

    const user = await withConnectionRetry(
      () => prisma.user.findUnique({ where: { id: tokenRecord.userId } }),
      { context: 'authRefresh.findUser', maxRetries: 2 }
    );
    if (!user) throw new AppError('User not found', 404);

    // Verificar si el usuario sigue activo
    if (!user.isActive || user.deletedAt) {
      // Revocar el token si el usuario está inactivo
      await prisma.refreshToken.update({
        where: { id: tokenRecord.id },
        data: {
          revoked: true,
          revokedAt: new Date(),
          revokedReason: 'user_inactive',
        },
      });
      throw new AppError('La cuenta está inactiva.', 403, 'USER_INACTIVE');
    }

    // ROTACIÓN ATÓMICA: Revocar token actual + crear nuevo en una sola transacción
    // Si la DB falla a mitad de camino, la transacción hace rollback
    // y el token original sigue válido (el usuario puede reintentar)
    let bancaId: string | null = null;
    if (user.ventanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: user.ventanaId },
        select: { bancaId: true },
      });
      bancaId = ventana?.bancaId ?? null;
    } else {
      bancaId = user.bancaId;
    }
    
    const newRefreshTokenId = uuidv4();
    await withConnectionRetry(
      () => prisma.$transaction([
        prisma.refreshToken.update({
          where: { id: tokenRecord.id },
          data: {
            revoked: true,
            revokedAt: new Date(),
            revokedReason: 'rotation',
          },
        }),
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            bancaId,
            token: newRefreshTokenId,
            expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpires)),
            // Heredar datos del dispositivo del token anterior
            deviceId: tokenRecord.deviceId,
            deviceName: tokenRecord.deviceName,
            userAgent: context?.userAgent ?? tokenRecord.userAgent,
            ipAddress: context?.ipAddress ?? tokenRecord.ipAddress,
            lastUsedAt: new Date(),
          },
        }),
      ]),
      { context: 'authRefresh.rotateToken', maxRetries: 2 }
    );

    // Invalida el caché de sesión de forma defensiva tras la rotación de tokens
    await CacheService.del(`auth:session:${user.id}`).catch((err) => {
      logger.warn({
        layer: 'cache',
        action: 'INVALIDATE_ERROR_ON_REFRESH',
        payload: { userId: user.id, error: err.message },
      });
    });
  
    // bancaId ya fue resuelto arriba para la inyección del token

    const accessToken = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        ventanaId: user.ventanaId ?? null,
        bancaId,
        sid: newRefreshTokenId, // Unique session identifier after rotation
      },
      ACCESS_SECRET,
      { expiresIn: config.jwtAccessExpires as jwt.SignOptions['expiresIn'] }
    );

    // Firmar el NUEVO refresh token
    const signedRefresh = jwt.sign({ tid: newRefreshTokenId }, REFRESH_SECRET, {
      expiresIn: config.jwtRefreshExpires as jwt.SignOptions['expiresIn'],
    });

    return { accessToken, refreshToken: signedRefresh };
  },

  async logout(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as { tid: string };
      const tokenRecord = await prisma.refreshToken.update({
        where: { token: decoded.tid },
        data: {
          revoked: true,
          revokedAt: new Date(),
          revokedReason: 'logout',
        },
        select: { userId: true },
      });
      await CacheService.del(`auth:session:${tokenRecord.userId}`);
    } catch (error: any) {
      logger.warn({
        layer: 'service',
        action: 'LOGOUT_FAILED',
        meta: { error: error.message, tokenProvided: !!refreshToken }
      });
      // ignore errors to avoid leaking info to client, but log it internally
    }
  },

  /**
   * Cierra todas las sesiones de un usuario
   */
  async logoutAll(userId: string): Promise<{ count: number }> {
    const result = await prisma.refreshToken.updateMany({
      where: {
        userId,
        revoked: false,
      },
      data: {
        revoked: true,
        revokedAt: new Date(),
        revokedReason: 'logout_all',
      },
    });

    logger.info({
      layer: 'service',
      action: 'LOGOUT_ALL',
      userId,
      payload: { revokedCount: result.count },
    });

    return { count: result.count };
  },

  /**
   * Lista las sesiones activas de un usuario
   */
  async getUserSessions(userId: string, currentTokenId?: string): Promise<Session[]> {
    const tokens = await prisma.refreshToken.findMany({
      where: {
        userId,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        token: true,
        deviceId: true,
        deviceName: true,
        ipAddress: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    return tokens.map(t => ({
      id: t.id,
      deviceId: t.deviceId,
      deviceName: t.deviceName || 'Unknown device',
      ipAddress: t.ipAddress,
      lastUsedAt: t.lastUsedAt ?? t.createdAt,
      createdAt: t.createdAt,
      current: currentTokenId ? t.token === currentTokenId : false,
    }));
  },

  /**
   * Revoca una sesión específica
   */
  async revokeSession(requestingUserId: string, sessionId: string, isAdmin: boolean = false): Promise<void> {
    // Buscar el token
    const token = await prisma.refreshToken.findUnique({
      where: { id: sessionId },
      include: {
        user: { select: { bancaId: true } }
      }
    });

    if (!token) {
      throw new AppError('Session not found', 404);
    }

    // Obtener actor para RBAC
    const actor = await prisma.user.findUnique({
      where: { id: requestingUserId },
      select: { role: true, bancaId: true },
    });
    
    const isBancaSameTenant =
      actor?.role === Role.BANCA &&
      actor.bancaId !== null &&
      actor.bancaId === token.user?.bancaId;

    // Verificar permisos: dueño, admin, o banca del mismo tenant
    if (!isAdmin && !isBancaSameTenant && token.userId !== requestingUserId) {
      throw new AppError('No tiene permisos para revocar esta sesión', 403);
    }

    if (token.revoked) {
      throw new AppError('Session already revoked', 400);
    }

    await prisma.refreshToken.update({
      where: { id: sessionId },
      data: {
        revoked: true,
        revokedAt: new Date(),
        revokedReason: isAdmin ? 'revoked_by_admin' : 'revoked_by_user',
      },
    });

    await CacheService.del(`auth:session:${token.userId}`);

    logger.info({
      layer: 'service',
      action: 'REVOKE_SESSION',
      userId: requestingUserId,
      payload: { sessionId, targetUserId: token.userId, isAdmin },
    });
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
