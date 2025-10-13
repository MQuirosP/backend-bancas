import prisma from "../core/prismaClient";
import { Prisma, TicketStatus } from "@prisma/client";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { withTransactionRetry } from "../core/withTransactionRetry";

type CreateTicketInput = {
  loteriaId: string;
  sorteoId: string;
  ventanaId: string;
  totalAmount?: number; // ignorado; el backend calcula el total
  jugadas: Array<{
    type: "NUMERO" | "REVENTADO";
    number: string;
    reventadoNumber?: string | null; // requerido si type=REVENTADO (igual a number)
    amount: number;
    multiplierId?: string; // resuelto en repo para NUMERO; placeholder para REVENTADO
    finalMultiplierX?: number; // resuelto en repo para NUMERO; 0 para REVENTADO
  }>;
};

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function ensureReventadoPlaceholder(tx: any, loteriaId: string) {
  const name = "REVENTADO (dynamic)";
  let mul = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, name },
    select: { id: true },
  });
  if (!mul) {
    mul = await tx.loteriaMultiplier.create({
      data: {
        loteriaId,
        name,
        valueX: 0,
        isActive: true,
        kind: "REVENTADO",
      },
      select: { id: true },
    });
  }
  return mul.id;
}

async function resolveBaseMultiplierX(
  tx: Prisma.TransactionClient,
  args: { bancaId: string; loteriaId: string; userId: string }
): Promise<{ valueX: number; source: string }> {
  const { bancaId, loteriaId, userId } = args;

  // 0) Override por usuario (directo en X)
  const uo = await tx.userMultiplierOverride.findUnique({
    where: {
      userId_loteriaId_multiplierType: {
        userId,
        loteriaId,
        multiplierType: "Base",
      },
    },
    select: { baseMultiplierX: true },
  });
  if (typeof uo?.baseMultiplierX === "number") {
    return {
      valueX: uo.baseMultiplierX,
      source: "userOverride.baseMultiplierX",
    };
  }

  // 1) Config por banca/lotería
  const bls = await tx.bancaLoteriaSetting.findUnique({
    where: { bancaId_loteriaId: { bancaId, loteriaId } },
    select: { baseMultiplierX: true },
  });
  if (typeof bls?.baseMultiplierX === "number") {
    return {
      valueX: bls.baseMultiplierX,
      source: "bancaLoteriaSetting.baseMultiplierX",
    };
  }

  // 2) Fallback: rulesJson en Lotería
  const lot = await tx.loteria.findUnique({
    where: { id: loteriaId },
    select: { rulesJson: true },
  });
  const rulesX = (lot?.rulesJson as any)?.baseMultiplierX;
  if (typeof rulesX === "number" && rulesX > 0) {
    return { valueX: rulesX, source: "loteria.rulesJson.baseMultiplierX" };
  }

  throw new AppError(
    `Missing baseMultiplierX for bancaId=${bancaId} & loteriaId=${loteriaId}`,
    400
  );
}

// Garantiza que exista un multiplicador "Base" (para linkear en jugadas NUMERO)
async function ensureBaseMultiplierRow(
  tx: Prisma.TransactionClient,
  loteriaId: string
): Promise<string> {
  const existing = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, name: "Base" },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await tx.loteriaMultiplier.create({
    data: {
      loteriaId,
      name: "Base",
      valueX: 0,
      isActive: true,
      kind: "NUMERO",
    },
    select: { id: true },
  });
  return created.id;
}

