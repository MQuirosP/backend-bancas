import prisma from "../core/prismaClient";
import { TicketStatus } from "@prisma/client";
import logger from "../core/logger";
import { AppError } from "../core/errors";

type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string;
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

    const ticket = await prisma.$transaction(
      async (tx) => {
        // 1️⃣ Bloquear y actualizar el contador atómicamente
        const counter = await tx.ticketCounter.upsert({
          where: { id: "DEFAULT" },
          update: { currentNumber: { increment: 1 }, lastUpdate: new Date() },
          create: { id: "DEFAULT", currentNumber: 1 },
        });

        const nextNumber = counter.currentNumber;

        // 2️⃣ Revalidar límite diario dentro de la transacción
        const { _sum } = await tx.ticket.aggregate({
          _sum: { totalAmount: true },
          where: {
            vendedorId: userId,
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        });

        const dailyTotal = _sum.totalAmount ?? 0;
        const MAX_DAILY_TOTAL = 1000; // 🔧 configurable según reglas de negocio

        if (dailyTotal + totalAmount > MAX_DAILY_TOTAL) {
          throw new AppError("Daily sales limit exceeded", 400);
        }

        // 3️⃣ Validar existencia de claves foráneas requeridas (defensivo)
        const [existsLoteria, existsSorteo, existsVentana, existsUser] =
          await Promise.all([
            tx.loteria.findUnique({ where: { id: loteriaId } }),
            tx.sorteo.findUnique({ where: { id: sorteoId } }),
            tx.ventana.findUnique({ where: { id: ventanaId } }),
            tx.user.findUnique({ where: { id: userId } }),
          ]);

        if (!existsUser)
          throw new AppError("Seller (vendedor) not found", 400);
        if (!existsLoteria)
          throw new AppError("Lotería not found", 400);
        if (!existsSorteo)
          throw new AppError("Sorteo not found", 400);
        if (!existsVentana)
          throw new AppError("Ventana not found", 400);

        // 4️⃣ Crear ticket y jugadas
        const createdTicket = await tx.ticket.create({
          data: {
            ticketNumber: nextNumber,
            loteriaId,
            sorteoId,
            ventanaId,
            vendedorId: userId,
            totalAmount,
            status: TicketStatus.ACTIVE,
            jugadas: {
              create: jugadas.map((j) => ({
                number: j.number,
                amount: j.amount,
                finalMultiplierX: j.finalMultiplierX,
                multiplier: { connect: { id: j.multiplierId } },
              })),
            },
          },
          include: { jugadas: true },
        });

        // 5️⃣ Registrar en ActivityLog dentro de la misma transacción
        await tx.activityLog.create({
          data: {
            userId,
            action: "TICKET_CREATE",
            targetType: "TICKET",
            targetId: createdTicket.id,
            details: { ticketNumber: nextNumber, totalAmount },
          },
        });

        return createdTicket;
      },
      { timeout: 10000 } // ⏱️ previene "Transaction already closed"
    );

    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_TX",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        total: ticket.totalAmount,
      },
    });

    return ticket;
  },

  async getById(id: string) {
    return prisma.ticket.findUnique({
      where: { id },
      include: {
        jugadas: true,
        loteria: true,
        sorteo: true,
        ventana: true,
        vendedor: true,
      },
    });
  },

  async list(page = 1, pageSize = 10) {
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        skip,
        take: pageSize,
        include: {
          loteria: true,
          sorteo: true,
          ventana: true,
          vendedor: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count(),
    ]);

    return { data, total };
  },

  async cancel(id: string, userId: string) {
    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (!existing) throw new AppError("Ticket not found", 404);

    const ticket = await prisma.ticket.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: "Cancelled by user",
        status: TicketStatus.EVALUATED,
        isActive: false,
      },
      include: { jugadas: true },
    });

    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: { ticketId: id },
    });

    return ticket;
  },
};

export default TicketRepository;
