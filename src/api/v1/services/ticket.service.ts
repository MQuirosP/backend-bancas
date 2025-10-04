import prisma from '../../../core/prismaClient';
import { ActivityType, TicketStatus } from '@prisma/client';
import ActivityService from '../../../core/activity.service';
import logger from '../../../core/logger';
import { AppError } from '../../../core/errors';

export const TicketService = {
  /**
   * Crea un nuevo ticket con sus jugadas
   */
  async create(data: any, userId: string, requestId?: string) {
    const { loteriaId, ventanaId, totalAmount, jugadas } = data;

    // Generar número secuencial del ticket
    const counter = await prisma.ticketCounter.findFirst();
    let nextNumber = 1;

    if (counter) {
      const updated = await prisma.ticketCounter.update({
        where: { id: counter.id },
        data: { currentNumber: { increment: 1 }, lastUpdate: new Date() },
      });
      nextNumber = updated.currentNumber;
    } else {
      const created = await prisma.ticketCounter.create({
        data: { currentNumber: 1 },
      });
      nextNumber = created.currentNumber;
    }

    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber: nextNumber,
        loteriaId,
        ventanaId,
        vendedorId: userId,
        totalAmount,
        status: TicketStatus.ACTIVE,
        jugadas: { create: jugadas },
      },
      include: { jugadas: true },
    });

    // Registrar en ActivityLog
    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CREATE,
      targetType: 'TICKET',
      targetId: ticket.id,
      details: { ticketNumber: ticket.ticketNumber, totalAmount },
      requestId,
      layer: 'service',
    });

    logger.info({
      layer: 'service',
      action: 'TICKET_CREATE',
      userId,
      requestId,
      payload: { ticketId: ticket.id, totalAmount },
    });

    return ticket;
  },

  /**
   * Obtiene un ticket por ID
   */
  async getById(id: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { jugadas: true, loteria: true, ventana: true },
    });
    if (!ticket) throw new AppError('Ticket not found', 404);
    return ticket;
  },

  /**
   * Lista de tickets con paginación
   */
  async list({ page = 1, pageSize = 10 }: { page?: number; pageSize?: number }) {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        skip,
        take: pageSize,
        include: { loteria: true, ventana: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ticket.count(),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  /**
   * Cancela un ticket (soft-delete)
   */
  async cancel(id: string, userId: string, requestId?: string) {
    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw new AppError('Ticket not found', 404);

    const cancelled = await prisma.ticket.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: 'Cancelled by user',
        status: TicketStatus.EVALUATED,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: 'TICKET',
      targetId: id,
      details: { reason: 'Cancelled by user' },
      requestId,
      layer: 'service',
    });

    logger.warn({
      layer: 'service',
      action: 'TICKET_CANCEL',
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return cancelled;
  },
};
