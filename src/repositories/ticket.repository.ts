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

// ────────────────────────────────────────────────────────────────────────────────
// Resolución de multiplicador Base (robusta + fallback)
// ────────────────────────────────────────────────────────────────────────────────

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

  // 2) Multiplicador de la Lotería (tabla loteriaMultiplier)
  const lmBase = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, name: "Base" },
    select: { valueX: true },
  });
  if (typeof lmBase?.valueX === "number" && lmBase.valueX > 0) {
    return { valueX: lmBase.valueX, source: "loteriaMultiplier[name=Base]" };
  }

  const lmNumero = await tx.loteriaMultiplier.findFirst({
    where: { loteriaId, isActive: true, kind: "NUMERO" },
    orderBy: { createdAt: "asc" },
    select: { valueX: true, name: true },
  });
  if (typeof lmNumero?.valueX === "number" && lmNumero.valueX > 0) {
    return {
      valueX: lmNumero.valueX,
      source: `loteriaMultiplier[kind=NUMERO,name=${lmNumero.name ?? ""}]`,
    };
  }

  // 3) Fallback: rulesJson en Lotería
  const lot = await tx.loteria.findUnique({
    where: { id: loteriaId },
    select: { rulesJson: true },
  });
  const rulesX = (lot?.rulesJson as any)?.baseMultiplierX;
  if (typeof rulesX === "number" && rulesX > 0) {
    return { valueX: rulesX, source: "loteria.rulesJson.baseMultiplierX" };
  }

  // 4) Fallback global por env
  const def = Number(process.env.MULTIPLIER_BASE_DEFAULT_X ?? 0);
  if (def > 0) {
    return { valueX: def, source: "env.MULTIPLIER_BASE_DEFAULT_X" };
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

// ────────────────────────────────────────────────────────────────────────────────

export const TicketRepository = {
  async create(data: CreateTicketInput, userId: string) {
    const { loteriaId, sorteoId, ventanaId, jugadas } = data;

    // Toda la operación dentro de una transacción con retry y timeouts explícitos
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Generador secuencial: función o secuencia local
        const [seqRow] = await tx.$queryRawUnsafe<
          { next_number: string | number }[]
        >(
          `
          SELECT CASE
            WHEN to_regprocedure('generate_ticket_number()') IS NOT NULL
              THEN generate_ticket_number()
            ELSE nextval('ticket_number_seq')
          END AS next_number
        `.trim()
        );
        const nextNumber = Number(seqRow?.next_number ?? 0);
        if (!nextNumber) {
          throw new AppError("Failed to generate ticket number", 500, "SEQ_ERROR");
        }

        // 2) Validación de FKs (defensiva)
        const [existsLoteria, sorteo, ventana, existsUser] = await Promise.all([
          tx.loteria.findUnique({ where: { id: loteriaId }, select: { id: true } }),
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

        if (!existsUser) throw new AppError("Seller (vendedor) not found", 404, "FK_VIOLATION");
        if (!existsLoteria) throw new AppError("Lotería not found", 404, "FK_VIOLATION");
        if (!sorteo) throw new AppError("Sorteo not found", 404, "FK_VIOLATION");
        if (!ventana) throw new AppError("Ventana not found", 404, "FK_VIOLATION");

        // 2.1) No permitir venta si sorteo no está abierto
        if (sorteo.status !== "OPEN") {
          throw new AppError("No se pueden crear tickets para sorteos no abiertos", 400, "SORTEO_NOT_OPEN");
        }

        // 3) Resolver X efectivo y asegurar fila Base
        const bancaId = ventana.bancaId;

        const { valueX: effectiveBaseX, source } = await resolveBaseMultiplierX(tx, {
          bancaId,
          loteriaId,
          userId,
        });

        const baseMultiplierRowId = await ensureBaseMultiplierRow(tx, loteriaId);

        logger.info({
          layer: "ticket",
          action: "BASE_MULTIPLIER_RESOLVED",
          payload: { bancaId, loteriaId, userId, effectiveBaseX, source },
        });

        // 4) Rules pipeline (User > Ventana > Banca)
        const now = new Date();
        const candidateRules = await tx.restrictionRule.findMany({
          where: {
            isDeleted: false,
            OR: [{ userId }, { ventanaId }, { bancaId }],
          },
        });

        const applicable = candidateRules
          .filter((r) => {
            if (r.appliesToDate && !isSameLocalDay(new Date(r.appliesToDate), now)) return false;
            if (typeof r.appliesToHour === "number" && r.appliesToHour !== now.getHours()) return false;
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

        // 6) Normalizar jugadas + total
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
              multiplierId: null,
            };
          }
          // NUMERO
          return {
            type: "NUMERO" as const,
            number: j.number,
            reventadoNumber: null,
            amount: j.amount,
            finalMultiplierX: effectiveBaseX, // congelado en venta
            multiplierId: baseMultiplierRowId, // "Base"
          };
        });

        const totalAmountTx = preparedJugadas.reduce((acc, j) => acc + j.amount, 0);

        // 7) Límite diario por vendedor
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const { _sum } = await tx.ticket.aggregate({
          _sum: { totalAmount: true },
          where: {
            vendedorId: userId,
            createdAt: { gte: dayStart },
          },
        });
        const dailyTotal = _sum.totalAmount ?? 0;
        const MAX_DAILY_TOTAL = Number(process.env.SALES_DAILY_MAX ?? 1000);
        if (dailyTotal + totalAmountTx > MAX_DAILY_TOTAL) {
          throw new AppError("Daily sales limit exceeded", 400, "LIMIT_VIOLATION");
        }

        // 8) Aplicar primera regla aplicable (si hay)
        if (applicable.length > 0) {
          const rule = applicable[0];
          if (rule.number) {
            const sumForNumber = preparedJugadas
              .filter((j) => j.number === rule.number)
              .reduce((acc, j) => acc + j.amount, 0);

            if (rule.maxAmount && sumForNumber > rule.maxAmount)
              throw new AppError(`Number ${rule.number} exceeded maxAmount (${rule.maxAmount})`, 400);

            if (rule.maxTotal && totalAmountTx > rule.maxTotal)
              throw new AppError(`Ticket total exceeded maxTotal (${rule.maxTotal})`, 400);
          } else {
            if (rule.maxAmount) {
              const maxBet = Math.max(...preparedJugadas.map((j) => j.amount));
              if (maxBet > rule.maxAmount)
                throw new AppError(`Bet amount exceeded maxAmount (${rule.maxAmount})`, 400);
            }
            if (rule.maxTotal && totalAmountTx > rule.maxTotal)
              throw new AppError(`Ticket total exceeded maxTotal (${rule.maxTotal})`, 400);
          }
        }

        // 9) Crear ticket y jugadas
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
                reventadoNumber: j.reventadoNumber ?? null,
                amount: j.amount,
                finalMultiplierX: j.finalMultiplierX,
                ...(j.multiplierId
                  ? { multiplier: { connect: { id: j.multiplierId } } }
                  : {}),
              })),
            },
          },
          include: { jugadas: true },
        });

        return createdTicket;
      },
      {
        // ✔️ opciones explícitas para robustez bajo carga
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // ActivityLog fuera de la TX (no bloqueante)
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

    // Logging
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
      search?: string;
      userId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    } = {}
  ) {
    const skip = (page - 1) * pageSize;

    const where: Prisma.TicketWhereInput = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(typeof filters.isDeleted === "boolean"
        ? { isDeleted: filters.isDeleted }
        : { isDeleted: false }),
      ...(filters.sorteoId ? { sorteoId: filters.sorteoId } : {}),
      ...(filters.userId ? { vendedorId: filters.userId } : {}),
      ...(filters.dateFrom || filters.dateTo
        ? {
            createdAt: {
              ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
              ...(filters.dateTo ? { lte: filters.dateTo } : {}),
            },
          }
        : {}),
    };

    // búsqueda unificada
    const s = typeof filters.search === "string" ? filters.search.trim() : "";
    if (s.length > 0) {
      const isDigits = /^\d+$/.test(s);
      const n = isDigits ? Number(s) : null;

      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        {
          OR: [
            ...(n !== null ? [{ ticketNumber: n } as Prisma.TicketWhereInput] : []),
            { vendedor: { name: { contains: s, mode: "insensitive" } } },
            { ventana: { name: { contains: s, mode: "insensitive" } } },
            { loteria: { name: { contains: s, mode: "insensitive" } } },
            { sorteo: { name: { contains: s, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const [data, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          loteria: { select: { id: true, name: true } },
          sorteo: { select: { id: true, name: true, status: true, scheduledAt: true } },
          ventana: { select: { id: true, name: true } },
          vendedor: { select: { id: true, name: true, role: true } },
          jugadas: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticket.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const meta = {
      total,
      page,
      pageSize,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    logger.info({
      layer: "repository",
      action: "TICKET_LIST",
      payload: {
        filters: { ...filters, search: s || undefined },
        page,
        pageSize,
        total,
      },
    });

    return { data, meta };
  },

  async cancel(id: string, userId: string) {
    // Cancelación bajo retry + timeouts (misma estrategia que create)
    const ticket = await withTransactionRetry(
      async (tx) => {
        // 1) Verificar existencia y estado
        const existing = await tx.ticket.findUnique({
          where: { id },
          include: { sorteo: true },
        });

        if (!existing) {
          throw new AppError("Ticket not found", 404, "NOT_FOUND");
        }

        if (existing.status === TicketStatus.EVALUATED) {
          throw new AppError("Cannot cancel an evaluated ticket", 400, "INVALID_STATE");
        }

        // 2) Validar sorteo (no permitir cancelar si el sorteo ya está cerrado o evaluado)
        if (existing.sorteo.status === "CLOSED" || existing.sorteo.status === "EVALUATED") {
          throw new AppError("Cannot cancel ticket from closed or evaluated sorteo", 400, "SORTEO_LOCKED");
        }

        // 3) Actualizar ticket (soft delete + inactivar)
        const cancelled = await tx.ticket.update({
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

        return cancelled;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxRetries: 3,
        backoffMinMs: 150,
        backoffMaxMs: 2_000,
        maxWaitMs: 10_000,
        timeoutMs: 20_000,
      }
    );

    // ActivityLog fuera de la TX (no bloqueante)
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

    // Logging global
    logger.warn({
      layer: "repository",
      action: "TICKET_CANCEL_DB",
      payload: {
        ticketId: id,
        userId,
        sorteoId: (ticket as any).sorteoId,
        totalAmount: ticket.totalAmount,
      },
    });

    return ticket;
  },
};

export default TicketRepository;
