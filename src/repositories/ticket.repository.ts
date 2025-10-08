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
      // 1️⃣ Obtener número secuencial (Supabase o local)
      let nextNumber: number | null = null;

      try {
        // 🔹 Intentar usar la función PL/pgSQL de Supabase
        const [res] = await tx.$queryRawUnsafe<
          { generate_ticket_number: number }[]
        >(`SELECT generate_ticket_number()`);
        nextNumber = res?.generate_ticket_number ?? null;
      } catch (err: any) {
        // 🔹 Si la función no existe, fallback local usando TicketCounter
        logger.warn({
          layer: "ticketRepository",
          action: "SEQ_FALLBACK",
          payload: { message: err.message },
        });

        await tx.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TicketCounter" (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          "currentNumber" bigint NOT NULL DEFAULT 0
        );
      `);

        await tx.$executeRawUnsafe(`
        INSERT INTO "TicketCounter" ("id", "currentNumber")
        VALUES (uuid_generate_v4(), 0)
        ON CONFLICT DO NOTHING;
      `);

        const [res2] = await tx.$queryRawUnsafe<{ currentNumber: number }[]>(`
        UPDATE "TicketCounter"
        SET "currentNumber" = "currentNumber" + 1
        RETURNING "currentNumber"
      `);
        nextNumber = res2.currentNumber;
      }

      if (!nextNumber) {
        throw new AppError(
          "Failed to generate ticket number",
          500,
          "SEQ_ERROR"
        );
      }

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
      const [existsLoteria, sorteo, ventana, existsUser] = await Promise.all([
        tx.loteria.findUnique({
          where: { id: loteriaId },
          select: { id: true },
        }),
        tx.sorteo.findUnique({
          where: { id: sorteoId },
          select: { id: true, status: true },
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
      if (!sorteo) throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
      if (!ventana)
        throw new AppError("Ventana not found", 404, "FK_VIOLATION");

      // 3️⃣.1 No permitir venta si sorteo no está abierto
      if (sorteo.status !== "OPEN") {
        throw new AppError(
          "No se pueden crear tickets para sorteos no abiertos",
          400,
          "SORTEO_NOT_OPEN"
        );
      }

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
          isActive: true,
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
          payload: { message: err.message },
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

    logger.debug({
      layer: "repository",
      action: "TICKET_DEBUG",
      payload: {
        loteriaId,
        sorteoId,
        ventanaId,
        vendedorId: userId,
        jugadas,
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

  async list(
    page = 1,
    pageSize = 10,
    filters: {
      status?: TicketStatus;
      isDeleted?: boolean;
      sorteoId?: string;
    } = {}
  ) {
    const skip = (page - 1) * pageSize;

    // 1️⃣ Construir condiciones dinámicas
    const where: any = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(typeof filters.isDeleted === "boolean"
        ? { isDeleted: filters.isDeleted }
        : { isDeleted: false }),
      ...(filters.sorteoId ? { sorteoId: filters.sorteoId } : {}),
    };

    // 2️⃣ Obtener datos y total en paralelo
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          loteria: { select: { id: true, name: true } },
          sorteo: { select: { id: true, name: true, status: true } },
          ventana: { select: { id: true, name: true } },
          vendedor: { select: { id: true, name: true, role: true } },
          jugadas: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count({ where }),
    ]);

    // 3️⃣ Calcular metadatos de paginación
    const totalPages = Math.ceil(total / pageSize);

    const meta = {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    // 4️⃣ Logging informativo
    logger.info({
      layer: "repository",
      action: "TICKET_LIST",
      payload: { filters, page, pageSize, total },
    });

    return { data, meta };
  },
  async cancel(id: string, userId: string) {
    // 1️⃣ Verificar existencia del ticket
    const existing = await prisma.ticket.findUnique({
      where: { id },
      include: { sorteo: true },
    });

    if (!existing) {
      throw new AppError("Ticket not found", 404, "NOT_FOUND");
    }

    // 2️⃣ Validar que no esté evaluado o cerrado
    if (existing.status === TicketStatus.EVALUATED) {
      throw new AppError(
        "Cannot cancel an evaluated ticket",
        400,
        "INVALID_STATE"
      );
    }

    // 3️⃣ Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
    if (
      existing.sorteo.status === "CLOSED" ||
      existing.sorteo.status === "EVALUATED"
    ) {
      throw new AppError(
        "Cannot cancel ticket from closed or evaluated sorteo",
        400,
        "SORTEO_LOCKED"
      );
    }

    // 4️⃣ Actualizar ticket (soft delete + inactivar)
    const ticket = await prisma.ticket.update({
      where: { id },
      data: {
        isDeleted: true,
        isActive: false,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: "Cancelled by user",
        status: TicketStatus.CANCELLED,
        updatedAt: new Date(),
      },
      include: { jugadas: true },
    });

    // 5️⃣ Registrar en ActivityLog
    prisma.activityLog
      .create({
        data: {
          userId,
          action: "TICKET_CANCEL",
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            totalAmount: ticket.totalAmount,
            cancelledAt: ticket.deletedAt,
          },
        },
      })
      .catch((err) =>
        logger.warn({
          layer: "activityLog",
          action: "ASYNC_FAIL",
          payload: { message: err.message },
        })
      );

    // 6️⃣ Logging global
    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: {
        ticketId: id,
        userId,
        sorteoId: existing.sorteoId,
        totalAmount: ticket.totalAmount,
      },
    });

    return ticket;
  },
};

export default TicketRepository;
