import { Request, Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';

const prisma = new PrismaClient();

// Extender el Request de Express para incluir el usuario autenticado
interface CustomRequest extends Request {
  user?: {
    id: string;
    role: Role;
    ventanaId?: string;
  };
}

/**
 * Genera un JWT para un usuario
 * @param user - Objeto de usuario
 * @returns Token JWT
 */
const signToken = (id: string, role: Role, ventanaId: string | null) => {
    const secret = process.env.JWT_SECRET;
    const expiresInEnv = process.env.JWT_EXPIRES_IN;

    if (!secret || !expiresInEnv) {
        throw new Error('Variables de entorno JWT_SECRET o JWT_EXPIRES_IN no definidas.');
    }

    const payload = { id, role, ventanaId };

    // Forzamos el tipo porque sabemos que el valor de .env es compatible con ms.StringValue (por ejemplo: "1h")
    const options: SignOptions = {
        expiresIn: expiresInEnv as SignOptions['expiresIn'],
    };

    return jwt.sign(payload, secret, options);
};

// ----------------------------------------------------
// REGISTRO DE NUEVO USUARIO (ADMIN)
// ----------------------------------------------------

/**
 * Registra un nuevo usuario (solo accesible por ADMIN en una ruta separada,
 * aquí se expone para el primer setup, pero debe ser restringido).
 * (POST /api/auth/register)
 */
export const register = async (req: Request, res: Response) => {
    try {
        const { name, email, password, role, ventanaId } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ status: 'fail', message: 'Faltan campos obligatorios: name, email, password.' });
        }

        // 1. Hashear la contraseña (bcrypt)
        const hashedPassword = await bcrypt.hash(password, 12);

        // 2. Crear usuario en Prisma (CORRECCIÓN: Usar 'password' en lugar de 'passwordHash')
        const newUser = await prisma.user.create({
            data: {
                name,
                email,
                // CORRECCIÓN: el campo en el schema es 'password'
                password: hashedPassword, 
                role: role || Role.VENDEDOR, // Por defecto VENDEDOR si no se especifica
                ventanaId: ventanaId || null,
            },
        });
        
        // 3. Generar token y respuesta
        const token = signToken(newUser.id, newUser.role, newUser.ventanaId);

        // Registrar en ActivityLog
        await prisma.activityLog.create({
            data: {
                userId: newUser.id,
                action: 'UPDATE_USER',
                targetType: 'USER',
                targetId: newUser.id,
                details: { message: `Nuevo usuario registrado: ${newUser.role}` },
            },
        });

        res.status(201).json({ 
            status: 'success', 
            token, 
            data: { 
                user: {
                    id: newUser.id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role,
                    ventanaId: newUser.ventanaId,
                } 
            } 
        });
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(409).json({ status: 'fail', message: 'El correo electrónico ya está registrado.' });
        }
        console.error('Error al registrar usuario:', error);
        res.status(500).json({ status: 'error', message: 'Error interno del servidor.' });
    }
};

// ----------------------------------------------------
// LOGIN DE USUARIO
// ----------------------------------------------------

/**
 * Autentica al usuario y emite un token JWT.
 * (POST /api/auth/login)
 */
export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ status: 'fail', message: 'Por favor, proporciona email y contraseña.' });
        }

        // 1. Buscar usuario por email (excluyendo eliminados)
        const user = await prisma.user.findFirst({
            where: { email, isDeleted: false },
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ status: 'fail', message: 'Email o contraseña incorrectos.' });
        }
        
        // 2. Generar token
        const token = signToken(user.id, user.role, user.ventanaId);

        // 3. Registrar en ActivityLog
        await prisma.activityLog.create({
            data: {
                userId: user.id,
                action: 'LOGIN',
                targetType: 'USER',
                targetId: user.id,
                details: { message: 'Inicio de sesión exitoso.' },
            },
        });

        res.status(200).json({ 
            status: 'success', 
            token, 
            data: { 
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    ventanaId: user.ventanaId,
                } 
            } 
        });
    } catch (error: any) {
        console.error('Error en el login:', error);
        res.status(500).json({ status: 'error', message: 'Error interno del servidor.' });
    }
};
