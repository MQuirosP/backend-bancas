import prisma from '../core/prismaClient';
import { TicketStatus } from '@prisma/client';
import logger from '../core/logger';
import { AppError } from '../core/errors';

type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string; // 👈 nuevo
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
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, sorteoId, ventanaId, totalAmount, jugadas } = data;

    const ticket = await prisma.$transaction(async (tx) => {
      // ✅ atómico con upsert + id fijo "DEFAULT"
      const counter = await tx.ticketCounter.upsert({
        where: { id: 'DEFAULT' },
        update: { currentNumber: { increment: 1 }, lastUpdate: new Date() },
        create: { id: 'DEFAULT', currentNumber: 1 },
      });
      const nextNumber = counter.currentNumber;

      const createdTicket = await tx.ticket.create({
        data: {
          ticketNumber: nextNumber,
          loteriaId,
          sorteoId,         // 👈 nuevo
          ventanaId,
          vendedorId: userId,
          totalAmount,
          status: TicketStatus.ACTIVE,
          jugadas: {
            create: jugadas.map((j) => ({
              number: j.number,
              amount: j.amount,
              finalMultiplierX: j.finalMultiplierX,
              // mantenemos multiplierId requerido como usas en tu schema
              multiplier: { connect: { id: j.multiplierId } },
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
      include: { jugadas: true, loteria: true, sorteo: true, ventana: true, vendedor: true }, // 👈 añadí sorteo
    });
    return ticket;
  },

  async list(page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        skip,
        take: pageSize,
        include: { loteria: true, sorteo: true, ventana: true, vendedor: true }, // 👈 añadí sorteo
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
        status: TicketStatus.EVALUATED, // conservamos tu convención
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
