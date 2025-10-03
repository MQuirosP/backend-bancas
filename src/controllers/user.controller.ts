import { Request, Response } from 'express';
import { ActivityType, PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Extender el Request de Express para incluir el usuario autenticado
interface CustomRequest extends Request {
  user?: {
    id: string;
    role: Role;
    ventanaId?: string;
  };
}

// ----------------------------------------------------
// FUNCIONES GENERALES DE SOFT-DELETE Y RESTORE
// ----------------------------------------------------

/**
 * Aplica Soft-Delete a cualquier entidad.
 * @param modelName Nombre del modelo de Prisma ('user', 'ventana', 'banca')
 * @param id ID del registro a eliminar
 * @param deletedById ID del usuario que ejecuta la acción
 */
const performSoftDelete = async (modelName: string, id: string, deletedById: string, res: Response) => {
    try {
        const updateData = {
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: deletedById,
            // Asume que todos los modelos tienen estos campos
        };
        
        // Ejecuta la actualización en el modelo dinámico
        const result = await (prisma as any)[modelName].update({
            where: { id: id },
            data: updateData,
            select: { id: true, name: true, isDeleted: true }
        });

        // Registrar en ActivityLog
        await prisma.activityLog.create({
            data: {
                userId: deletedById,
                action: 'SOFT_DELETE',
                targetType: modelName.toUpperCase(),
                targetId: id,
                details: { name: (result as any).name || 'Unknown' },
            },
        });

        res.status(200).json({ status: 'success', message: `${modelName} eliminado (soft-delete) exitosamente.`, data: result });
    } catch (error: any) {
        console.error(`Error en soft-delete de ${modelName}:`, error);
        res.status(400).json({ status: 'fail', message: `No se pudo eliminar el ${modelName}.`, detail: error.message });
    }
};


// ----------------------------------------------------
// CRUD DE BANCA (Solo para ADMIN)
// ----------------------------------------------------

export const createBanca = async (req: CustomRequest, res: Response) => {
    try {
        const { name, code, globalMaxPerNumber } = req.body;

        const newBanca = await prisma.banca.create({
            data: { name, code, globalMaxPerNumber },
        });

        res.status(201).json({ status: 'success', data: newBanca });
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(400).json({ status: 'fail', message: 'El código o nombre de la Banca ya existe.' });
        }
        res.status(500).json({ status: 'error', message: 'Error al crear la Banca.', detail: error.message });
    }
};

export const getAllBancas = async (req: CustomRequest, res: Response) => {
    try {
        // Solo trae registros que no están eliminados
        const bancas = await prisma.banca.findMany({
            where: { isDeleted: false },
            include: { ventanas: { where: { isDeleted: false } } }
        });
        res.status(200).json({ status: 'success', results: bancas.length, data: bancas });
    } catch (error: any) {
        res.status(500).json({ status: 'error', message: 'Error al obtener Bancas.', detail: error.message });
    }
};

export const deleteBanca = async (req: CustomRequest, res: Response) => {
    const deletedBy = req.user?.id || 'SYSTEM';
    await performSoftDelete('banca', req.params.id, deletedBy, res);
};

// ----------------------------------------------------
// CRUD DE VENTANA (Solo para ADMIN)
// ----------------------------------------------------

export const createVentana = async (req: CustomRequest, res: Response) => {
    try {
        const { name, bancaId, commissionMarginX, code  } = req.body;

        // CRÍTICO: Validar que el margen de la ventana no exceda el límite global de la banca (Lógica de Negocio)
        // Esta validación avanzada se haría aquí, pero por ahora solo creamos el registro.

        const newVentana = await prisma.ventana.create({
            data: { name, bancaId, code, commissionMarginX: parseFloat(commissionMarginX) },
        });

        res.status(201).json({ status: 'success', data: newVentana });
    } catch (error: any) {
        res.status(500).json({ status: 'error', message: 'Error al crear la Ventana.', detail: error.message });
    }
};

export const deleteVentana = async (req: CustomRequest, res: Response) => {
    const deletedBy = req.user?.id || 'SYSTEM';
    await performSoftDelete('ventana', req.params.id, deletedBy, res);
};

// ----------------------------------------------------
// GESTIÓN DE USUARIOS (CRUD con Asignación de Roles)
// ----------------------------------------------------

// CREAR USUARIO (Misma lógica que Register, pero accesible solo por Admin)
export const createUser = async (req: CustomRequest, res: Response) => {
    try {
        const { email, password, name, role, ventanaId } = req.body;

        // 1. Hash de la contraseña
        const passwordHash = await bcrypt.hash(password, 12);

        // 2. Crear usuario
        const newUser = await prisma.user.create({
            data: {
                email,
                password: passwordHash,
                name,
                role: role as Role,
                ventanaId: ventanaId || null,
            },
            select: { id: true, name: true, email: true, role: true, ventanaId: true },
        });

        // 3. Registrar en ActivityLog
        await prisma.activityLog.create({
            data: {
                userId: req.user?.id || 'ADMIN_CONSOLE',
                action: `CREATE_USER_${newUser.role}` as ActivityType,
                targetType: 'USER',
                targetId: newUser.id,
                details: { email: newUser.email, role: newUser.role },
            },
        });

        res.status(201).json({ status: 'success', data: newUser });
    } catch (err: any) {
        if (err.code === 'P2002') {
            return res.status(400).json({ status: 'fail', message: 'El email ya está registrado.' });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
};

// OBTENER TODOS LOS USUARIOS ACTIVOS
export const getAllUsers = async (req: CustomRequest, res: Response) => {
    try {
        const users = await prisma.user.findMany({
            where: { isDeleted: false },
            select: { id: true, name: true, email: true, role: true, ventanaId: true, createdAt: true },
            orderBy: { name: 'asc' }
        });
        res.status(200).json({ status: 'success', results: users.length, data: users });
    } catch (error: any) {
        res.status(500).json({ status: 'error', message: 'Error al obtener usuarios.', detail: error.message });
    }
};

// ELIMINAR USUARIO (Soft-Delete)
export const deleteUser = async (req: CustomRequest, res: Response) => {
    const deletedBy = req.user?.id || 'SYSTEM';
    await performSoftDelete('user', req.params.id, deletedBy, res);
};

// RESTAURAR ENTIDAD (Banca, Ventana o User)
export const restoreEntity = async (req: CustomRequest, res: Response) => {
    const { modelName } = req.body; // 'user', 'ventana', 'banca'
    const id = req.params.id;
    const restoredBy = req.user?.id || 'SYSTEM';

    if (!['user', 'ventana', 'banca'].includes(modelName)) {
        return res.status(400).json({ status: 'fail', message: 'Modelo de entidad inválido para restaurar.' });
    }

    try {
        // Ejecuta la actualización en el modelo dinámico
        const result = await (prisma as any)[modelName].update({
            where: { id: id },
            data: {
                isDeleted: false,
                deletedAt: null,
                deletedBy: null,
            },
            select: { id: true, name: true, isDeleted: true }
        });

        // Registrar en ActivityLog
        await prisma.activityLog.create({
            data: {
                userId: restoredBy,
                action: `RESTORE_${modelName.toUpperCase()}` as ActivityType,
                targetType: modelName.toUpperCase(),
                targetId: id,
                details: { name: (result as any).name || 'Unknown' },
            },
        });

        res.status(200).json({ status: 'success', message: `${modelName} restaurado exitosamente.`, data: result });
    } catch (error: any) {
        console.error(`Error al restaurar ${modelName}:`, error);
        res.status(400).json({ status: 'fail', message: `No se pudo restaurar el ${modelName}.`, detail: error.message });
    }
};
