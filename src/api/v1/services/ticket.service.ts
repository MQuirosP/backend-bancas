import prisma from '../../../core/prismaClient';
import { ActivityType, Prisma, TicketStatus } from '@prisma/client';
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
  // finalMultiplierX del cliente se ignora: se calcula desde DB
}

export interface CreateTicketInput {
  loteriaId: string;
  sorteoId: string;     // requerido: el ticket pertenece a un sorteo
  ventanaId: string;
  jugadas: JugadaInput[];
}

export const TicketService = {
  /**
   * Crea un nuevo ticket con sus jugadas
   */
  async create(data: CreateTicketInput, userId: string, requestId?: string) {
    const { loteriaId, sorteoId, ventanaId, jugadas } = data;

    if (!jugadas || jugadas.length === 0) {
      throw new AppError('At least one jugada is required', 400);
    }

    // 1) Ventana + Banca (para límites)
    const ventana = await prisma.ventana.findUnique({
      where: { id: ventanaId },
      include: { banca: true },
    });
    if (!ventana || ventana.isDeleted) throw new AppError('Ventana not found', 404);
    const banca = ventana.banca;
    if (!banca) throw new AppError('Banca not found for ventana', 404);

    // 2) Sorteo válido y de la misma lotería
    const sorteo = await prisma.sorteo.findFirst({
      where: { id: sorteoId, loteriaId, isDeleted: false },
      select: { id: true, status: true },
    });
    if (!sorteo) throw new AppError('Sorteo not found for provided loteriaId', 404);
    if (sorteo.status !== 'OPEN') {
      throw new AppError('Sorteo must be OPEN to create tickets', 409);
    }

    // 3) Mínimo por jugada (defaultMinBet de la banca)
    const minBet = banca.defaultMinBet ?? 100;
    for (const j of jugadas) {
      if (toDecimal(j.amount).lessThan(minBet)) {
        throw new AppError(`Each bet must be >= ${minBet}`, 400);
      }
    }

    // 4) Multiplicadores válidos y activos de la misma lotería
    const multiplierIds = Array.from(new Set(jugadas.map((j) => j.multiplierId)));
    const multipliers = await prisma.loteriaMultiplier.findMany({
      where: { id: { in: multiplierIds }, loteriaId, isActive: true },
      select: { id: true, valueX: true },
    });
    if (multipliers.length !== multiplierIds.length) {
      throw new AppError('Invalid or inactive multipliers for the selected lottery', 400);
    }
    const multMap = new Map(multipliers.map((m) => [m.id, m.valueX]));

    // 5) Enforce globalMaxPerNumber (por Banca y Sorteo)
    const maxPerNumber = banca.globalMaxPerNumber; // Int @default(5000)
    const existing = await prisma.jugada.groupBy({
      by: ['number'],
      where: {
        ticket: {
          sorteoId,
          isDeleted: false,
          ventana: { bancaId: banca.id },
        },
      },
      _sum: { amount: true },
    });
    const existingMap = new Map(existing.map((e) => [e.number, e._sum.amount ?? 0]));
    const addingMap = new Map<string, number>();
    for (const j of jugadas) {
      const add = toDecimal(j.amount).toNumber();
      addingMap.set(j.number, (addingMap.get(j.number) ?? 0) + add);
    }
    for (const [num, add] of addingMap) {
      const prev = existingMap.get(num) ?? 0;
      if (prev + add > maxPerNumber) {
        throw new AppError(`Limit exceeded for number ${num}: ${prev + add} > ${maxPerNumber}`, 409);
      }
    }

    // 6) Calcular monto total de jugadas usando Decimal seguro
    const totalAmount = sumDecimals(jugadas.map((j) => toDecimal(j.amount)));

    // 7) Generar número secuencial del ticket (atomic upsert con id "DEFAULT")
    const counter = await prisma.ticketCounter.upsert({
      where: { id: 'DEFAULT' },
      update: { currentNumber: { increment: 1 }, lastUpdate: new Date() },
      create: { id: 'DEFAULT', currentNumber: 1 }, // primer ticket => 1
    });
    const nextNumber = counter.currentNumber;

    // 8) Crear ticket con jugadas (finalMultiplierX calculado desde DB)
    const ticket = await prisma.ticket.create({
      data: {
        ticketNumber: nextNumber,
        loteriaId,
        sorteoId,                 // persistimos sorteoId
        ventanaId,
        vendedorId: userId,
        totalAmount: totalAmount.toNumber(),
        status: TicketStatus.ACTIVE,
        jugadas: {
          create: jugadas.map((j) => ({
            number: j.number,
            amount: toDecimal(j.amount).toNumber(),
            finalMultiplierX: multMap.get(j.multiplierId)!, // desde DB
            multiplier: { connect: { id: j.multiplierId } },
          })),
        },
      },
      include: { jugadas: true },
    });

    // 9) Registrar en ActivityLog (JSON-safe)
    const details: Prisma.InputJsonObject = {
      ticketNumber: ticket.ticketNumber,
      loteriaId,
      sorteoId,
      ventanaId,
      totalAmount: totalAmount.toString(),
      jugadas: jugadas.map((j) => ({
        number: j.number,
        amount: toDecimal(j.amount).toString(),
        multiplierId: j.multiplierId,
      })),
    };

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CREATE,
      targetType: 'TICKET',
      targetId: ticket.id,
      details,
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
      include: { jugadas: true, loteria: true, sorteo: true, ventana: true, vendedor: true },
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
        sorteo: true,
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
      details: { reason: 'Cancelled by user' } as Prisma.InputJsonObject,
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