export const TicketRepository = {
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, sorteoId, ventanaId, jugadas } = data;

    // 👇 toda la transacción se maneja con retry automático (deadlock-safe)
    const ticket = await withTransactionRetry(async (tx) => {
      // 1️⃣ Obtener número secuencial (Supabase o secuencia local)
      // 1️⃣ Obtener número secuencial (función si existe, si no secuencia local)
      const [seqRow] = await tx.$queryRawUnsafe<
        { next_number: string | number }[]
      >(`
  SELECT CASE
    WHEN to_regprocedure('generate_ticket_number()') IS NOT NULL
      THEN generate_ticket_number()
    ELSE nextval('ticket_number_seq')
  END AS next_number
`);
      const nextNumber = Number(seqRow?.next_number ?? 0);
      if (!nextNumber) {
        throw new AppError(
          "Failed to generate ticket number",
          500,
          "SEQ_ERROR"
        );
      }

      // 2️⃣ Validar existencia de claves foráneas requeridas (defensivo)
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

      // 2️⃣.1 No permitir venta si sorteo no está abierto
      if (sorteo.status !== "OPEN") {
        throw new AppError(
          "No se pueden crear tickets para sorteos no abiertos",
          400,
          "SORTEO_NOT_OPEN"
        );
      }

      // 3️⃣ Resolver X efectivo (con fallback) y asegurar multiplier "Base"
      const bancaId = ventana.bancaId;

      const { valueX: effectiveBaseX, source } = await resolveBaseMultiplierX(
        tx,
        {
          bancaId,
          loteriaId,
          userId,
        }
      );

      // Asegura que exista un multiplier con name="Base" para linkear jugadas NUMERO
      const baseMultiplierRowId = await ensureBaseMultiplierRow(tx, loteriaId);

      logger.info({
        layer: "ticket",
        action: "BASE_MULTIPLIER_RESOLVED",
        payload: { bancaId, loteriaId, userId, effectiveBaseX, source },
      });

      // 4️⃣ Pipeline de RestrictionRule (User > Ventana > Banca)
      const now = new Date();
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

      // 5️⃣ Asegurar placeholder REVENTADO dentro de la misma TX
      const hasReventado = jugadas.some((j) => j.type === "REVENTADO");
      const reventadoPlaceholderId = hasReventado
        ? await ensureReventadoPlaceholder(tx, loteriaId)
        : null;

      // 6️⃣ Normalizar jugadas y calcular total en servidor
      const preparedJugadas = jugadas.map((j) => {
        if (j.type === "REVENTADO") {
          if (!j.reventadoNumber || j.reventadoNumber !== j.number) {
            throw new AppError(
              "REVENTADO must reference the same number (reventadoNumber === number)",
              400,
              "INVALID_REVENTADO_LINK"
            );
          }
          return {
            type: "REVENTADO" as const,
            number: j.number,
            reventadoNumber: j.reventadoNumber,
            amount: j.amount,
            finalMultiplierX: 0,
            multiplierId: reventadoPlaceholderId!, // FK “dummy” estable
          };
        }
        // NUMERO
        return {
          type: "NUMERO" as const,
          number: j.number,
          reventadoNumber: null,
          amount: j.amount,
          finalMultiplierX: effectiveBaseX, // congelado en venta
          multiplierId: baseMultiplierRowId, // multiplier Base
        };
      });

      const totalAmountTx = preparedJugadas.reduce(
        (acc, j) => acc + j.amount,
        0
      );

      // 7️⃣ Límite diario (usa total calculado en servidor)
      const { _sum } = await tx.ticket.aggregate({
        _sum: { totalAmount: true },
        where: {
          vendedorId: userId,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });
      const dailyTotal = _sum.totalAmount ?? 0;
      const MAX_DAILY_TOTAL = Number(process.env.SALES_DAILY_MAX ?? 1000);

      if (dailyTotal + totalAmountTx > MAX_DAILY_TOTAL) {
        throw new AppError(
          "Daily sales limit exceeded",
          400,
          "LIMIT_VIOLATION"
        );
      }

      // 8️⃣ Reglas por ticket / número aplicando preparedJugadas + totalAmountTx
      if (applicable.length > 0) {
        const rule = applicable[0];
        if (rule.number) {
          const sumForNumber = preparedJugadas
            .filter((j) => j.number === rule.number)
            .reduce((acc, j) => acc + j.amount, 0);

          if (rule.maxAmount && sumForNumber > rule.maxAmount)
            throw new AppError(
              `Number ${rule.number} exceeded maxAmount (${rule.maxAmount})`,
              400
            );

          if (rule.maxTotal && totalAmountTx > rule.maxTotal)
            throw new AppError(
              `Ticket total exceeded maxTotal (${rule.maxTotal})`,
              400
            );
        } else {
          if (rule.maxAmount) {
            const maxBet = Math.max(...preparedJugadas.map((j) => j.amount));
            if (maxBet > rule.maxAmount)
              throw new AppError(
                `Bet amount exceeded maxAmount (${rule.maxAmount})`,
                400
              );
          }
          if (rule.maxTotal && totalAmountTx > rule.maxTotal)
            throw new AppError(
              `Ticket total exceeded maxTotal (${rule.maxTotal})`,
              400
            );
        }
      }

      // 9️⃣ Crear ticket y jugadas
      const createdTicket = await tx.ticket.create({
        data: {
          ticketNumber: nextNumber,
          loteriaId,
          sorteoId,
          ventanaId,
          vendedorId: userId,
          totalAmount: totalAmountTx,
          status: TicketStatus.ACTIVE,
          isActive: true,
          jugadas: {
            create: preparedJugadas.map((j) => ({
              type: j.type,
              number: j.number,
              reventadoNumber: j.reventadoNumber,
              amount: j.amount,
              finalMultiplierX: j.finalMultiplierX,
              multiplier: { connect: { id: j.multiplierId } }, // relación nombrada ok
            })),
          },
        },
        include: { jugadas: true },
      });

      return createdTicket;
    });

    // 🔟 Registrar ActivityLog fuera de la transacción (no bloqueante)
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

    // 🔁 Logging global
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
    // Cancelación segura en una sola transacción
    return await prisma.$transaction(async (tx) => {
      // 1️⃣ Verificar existencia y estado
      const existing = await tx.ticket.findUnique({
        where: { id },
        include: { sorteo: true },
      });

      if (!existing) {
        throw new AppError("Ticket not found", 404, "NOT_FOUND");
      }

      if (existing.status === TicketStatus.EVALUATED) {
        throw new AppError(
          "Cannot cancel an evaluated ticket",
          400,
          "INVALID_STATE"
        );
      }

      // 2️⃣ Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
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

      // 3️⃣ Actualizar ticket (soft delete + inactivar)
      const ticket = await tx.ticket.update({
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

      // 4️⃣ Registrar en ActivityLog (async, fuera de la TX)
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

      // 5️⃣ Logging global
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
    });
  },
};

export default TicketRepository;
