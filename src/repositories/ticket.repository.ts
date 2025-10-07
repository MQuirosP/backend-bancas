import prisma from "../core/prismaClient";
import { TicketStatus } from "@prisma/client";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { withTransactionRetry } from "../utils/withTransactionRetry";

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

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export const TicketRepository = {
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, sorteoId, ventanaId, totalAmount, jugadas } = data;

    // 👇 toda la transacción se maneja con retry automático (deadlock-safe)
    const ticket = await withTransactionRetry(async (tx) => {
      // 1️⃣ Bloquear y actualizar contador atómicamente
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
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });
      const dailyTotal = _sum.totalAmount ?? 0;
      const MAX_DAILY_TOTAL = 1000;
      if (dailyTotal + totalAmount > MAX_DAILY_TOTAL) {
        throw new AppError(
          "Daily sales limit exceeded",
          400,
          "LIMIT_VIOLATION"
        );
      }

      // 3️⃣ Validar existencia de claves foráneas requeridas (defensivo)
      const [existsLoteria, existsSorteo, ventana, existsUser] =
        await Promise.all([
          tx.loteria.findUnique({
            where: { id: loteriaId },
            select: { id: true },
          }),
          tx.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true },
          }),
          tx.ventana.findUnique({
            where: { id: ventanaId },
            select: { id: true, bancaId: true },
          }),
          tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
        ]);

      if (!existsUser)
        throw new AppError("Seller (vendedor) not found", 404, "FK_VIOLATION");
      if (!existsLoteria)
        throw new AppError("Lotería not found", 404, "FK_VIOLATION");
      if (!existsSorteo)
        throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
      if (!ventana)
        throw new AppError("Ventana not found", 404, "FK_VIOLATION");

      // 3️⃣.5 Pipeline de RestrictionRule (User > Ventana > Banca)
      const now = new Date();
      const bancaId = ventana.bancaId;

      const candidateRules = await tx.restrictionRule.findMany({
        where: {
          isDeleted: false,
          OR: [{ userId }, { ventanaId }, { bancaId }],
        },
      });

      const applicable = candidateRules
        .filter((r) => {
          if (
            r.appliesToDate &&
            !isSameLocalDay(new Date(r.appliesToDate), now)
          )
            return false;
          if (
            typeof r.appliesToHour === "number" &&
            r.appliesToHour !== now.getHours()
          )
            return false;
          return true;
        })
        .map((r) => {
          let score = 0;
          if (r.bancaId) score += 1;
          if (r.ventanaId) score += 10;
          if (r.userId) score += 100;
          if (r.number) score += 1000;
          return { r, score };
        })
        .sort((a, b) => b.score - a.score)
        .map((x) => x.r);

      if (applicable.length > 0) {
        const rule = applicable[0];

        // Si la regla aplica a un número específico
        if (rule.number) {
          const sumForNumber = jugadas
            .filter((j) => j.number === rule.number)
            .reduce((acc, j) => acc + j.amount, 0);

          if (rule.maxAmount && sumForNumber > rule.maxAmount)
            throw new AppError(
              `Number ${rule.number} exceeded maxAmount (${rule.maxAmount})`,
              400
            );

          if (rule.maxTotal && totalAmount > rule.maxTotal)
            throw new AppError(
              `Ticket total exceeded maxTotal (${rule.maxTotal})`,
              400
            );
        } else {
          // Regla general
          if (rule.maxAmount) {
            const maxBet = Math.max(...jugadas.map((j) => j.amount));
            if (maxBet > rule.maxAmount)
              throw new AppError(
                `Bet amount exceeded maxAmount (${rule.maxAmount})`,
                400
              );
          }
          if (rule.maxTotal && totalAmount > rule.maxTotal)
            throw new AppError(
              `Ticket total exceeded maxTotal (${rule.maxTotal})`,
              400
            );
        }
      }

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

      return createdTicket;
    });

    // 5️⃣ Registrar ActivityLog fuera de la transacción (no bloqueante)
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CREATE",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            jugadas: ticket.jugadas.length,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: err.message,
        })
      );

    // 6️⃣ Log global
    logger.info({
      layer: "repository",
      action: "TICKET_CREATE_TX",
      payload: {
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        totalAmount: ticket.totalAmount,
        jugadas: ticket.jugadas.length,
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
        status: TicketStatus.CANCELLED,
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
