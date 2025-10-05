import prisma from '../../../core/prismaClient';
import { ActivityType, TicketStatus } from '@prisma/client';
import ActivityService from '../../../core/activity.service';
import logger from '../../../core/logger';
import { AppError } from '../../../core/errors';
import { sumDecimals, toDecimal } from '../../../utils/decimal';
import { paginateOffset } from '../../../utils/pagination';

// Tipos explícitos para jugadas y tickets
export interface JugadaInput {
  number: string;
  amount: number | string;
  multiplierId: string;
  finalMultiplierX: number | string;
}

export interface CreateTicketInput {
  loteriaId: string;
  ventanaId: string;
  jugadas: JugadaInput[];
}

export const TicketService = {
  /**
   * Crea un nuevo ticket con sus jugadas
   */
  async create(data: CreateTicketInput, userId: string, requestId?: string) {
    const { loteriaId, ventanaId, jugadas } = data;

    if (!jugadas || jugadas.length === 0) {
      throw new AppError('At least one jugada is required', 400);
    }

    // Calcular monto total de jugadas usando Decimal seguro
    const totalAmount = sumDecimals(jugadas.map((j: JugadaInput) => toDecimal(j.amount)));

    // Generar número secuencial del ticket (atomic operation)
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

    // Crear ticket con jugadas
    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber: nextNumber,
        loteriaId,
        ventanaId,
        vendedorId: userId,
        totalAmount: totalAmount.toNumber(),
        status: TicketStatus.ACTIVE,
        jugadas: {
          create: jugadas.map((j: JugadaInput) => ({
            number: j.number,
            amount: toDecimal(j.amount).toNumber(),
            multiplierId: j.multiplierId,
            finalMultiplierX: toDecimal(j.finalMultiplierX).toNumber(),
          })),
        },
      },
      include: { jugadas: true },
    });

    // Registrar en ActivityLog
    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CREATE,
      targetType: 'TICKET',
      targetId: ticket.id,
      details: {
        ticketNumber: ticket.ticketNumber,
        totalAmount: totalAmount.toString(),
      },
      requestId,
      layer: 'service',
    });

    logger.info({
      layer: 'service',
      action: 'TICKET_CREATE',
      userId,
      requestId,
      payload: { ticketId: ticket.id, totalAmount: totalAmount.toString() },
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
  async list({
    page = 1,
    pageSize = 10,
    isDeleted,
    status,
  }: {
    page?: number;
    pageSize?: number;
    isDeleted?: boolean;
    status?: string;
  }) {
    const where: Record<string, any> = {};
    if (typeof isDeleted === 'boolean') where.isDeleted = isDeleted;
    if (status) where.status = status;

    const result = await paginateOffset(prisma.ticket, {
      where,
      include: {
        loteria: true,
        ventana: true,
        vendedor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      pagination: { page, pageSize },
    });

    return result;
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
