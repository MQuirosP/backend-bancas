import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

// Extender el Request de Express para incluir el usuario autenticado
interface CustomRequest extends Request {
  user?: {
    id: string;
    role: Role;
    ventanaId?: string | null;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'your_fallback_secret_key';

/**
 * Middleware para proteger rutas: verifica el JWT y adjunta el usuario al request.
 */
export const protect = async (req: CustomRequest, res: Response, next: NextFunction) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ status: 'fail', message: 'Acceso denegado. No se encontró el token.' });
  }

  try {
    // 1. Verificar el token
    const decoded: any = jwt.verify(token, JWT_SECRET);

    // 2. Buscar el usuario (opcional, pero asegura que el usuario no fue eliminado)
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id, isDeleted: false },
      select: { id: true, role: true, ventanaId: true },
    });

    if (!currentUser) {
      return res.status(401).json({ status: 'fail', message: 'El usuario del token ya no existe o está inactivo.' });
    }

    // 3. Adjuntar el usuario al Request
    req.user = currentUser;
    next();
  } catch (err) {
    return res.status(401).json({ status: 'fail', message: 'Token inválido o expirado.' });
  }
};

/**
 * Middleware para restringir el acceso a roles específicos (CRÍTICO para seguridad).
 */
export const restrictTo = (...roles: Role[]) => {
  return (req: CustomRequest, res: Response, next: NextFunction) => {
    // Si el usuario no está adjunto (no pasó el middleware 'protect'), esto fallaría antes.
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        message: 'No tiene permiso para realizar esta acción. Acceso restringido.',
      });
    }
    next();
  };
};

export default { protect, restrictTo };
