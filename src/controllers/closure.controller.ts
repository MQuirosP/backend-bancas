import { Request, Response } from 'express';
import { PrismaClient, Role, Ticket } from '@prisma/client';

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
 * Procesa el cierre de un sorteo: Identifica ganadores, calcula premios y actualiza tiquetes.
 * (POST /api/closures/process)
 * CRÍTICO: Debe ser ejecutado por un ADMIN o un proceso automatizado.
 */
export const processLotteryClosure = async (req: CustomRequest, res: Response) => {
    // Solo permitir ejecución por ADMIN o si la solicitud viene de un servicio interno (ej. cron)
    if (req.user?.role !== Role.ADMIN) {
        return res.status(403).json({ status: 'fail', message: 'Acceso denegado. Solo administradores pueden cerrar sorteos.' });
    }

    const { loteriaId, winningNumber } = req.body;

    if (!loteriaId || !winningNumber) {
        return res.status(400).json({ status: 'fail', message: 'Debe especificar la Lotería y el número ganador.' });
    }

    // 1. Iniciar Transacción Atómica (CRÍTICO)
    // Esto previene inconsistencias si la conexión o el servidor fallan a mitad del pago.
    try {
        const winningTickets = await prisma.$transaction(async (tx) => {
            // 2. Encontrar todas las Jugadas PENDIENTES que coinciden con el número ganador
            const winningJugadas = await tx.jugada.findMany({
                where: {
                    number: winningNumber,
                    ticket: {
                        loteriaId: loteriaId,
                        status: 'PENDING', // Solo tiquetes aún no procesados
                        isDeleted: false
                    },
                    isDeleted: false
                },
                select: {
                    id: true,
                    ticketId: true,
                    amount: true,
                    finalMultiplierX: true,
                    payout: true,
                }
            });

            if (winningJugadas.length === 0) {
                // Registrar cierre sin ganadores
                await tx.activityLog.create({
                    data: {
                        userId: req.user?.id || 'SYSTEM',
                        action: 'SORTEO_CLOSURE',
                        targetType: 'LOTERIA',
                        targetId: loteriaId,
                        details: { winningNumber, message: 'Cierre completado, 0 ganadores.' },
                    },
                });
                return [];
            }

            // 3. Agrupar jugadas por Tiquete y calcular el premio total por Tiquete
            const ticketPayouts = new Map<string, number>();
            winningJugadas.forEach(jugada => {
                const currentPayout = ticketPayouts.get(jugada.ticketId) || 0;
                // El premio ya fue calculado en la venta (jugada.payout = amount * finalMultiplierX)
                ticketPayouts.set(jugada.ticketId, currentPayout + jugada.payout);
            });
            
            const winningTicketIds = Array.from(ticketPayouts.keys());

            // 4. Actualizar los Tiquetes ganadores
            await tx.ticket.updateMany({
                where: { id: { in: winningTicketIds } },
                data: {
                    status: 'WINNER', // Marcamos como ganador
                }
            });
            
            // Nota: En un sistema completo, aquí se registraría la transacción de pago.
            // Por simplicidad, solo actualizamos el estado.

            // 5. Registrar en ActivityLog el Cierre
            await tx.activityLog.create({
                data: {
                    userId: req.user?.id || 'SYSTEM',
                    action: 'SORTEO_CLOSURE',
                    targetType: 'LOTERIA',
                    targetId: loteriaId,
                    details: { winningNumber, winnersCount: winningTicketIds.length },
                },
            });

            // 6. Retornar los tiquetes actualizados
            const updatedTickets = await tx.ticket.findMany({
                where: { id: { in: winningTicketIds } }
            });

            return updatedTickets;
        });
        
        res.status(200).json({ 
            status: 'success', 
            message: `Sorteo cerrado exitosamente. ${winningTickets.length} tiquetes marcados como WINNER.`,
            data: { winningTickets } 
        });

    } catch (error: any) {
        console.error('Error FATAL en el cierre del sorteo (Transacción Revertida):', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'Error crítico en el cierre. La base de datos fue revertida para evitar inconsistencias.', 
            detail: error.message 
        });
    }
};
