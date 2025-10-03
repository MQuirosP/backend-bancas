import { Request, Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';

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
// CRUD DE LOTERÍA (Entidad Base)
// ----------------------------------------------------

/**
 * Crea una nueva Lotería (POST /api/admin/lotteries)
 * Solo guarda el nombre y el JSON de reglas base.
 */
export const createLoteria = async (req: CustomRequest, res: Response) => {
    try {
        const { name, rulesJson } = req.body;

        const newLoteria = await prisma.loteria.create({
            data: { 
                name, 
                // Asegura que rulesJson sea un objeto JSON válido
                rulesJson: rulesJson || {}
            },
        });

        res.status(201).json({ status: 'success', data: newLoteria });
    } catch (error: any) {
        if (error.code === 'P2002') {
            return res.status(400).json({ status: 'fail', message: 'Ya existe una Lotería con ese nombre.' });
        }
        res.status(500).json({ status: 'error', message: 'Error al crear la Lotería.', detail: error.message });
    }
};

/**
 * Obtiene todas las Loterías activas (GET /api/admin/lotteries)
 */
export const getAllLoterias = async (req: CustomRequest, res: Response) => {
    try {
        const loterias = await prisma.loteria.findMany({
            where: { isDeleted: false },
        });
        res.status(200).json({ status: 'success', results: loterias.length, data: loterias });
    } catch (error: any) {
        res.status(500).json({ status: 'error', message: 'Error al obtener Loterías.', detail: error.message });
    }
};

// ----------------------------------------------------
// CRUD DE BANCA LOTERÍA SETTINGS (CRÍTICO - Multiplicadores y Límites)
// ----------------------------------------------------

/**
 * Crea o Actualiza la configuración de una Lotería para una Banca específica.
 * (POST /api/admin/lottery-settings)
 */
export const upsertBancaLoteriaSetting = async (req: CustomRequest, res: Response) => {
    try {
        const { bancaId, loteriaId, baseMultiplierX, maxTotalPerSorteo } = req.body;

        // Validar existencia de Banca y Lotería
        const bancaExists = await prisma.banca.count({ where: { id: bancaId, isDeleted: false } });
        const loteriaExists = await prisma.loteria.count({ where: { id: loteriaId, isDeleted: false } });

        if (!bancaExists || !loteriaExists) {
            return res.status(404).json({ status: 'fail', message: 'Banca o Lotería no encontrada.' });
        }
        
        // Uso de upsert para crear o actualizar la configuración
        const setting = await prisma.bancaLoteriaSetting.upsert({
            where: {
                bancaId_loteriaId: { bancaId, loteriaId } // Clave única definida en el schema
            },
            update: {
                baseMultiplierX: parseFloat(baseMultiplierX),
                maxTotalPerSorteo: maxTotalPerSorteo ? parseInt(maxTotalPerSorteo, 10) : null,
                // Soft-delete es crucial aquí: si se restaura, se asume que vuelve a estar activo
                isDeleted: false 
            },
            create: {
                bancaId,
                loteriaId,
                baseMultiplierX: parseFloat(baseMultiplierX),
                maxTotalPerSorteo: maxTotalPerSorteo ? parseInt(maxTotalPerSorteo, 10) : null,
            },
        });
        
        // Registrar en ActivityLog (CRÍTICO para auditoría de multiplicadores)
        await prisma.activityLog.create({
            data: {
                userId: req.user?.id || 'SYSTEM',
                action: 'UPDATE_MULTIPLIER_SETTING',
                targetType: 'BANCA_LOTERIA_SETTING',
                targetId: setting.id,
                details: { loteriaId, bancaId, newMultiplier: setting.baseMultiplierX },
            },
        });

        res.status(200).json({ status: 'success', message: 'Configuración de multiplicadores actualizada exitosamente.', data: setting });

    } catch (error: any) {
        console.error('Error al crear/actualizar BancaLoteriaSetting:', error);
        res.status(500).json({ status: 'error', message: 'Error al gestionar la configuración de la Lotería.', detail: error.message });
    }
};

/**
 * Obtiene la configuración de Lotería para una Banca (GET /api/admin/lottery-settings/:bancaId/:loteriaId)
 */
export const getBancaLoteriaSetting = async (req: CustomRequest, res: Response) => {
    try {
        const { bancaId, loteriaId } = req.params;

        const setting = await prisma.bancaLoteriaSetting.findUnique({
            where: {
                bancaId_loteriaId: { bancaId, loteriaId },
                isDeleted: false
            },
            include: { loteria: true, banca: true }
        });

        if (!setting) {
            return res.status(404).json({ status: 'fail', message: 'Configuración no encontrada.' });
        }

        res.status(200).json({ status: 'success', data: setting });
    } catch (error: any) {
        res.status(500).json({ status: 'error', message: 'Error al obtener configuración.', detail: error.message });
    }
};
