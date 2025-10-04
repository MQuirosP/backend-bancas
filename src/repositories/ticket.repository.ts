import prisma from '../core/prismaClient';
import { TicketStatus } from '@prisma/client';
import logger from '../core/logger';
import { AppError } from '../core/errors';

type CreateTicketInput = {
  loteriaId: string;
  ventanaId: string;
  totalAmount: number;
  jugadas: Array<{
    number: string;
    amount: number;
    multiplierId: string;
    finalMultiplierX: number;
  }>;
};

export const TicketRepository = {
  /**
   * Crea ticket + jugadas con incremento secuencial de ticketNumber en una transacción.
   * Mantiene mismo comportamiento que tu service actual pero encapsulado en repo.
   */
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, ventanaId, totalAmount, jugadas } = data;

    const ticket = await prisma.$transaction(async (tx) => {
      // obtener/crear contador y calcular siguiente número
      const existing = await tx.ticketCounter.findFirst();
      let nextNumber = 1;

      if (existing) {
        const updated = await tx.ticketCounter.update({
          where: { id: existing.id },
          data: { currentNumber: { increment: 1 }, lastUpdate: new Date() },
        });
        nextNumber = updated.currentNumber;
      } else {
        const created = await tx.ticketCounter.create({
          data: { currentNumber: 1 },
        });
        nextNumber = created.currentNumber;
      }

      // crear ticket y jugadas
      const createdTicket = await tx.ticket.create({
        data: {
          ticketNumber: nextNumber,
          loteriaId,
          ventanaId,
          vendedorId: userId,
          totalAmount,
          status: TicketStatus.ACTIVE,
          jugadas: {
            create: jugadas.map((j) => ({
              number: j.number,
              amount: j.amount,
              multiplierId: j.multiplierId,
              finalMultiplierX: j.finalMultiplierX,
            })),
          },
        },
        include: { jugadas: true },
      });

      return createdTicket;
    });

    logger.info({
      layer: 'repository',
      action: 'TICKET_CREATE_DB',
      payload: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
    });

    return ticket;
  },

  async getById(id: string) {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { jugadas: true, loteria: true, ventana: true, vendedor: true },
    });
    return ticket;
  },

  async list(page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        skip,
        take: pageSize,
        include: { loteria: true, ventana: true, vendedor: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ticket.count(),
    ]);

    return { data, total };
  },

  async cancel(id: string, userId: string) {
    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) throw new AppError('Ticket not found', 404);

    const ticket = await prisma.ticket.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: 'Cancelled by user',
        status: TicketStatus.EVALUATED,
        isActive: false,
      },
      include: { jugadas: true },
    });

    logger.warn({
      layer: 'repository',
      action: 'TICKET_CANCEL_DB',
      payload: { ticketId: id },
    });

    return ticket;
  },
};

export default TicketRepository;
