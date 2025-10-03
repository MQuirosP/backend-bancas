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
// CONSULTA DE TIQUETE POR ID
// ----------------------------------------------------

/**
 * Busca un tiquete por su ID para verificar su estado, valor y jugadas.
 * (GET /api/reports/tickets/:id)
 * Accesible para todos los roles que necesiten verificar un tiquete.
 */
export const getTicketById = async (req: CustomRequest, res: Response) => {
    try {
        const ticketId = req.params.id;
        const user = req.user;

        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId, isDeleted: false },
            include: {
                ventana: { include: { banca: true } },
                vendedor: { select: { name: true } },
                jugadas: { where: { isDeleted: false } }
            }
        });

        if (!ticket) {
            return res.status(404).json({ status: 'fail', message: 'Tiquete no encontrado o eliminado.' });
        }
        
        // CRÍTICO: Filtro de seguridad por rol
        // Si no es ADMIN, debe pertenecer a la Ventana del usuario
        if (user?.role !== Role.ADMIN && user?.ventanaId !== ticket.ventanaId) {
            return res.status(403).json({ status: 'fail', message: 'Acceso denegado. No tienes permisos para ver este tiquete.' });
        }

        res.status(200).json({ status: 'success', data: ticket });
    } catch (error: any) {
        console.error('Error al consultar tiquete:', error);
        res.status(500).json({ status: 'error', message: 'Error interno del servidor.', detail: error.message });
    }
};

// ----------------------------------------------------
// REPORTE DE VENTAS POR ENTIDAD
// ----------------------------------------------------

/**
 * Genera un reporte de ventas filtrado por fecha, lotería y rol de usuario.
 * (GET /api/reports/sales)
 * Los filtros son dinámicos según el rol.
 */
export const getSalesReport = async (req: CustomRequest, res: Response) => {
    try {
        const { startDate, endDate, loteriaId, ventanaId, bancaId } = req.query;
        const user = req.user;

        const where: any = {
            isDeleted: false,
            // Los tiquetes deben ser PENDING o WINNER, no CANCELLED o DRAFT
            status: { in: ['PENDING', 'WINNER'] } 
        };

        // Aplicar filtros de fecha
        if (startDate) {
            where.createdAt = { ...where.createdAt, gte: new Date(startDate as string) };
        }
        if (endDate) {
            where.createdAt = { ...where.createdAt, lte: new Date(endDate as string) };
        }

        // Aplicar filtro de Lotería
        if (loteriaId) {
            where.loteriaId = loteriaId;
        }

        // CRÍTICO: Aplicar filtros de seguridad basados en el rol del usuario
        if (user?.role === Role.VENDEDOR) {
            // Un vendedor solo ve sus propios tiquetes
            where.vendedorId = user.id;
        } else if (user?.role === Role.VENTANA) {
            // Un usuario de ventana solo ve tiquetes de su ventana
            where.ventanaId = user.ventanaId;
        } else if (user?.role === Role.ADMIN) {
            // ADMIN puede usar filtros de Ventana y Banca
            if (ventanaId) {
                where.ventanaId = ventanaId;
            } else if (bancaId) {
                // Si filtra por Banca, incluye todas las Ventanas de esa Banca
                const ventanas = await prisma.ventana.findMany({ where: { bancaId: bancaId as string, isDeleted: false } });
                where.ventanaId = { in: ventanas.map(v => v.id) };
            }
        } else {
             // Si el rol es desconocido o no autorizado para reportes
             return res.status(403).json({ status: 'fail', message: 'Rol de usuario sin permiso de reporte.' });
        }

        // Obtener los tiquetes que cumplen con los criterios
        const tickets = await prisma.ticket.findMany({
            where: where,
            include: {
                ventana: { select: { name: true, bancaId: true } },
                vendedor: { select: { name: true } },
                loteria: { select: { name: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Calcular totales
        const totalAmount = tickets.reduce((sum, t) => sum + t.totalAmount, 0);
        const totalTickets = tickets.length;

        res.status(200).json({ 
            status: 'success', 
            results: totalTickets, 
            data: { 
                summary: { totalTickets, totalAmount },
                tickets: tickets 
            } 
        });
    } catch (error: any) {
        console.error('Error al generar reporte de ventas:', error);
        res.status(500).json({ status: 'error', message: 'Error interno del servidor al generar reporte.', detail: error.message });
    }
};
