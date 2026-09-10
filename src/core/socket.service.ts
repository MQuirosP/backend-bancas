import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import logger from './logger';
import { Role } from '../generated/prisma/client';
import { getCachedUser, UserSession } from '../middlewares/auth.middleware';

export const SocketEvents = {
  SORTEO_EVALUADO: 'sorteo:evaluado',
  BANCA_SWITCH: 'banca:switch',
} as const;

export const SocketRooms = {
  vendedores: 'vendedores',
  ventanas: 'ventanas',
  admins: 'admins',
  banca: (bancaId: string) => `banca:${bancaId}`,
  bancaVendedores: (bancaId: string) => `banca:${bancaId}:vendedores`,
  bancaVentanas: (bancaId: string) => `banca:${bancaId}:ventanas`,
  user: (userId: string) => `user:${userId}`,
};

export interface SorteoEvaluatedPayload {
  sorteoId: string;
  sorteoNombre: string;
  loteriaNombre?: string;
  winningNumber: string;
  extraOutcomeCode: string | null;
  scheduledAt: string;
  bancaId: string | null;
  evaluatedAt: string;
}

export class SocketService {
  private static io: SocketIOServer | null = null;

  static init(server: HTTPServer): SocketIOServer {
    if (this.io) {
      return this.io;
    }

    this.io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Middleware de autenticación JWT
    this.io.use(async (socket: Socket, next) => {
      try {
        const token =
          socket.handshake.auth?.token ||
          (socket.handshake.headers?.authorization
            ? socket.handshake.headers.authorization.replace(/^Bearer\s+/i, '')
            : null);

        if (!token) {
          return next(new Error('Authentication token missing'));
        }

        const decoded = jwt.verify(token, config.jwtAccessSecret, { clockTolerance: 90 }) as {
          sub?: string;
        };

        if (!decoded.sub) {
          return next(new Error('Invalid token payload'));
        }

        const user = await getCachedUser(decoded.sub);
        if (!user || !user.isActive) {
          return next(new Error('User not found or inactive'));
        }

        socket.data.user = user;
        next();
      } catch (err: any) {
        logger.warn({
          layer: 'socket',
          action: 'AUTH_FAILED',
          meta: { error: err?.message || String(err) },
        });
        next(new Error('Invalid or expired token'));
      }
    });

    // Conexión y asignación a salas multi-tenant
    this.io.on('connection', (socket: Socket) => {
      const user: UserSession | undefined = socket.data.user;

      if (user?.role === Role.VENDEDOR) {
        socket.join(SocketRooms.vendedores);
        if (user.bancaId) {
          socket.join(SocketRooms.bancaVendedores(user.bancaId));
        }
      }

      if (user?.role === Role.VENTANA) {
        socket.join(SocketRooms.ventanas);
        if (user.bancaId) {
          socket.join(SocketRooms.bancaVentanas(user.bancaId));
        }
      }

      if (user?.role === Role.ADMIN || user?.role === Role.BANCA) {
        socket.join(SocketRooms.admins);
      }

      // Manejador para que administradores o bancas cambien dinámicamente de banca activa
      socket.on(SocketEvents.BANCA_SWITCH, (data: { bancaId?: string }) => {
        if (user?.role === Role.ADMIN || user?.role === Role.BANCA) {
          for (const room of socket.rooms) {
            if (room.startsWith('banca:')) {
              socket.leave(room);
            }
          }
          if (data?.bancaId) {
            socket.join(SocketRooms.banca(data.bancaId));
          }
        }
      });

      if (user?.bancaId) {
        socket.join(SocketRooms.banca(user.bancaId));
      }

      if (user?.id) {
        socket.join(SocketRooms.user(user.id));
      }

      logger.info({
        layer: 'socket',
        action: 'CLIENT_CONNECTED',
        payload: {
          socketId: socket.id,
          userId: user?.id,
          role: user?.role,
          bancaId: user?.bancaId,
        },
      });

      socket.on('disconnect', (reason) => {
        logger.info({
          layer: 'socket',
          action: 'CLIENT_DISCONNECTED',
          payload: {
            socketId: socket.id,
            userId: user?.id,
            reason,
          },
        });
      });
    });

    logger.info({
      layer: 'socket',
      action: 'SOCKET_SERVER_INITIALIZED',
      payload: { message: 'Socket.io server initialized successfully' },
    });

    return this.io;
  }

  static getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Notifica la evaluación de un sorteo exclusivamente a la sala de la banca
   */
  static notifySorteoEvaluated(payload: SorteoEvaluatedPayload): void {
    if (!this.io) {
      logger.warn({
        layer: 'socket',
        action: 'EMIT_SKIPPED_NOT_INITIALIZED',
        payload: { sorteoId: payload.sorteoId },
      });
      return;
    }

    const room = payload.bancaId ? SocketRooms.banca(payload.bancaId) : SocketRooms.vendedores;
    this.io.to(room).emit(SocketEvents.SORTEO_EVALUADO, payload);

    logger.info({
      layer: 'socket',
      action: 'SORTEO_EVALUATED_BROADCAST',
      payload: {
        room,
        sorteoId: payload.sorteoId,
        winningNumber: payload.winningNumber,
        extraOutcomeCode: payload.extraOutcomeCode,
      },
    });
  }
}
