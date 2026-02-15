// src/repositories/sorteo.repository.ts
import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, SorteoStatus, TicketStatus } from "@prisma/client";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../api/v1/dto/sorteo.dto";
import { formatIsoLocal, parseCostaRicaDateTime } from "../utils/datetime";

// ️ helper para validar y obtener X del multiplier extra
async function resolveExtraMultiplierX(
  extraMultiplierId: string,
  loteriaId: string,
  tx = prisma
) {
  const mul = await tx.loteriaMultiplier.findUnique({
    where: { id: extraMultiplierId },
    select: {
      id: true,
      valueX: true,
      isActive: true,
      loteriaId: true,
      kind: true,
      name: true,
      appliesToSorteoId: true,
    },
  });

  if (!mul || !mul.isActive) {
    throw new AppError("extraMultiplierId inválido o inactivo", 400);
  }
  if (mul.loteriaId !== loteriaId) {
    throw new AppError(
      "extraMultiplierId no pertenece a la lotería del sorteo",
      400
    );
  }
  if (mul.kind !== "REVENTADO") {
    throw new AppError("extraMultiplierId no es de tipo REVENTADO", 400);
  }
  if (mul.appliesToSorteoId && mul.appliesToSorteoId !== loteriaId) {
    // Si mul.appliesToSorteoId está seteado, la validación se hace en service.evaluate
    // comparándolo con el id del sorteo (NO con loteriaId).
  }

  return mul.valueX;
}

const toPrismaCreate = (d: CreateSorteoDTO): Prisma.SorteoCreateInput => ({
  name: d.name,
  //  Confiar en la fecha ya normalizada por zodDateCR() en el validator
  scheduledAt: d.scheduledAt instanceof Date
    ? d.scheduledAt
    : parseCostaRicaDateTime(d.scheduledAt), // Fallback por si acaso
  loteria: { connect: { id: d.loteriaId } },
  digits: d.digits ?? 2, //  Mapear campo digits (default 2 si no viene, aunque debería venir del service)
  // extraOutcomeCode, extraMultiplierId/X se quedan nulos al crear
});

const toPrismaUpdate = (d: UpdateSorteoDTO): Prisma.SorteoUpdateInput => ({
  //  ÚNICAMENTE se permite reprogramar la fecha/hora (más name/isActive si lo quieres)
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? d.scheduledAt
      : parseCostaRicaDateTime(d.scheduledAt) // Fallback por si acaso
    : undefined,
  name: d.name ?? undefined,
  digits: d.digits ?? undefined, //  Mapear campo digits
  ...(d.loteriaId ? { loteria: { connect: { id: d.loteriaId } } } : {}),
  ...(typeof d.isActive === "boolean" ? { isActive: d.isActive } : {}),
  // No se permite tocar status/winning/extraOutcome/extraMultiplier aquí
});

const SorteoRepository = {
  async create(data: CreateSorteoDTO) {
    const s = await prisma.sorteo.create({
      data: toPrismaCreate(data),
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_CREATE_DB",
      payload: { sorteoId: s.id },
    });
    return s;
  },

  findById(id: string) {
    return prisma.sorteo.findUnique({
      where: { id },
      include: {
        loteria: true,
        extraMultiplier: { select: { id: true, name: true, valueX: true } },
      },
    });
  },

  async update(id: string, data: UpdateSorteoDTO) {
    const s = await prisma.sorteo.update({
      where: { id },
      data: toPrismaUpdate(data),
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_UPDATE_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  async open(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (current.status !== SorteoStatus.SCHEDULED) {
      throw new AppError(
        `Solo se pueden abrir sorteos en estado SCHEDULED (actual: ${current.status})`,
        400
      );
    }
    const s = await prisma.sorteo.update({
      where: { id },
      data: { status: SorteoStatus.OPEN },
      include: {
        loteria: {
          select: {
            id: true,
            name: true,
            rulesJson: true,
          },
        },
        extraMultiplier: {
          select: { id: true, name: true, valueX: true },
        },
      },
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_OPEN_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  /**
   * Fuerza el cambio de estado a OPEN desde cualquier estado (excepto EVALUATED)
   * Útil para reabrir sorteos que están en CLOSED
   */
  async forceOpen(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (current.status === SorteoStatus.EVALUATED) {
      throw new AppError(
        "No se puede reabrir un sorteo evaluado. Usa revert-evaluation primero.",
        400
      );
    }
    const result = await prisma.$transaction(async (tx) => {
      const s = await tx.sorteo.update({
        where: { id },
        data: { status: SorteoStatus.OPEN },
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });

      //  NUEVO: Revertir flag de cierre en tickets (desbloquear)
      const ticketsAffected = await tx.ticket.updateMany({
        where: { sorteoId: id },
        data: { isSorteoClosed: false },
      });

      return { s, ticketsAffected };
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_FORCE_OPEN_DB",
      payload: {
        sorteoId: id,
        previousStatus: current.status,
        ticketsUnlocked: result.ticketsAffected.count
      },
    });
    return result.s;
  },

  async close(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (
      current.status !== SorteoStatus.OPEN &&
      current.status !== SorteoStatus.EVALUATED
    ) {
      throw new AppError(
        `Solo se pueden cerrar sorteos en estado OPEN o EVALUATED (actual: ${current.status})`,
        400
      );
    }
    const s = await prisma.$transaction(async (tx) => {
      const closed = await tx.sorteo.update({
        where: { id },
        data: { status: SorteoStatus.CLOSED },
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });
      return closed;
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_CLOSE_DB",
      payload: { sorteoId: id },
    });
    return s;
  },

  /**
   *  NUEVO: Cierra sorteo con cascada a tickets
   *
   * Transacción atómica que:
   * 1. Marca sorteo como CLOSED
   * 2. Marca todos los tickets con isSorteoClosed=true
   * 3. Retorna datos de sorteo y count de tickets afectados
   *
   * @param id - ID del sorteo
   * @returns { sorteo, ticketsAffected: number }
   */
  async closeWithCascade(id: string) {
    const current = await prisma.sorteo.findUnique({ where: { id } });
    if (!current) throw new AppError("Sorteo no encontrado", 404);
    if (
      current.status !== SorteoStatus.OPEN &&
      current.status !== SorteoStatus.EVALUATED
    ) {
      throw new AppError(
        `Solo se pueden cerrar sorteos en estado OPEN o EVALUATED (actual: ${current.status})`,
        400
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Cerrar sorteo
      const closed = await tx.sorteo.update({
        where: { id },
        data: { status: SorteoStatus.CLOSED },
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });

      // 2️⃣ Marcar tickets como cerrados (cascada)
      const ticketsAffected = await tx.ticket.updateMany({
        where: {
          sorteoId: id,
          deletedAt: null, // Solo tickets activos
        },
        data: {
          isSorteoClosed: true,
        },
      });

      return {
        sorteo: closed,
        ticketsAffected: ticketsAffected.count,
      };
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_CLOSE_CASCADE_DB",
      payload: {
        sorteoId: id,
        ticketsAffected: result.ticketsAffected,
      },
    });

    return result;
  },

  async revertEvaluation(id: string) {
    const sorteo = await prisma.$transaction(async (tx) => {
      const current = await tx.sorteo.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (!current) throw new AppError("Sorteo no encontrado", 404);
      if (current.status !== SorteoStatus.EVALUATED) {
        throw new AppError("Solo se puede revertir un sorteo evaluado", 409);
      }

      const tickets = await tx.ticket.findMany({
        where: { sorteoId: id },
        select: {
          id: true,
          ventanaId: true,
          vendedorId: true,
          businessDate: true,
          createdAt: true,
        },
      });

      // 2️⃣ Eliminar pagos de tickets del sorteo
      const paymentsDeleted = await tx.$executeRaw`
        DELETE FROM "TicketPayment"
        WHERE "ticketId" IN (
          SELECT id FROM "Ticket" WHERE "sorteoId" = ${id}::uuid
        )
      `;

      // 3️⃣ Resetear jugadas (ganadoras y multiplicadores reventado)
      await tx.$executeRaw`
        UPDATE "Jugada" j
        SET "isWinner" = false,
            "payout" = 0,
            "finalMultiplierX" = CASE WHEN j."type" = 'REVENTADO' THEN 0 ELSE j."finalMultiplierX" END,
            "multiplierId" = CASE WHEN j."type" = 'REVENTADO' THEN NULL ELSE j."multiplierId" END
        FROM "Ticket" t
        WHERE j."ticketId" = t.id AND t."sorteoId" = ${id}::uuid
      `;

      // 4️⃣ Resetear tickets (status ACTIVE, isWinner false, montos a 0)
      await tx.$executeRaw`
        UPDATE "Ticket"
        SET "status" = 'ACTIVE',
            "isWinner" = false,
            "totalPayout" = 0,
            "totalPaid" = 0,
            "remainingAmount" = 0,
            "lastPaymentAt" = NULL,
            "paidById" = NULL,
            "paymentMethod" = NULL,
            "paymentNotes" = NULL,
            "paymentHistory" = NULL
        WHERE "sorteoId" = ${id}::uuid 
        AND "status" IN ('EVALUATED', 'PAID')
      `;

      const ventanaTargets = new Map<string, { ventanaId: string; date: Date }>();
      const vendedorTargets = new Map<string, { vendedorId: string; date: Date }>();

      for (const ticket of tickets) {
        const baseDate = ticket.businessDate ? new Date(ticket.businessDate) : new Date(ticket.createdAt);
        baseDate.setUTCHours(0, 0, 0, 0);
        if (ticket.ventanaId) {
          const key = `${ticket.ventanaId}-${baseDate.toISOString()}`;
          if (!ventanaTargets.has(key)) {
            ventanaTargets.set(key, { ventanaId: ticket.ventanaId, date: baseDate });
          }
        }
        if (ticket.vendedorId) {
          const key = `${ticket.vendedorId}-${baseDate.toISOString()}`;
          if (!vendedorTargets.has(key)) {
            vendedorTargets.set(key, { vendedorId: ticket.vendedorId, date: baseDate });
          }
        }
      }

      const statementIds: string[] = [];

      if (ventanaTargets.size > 0) {
        const ventanaStatements = await tx.accountStatement.findMany({
          where: {
            OR: Array.from(ventanaTargets.values()).map(({ ventanaId, date }) => ({
              date,
              ventanaId,
              vendedorId: null,
            })),
          },
          select: { id: true },
        });
        statementIds.push(...ventanaStatements.map(s => s.id));
      }

      if (vendedorTargets.size > 0) {
        const vendedorStatements = await tx.accountStatement.findMany({
          where: {
            OR: Array.from(vendedorTargets.values()).map(({ vendedorId, date }) => ({
              date,
              vendedorId,
              ventanaId: null,
            })),
          },
          select: { id: true },
        });
        statementIds.push(...vendedorStatements.map(s => s.id));
      }

      let accountPaymentsDeleted = 0;
      if (statementIds.length > 0) {
        // Eliminar pagos usando UNNEST para evitar IN masivo
        const res = await tx.$executeRaw`
          DELETE FROM "AccountPayment"
          WHERE "accountStatementId" = ANY(UNNEST(${statementIds}::uuid[]))
        `;
        accountPaymentsDeleted = res;

        // Resetear statements usando UNNEST
        await tx.$executeRaw`
          UPDATE "AccountStatement"
          SET "totalPaid" = 0,
              "remainingBalance" = "balance",
              "isSettled" = false,
              "canEdit" = true
          WHERE "id" = ANY(UNNEST(${statementIds}::uuid[]))
        `;
      }

      const updated = await tx.sorteo.update({
        where: { id },
        data: {
          status: SorteoStatus.OPEN,
          winningNumber: null,
          extraOutcomeCode: null,
          extraMultiplierX: null,
          hasWinner: false,
          extraMultiplier: { disconnect: true },
        },
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });

      logger.info({
        layer: "repository",
        action: "SORTEO_REVERT_EVALUATION_DB",
        payload: {
          sorteoId: id,
          paymentsDeleted,
          accountPaymentsDeleted,
        },
      });

      return updated;
    }, { timeout: 180000 }); // 3 minutos para sorteos con muchos tickets/jugadas

    return sorteo;
  },

  // ️ evaluate ahora paga jugadas y asigna multiplierId a REVENTADO ganadores
  // Dentro de SorteoRepository
  async evaluate(
    id: string,
    body: {
      winningNumber: string
      extraOutcomeCode?: string | null
      extraMultiplierId?: string | null
    }
  ) {
    const {
      winningNumber,
      extraOutcomeCode = null,
      extraMultiplierId = null,
    } = body

    // 1) Validaciones base
    const existing = await prisma.sorteo.findUnique({
      where: { id },
      select: { id: true, loteriaId: true, status: true },
    })
    if (!existing) throw new AppError('Sorteo no encontrado', 404)
    if (existing.status === SorteoStatus.EVALUATED || existing.status === SorteoStatus.CLOSED) {
      throw new AppError('Sorteo ya evaluado/cerrado', 400)
    }

    // 2) Validar y obtener X del multiplicador extra (si viene)
    let extraX: number | null = null
    if (extraMultiplierId) {
      extraX = await resolveExtraMultiplierX(extraMultiplierId, existing.loteriaId, prisma)
    }

    // 3) Transacción: actualizar sorteo, pagar jugadas y marcar tickets
    await prisma.$transaction(async (tx) => {
      // 3.1) Actualizar sorteo con snapshot del multiplicador extra y relación
      await tx.sorteo.update({
        where: { id },
        data: {
          status: SorteoStatus.EVALUATED,
          winningNumber,
          extraOutcomeCode,
          ...(extraMultiplierId
            ? { extraMultiplier: { connect: { id: extraMultiplierId } } }
            : { extraMultiplier: { disconnect: true } }),
          extraMultiplierX: extraX,
        },
      })

      // 3.2) Marcar ganadores por NUMERO y REVENTADO en una sola operación por tabla
      // Primero: NUMERO winners
      await tx.$executeRaw`
        UPDATE "Jugada" j
        SET "isWinner" = true,
            "payout" = j."amount" * j."finalMultiplierX"
        FROM "Ticket" t
        WHERE j."ticketId" = t.id 
        AND t."sorteoId" = ${id}::uuid
        AND t."status" != 'CANCELLED'
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."type" = 'NUMERO'
        AND j."number" = ${winningNumber}
        AND j."isActive" = true
      `;

      // Segundo: REVENTADO winners (si aplica)
      if (extraX != null && extraX > 0) {
        if (!extraMultiplierId) {
          throw new AppError(
            'Falta extraMultiplierId para asignar a jugadas REVENTADO ganadoras',
            400
          );
        }
        await tx.$executeRaw`
          UPDATE "Jugada" j
          SET "isWinner" = true,
              "finalMultiplierX" = ${extraX},
              "payout" = j."amount" * ${extraX},
              "multiplierId" = ${extraMultiplierId}::uuid
          FROM "Ticket" t
          WHERE j."ticketId" = t.id 
          AND t."sorteoId" = ${id}::uuid
          AND t."status" != 'CANCELLED'
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."type" = 'REVENTADO'
          AND j."reventadoNumber" = ${winningNumber}
          AND j."isActive" = true
        `;
      }

      // 3.4) Marcar todos los tickets como EVALUATED e isWinner=false (base)
      await tx.ticket.updateMany({
        where: { 
          sorteoId: id,
          status: { not: 'CANCELLED' },
          deletedAt: null
        },
        data: { status: 'EVALUATED', isWinner: false },
      });

      // 3.5) Marcar tickets ganadores y calcular totalPayout en una sola operación
      await tx.$executeRaw`
        WITH Payouts AS (
          SELECT "ticketId", SUM("payout") as total
          FROM "Jugada"
          WHERE "ticketId" IN (SELECT id FROM "Ticket" WHERE "sorteoId" = ${id}::uuid)
          AND "isWinner" = true
          GROUP BY "ticketId"
        )
        UPDATE "Ticket" t
        SET "isWinner" = true,
            "totalPayout" = p.total,
            "remainingAmount" = p.total,
            "totalPaid" = 0
        FROM Payouts p
        WHERE t.id = p."ticketId"
      `;

      // 3.6) Actualizar sorteo con hasWinner
      await tx.$executeRaw`
        UPDATE "Sorteo"
        SET "hasWinner" = EXISTS (
          SELECT 1 FROM "Ticket" 
          WHERE "sorteoId" = ${id}::uuid AND "isWinner" = true
        )
        WHERE id = ${id}::uuid
      `;

      // 3.7) Obtener datos para el log
      const winnersCount = await tx.ticket.count({
        where: { sorteoId: id, isWinner: true }
      });
      const sorteoFinal = await tx.sorteo.findUnique({
        where: { id },
        select: { hasWinner: true }
      });

      // Log útil
      logger.info({
        layer: 'repository',
        action: 'SORTEO_EVALUATE_DB',
        payload: {
          sorteoId: id,
          winningNumber,
          extraMultiplierId,
          extraMultiplierX: extraX,
          winners: winnersCount,
          hasWinner: sorteoFinal?.hasWinner || false,
        },
      })
    })

    // 4) Devolver sorteo ya evaluado con relaciones
    return prisma.sorteo.findUnique({
      where: { id },
      include: {
        loteria: { select: { id: true, name: true } },
        extraMultiplier: { select: { id: true, name: true, valueX: true } },
      },
    })
  },

  async list(params: {
    loteriaId?: string;
    page: number;
    pageSize: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    lastId?: string;
    lastScheduledAt?: Date;
  }) {
    const { loteriaId, page, pageSize, status, search, isActive, dateFrom, dateTo, lastId, lastScheduledAt } = params;

    logger.info({
      layer: "repository",
      action: "SORTEO_LIST_PARAMS",
      payload: {
        dateFrom: dateFrom?.toISOString(),
        dateTo: dateTo?.toISOString(),
        loteriaId,
        status,
        isActive,
        message: "Parámetros recibidos en repository"
      }
    });

    const where: Prisma.SorteoWhereInput = {
      ...(loteriaId ? { loteriaId } : {}),
      ...(status ? { status } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      //  Filtro de fecha: si se proporciona, usarlo; si no, sin restricción de fecha
      ...(dateFrom || dateTo
        ? {
          scheduledAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
        : {}),
    };

    logger.info({
      layer: "repository",
      action: "SORTEO_LIST_WHERE",
      payload: {
        where: JSON.stringify(where),
        message: "Filtro WHERE construido"
      }
    });

    const q = (search ?? '').trim();
    if (q) {
      const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      where.AND = [
        ...and,
        {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { winningNumber: { contains: q, mode: 'insensitive' } },
            { loteria: { name: { contains: q, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    const skip = Math.max(0, (page - 1) * pageSize);

    //  Optimización: Usar SQL raw con subconsultas para hasSales y ticketCount
    // Evita N+1 queries y calcula ambos campos en una sola query
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${loteriaId}::uuid`);
    }
    if (status) {
      //  Convertir enum a string literal para PostgreSQL
      // Prisma.sql necesita el valor como string literal, no como enum TypeScript
      // Usar Prisma.raw() para insertar el string literal directamente en SQL (escapar comillas simples)
      const statusStr = String(status);
      whereConditions.push(Prisma.sql`s."status" = ${Prisma.raw(`'${statusStr.replace(/'/g, "''")}'`)}`);
    }
    if (typeof isActive === 'boolean') {
      whereConditions.push(Prisma.sql`s."isActive" = ${isActive}`);
    }
    if (dateFrom) {
      whereConditions.push(Prisma.sql`s."scheduledAt" >= ${dateFrom}`);
    }
    if (dateTo) {
      whereConditions.push(Prisma.sql`s."scheduledAt" <= ${dateTo}`);
    }

    // Keyset pagination: scheduledAt DESC, createdAt DESC, id DESC
    if (lastId) {
      if (lastScheduledAt) {
        whereConditions.push(Prisma.sql`(
          s."scheduledAt" < ${lastScheduledAt} OR 
          (s."scheduledAt" = ${lastScheduledAt} AND s.id < ${lastId}::uuid)
        )`);
      } else {
        whereConditions.push(Prisma.sql`s.id < ${lastId}::uuid`);
      }
    }

    if (q) {
      whereConditions.push(Prisma.sql`(
        s."name" ILIKE ${`%${q}%`} OR
        s."winningNumber" ILIKE ${`%${q}%`} OR
        l."name" ILIKE ${`%${q}%`}
      )`);
    }

    const whereSql = whereConditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

    // Query SQL optimizada con subconsultas para hasSales y ticketCount
    const dataQuery = Prisma.sql`
      SELECT 
        s.id,
        s."loteriaId",
        s."scheduledAt",
        s."status",
        s."winningNumber",
        s."hasWinner",
        s."isActive",
        s."deletedAt",
        s."deletedBy",
        s."deletedReason",
        s."createdAt",
        s."updatedAt",
        s."name",
        s."extraMultiplierId",
        s."extraMultiplierX",
        s."extraOutcomeCode",
        s."digits",
        s."deletedByCascade",
        s."deletedByCascadeFrom",
        s."deletedByCascadeId",
        --  NUEVO: Campos de ventas
        EXISTS(
          SELECT 1 FROM "Ticket" t
          WHERE t."sorteoId" = s.id
          AND t."status" != 'CANCELLED'
          AND t."deletedAt" IS NULL
        ) as "hasSales",
        (
          SELECT COUNT(*)::int FROM "Ticket" t
          WHERE t."sorteoId" = s.id
          AND t."status" != 'CANCELLED'
          AND t."deletedAt" IS NULL
        ) as "ticketCount",
        -- Relaciones
        json_build_object(
          'id', l.id,
          'name', l."name",
          'rulesJson', l."rulesJson"
        ) as loteria,
        CASE 
          WHEN em.id IS NOT NULL THEN
            json_build_object(
              'id', em.id,
              'name', em."name",
              'valueX', em."valueX"
            )
          ELSE NULL
        END as "extraMultiplier"
      FROM "Sorteo" s
      INNER JOIN "Loteria" l ON l.id = s."loteriaId"
      LEFT JOIN "LoteriaMultiplier" em ON em.id = s."extraMultiplierId"
      ${whereSql}
      ORDER BY s."scheduledAt" DESC, s.id DESC
      LIMIT ${pageSize} OFFSET ${lastId ? 0 : skip}
    `;

    const countQuery = Prisma.sql`
      SELECT COUNT(*)::int as total
      FROM "Sorteo" s
      INNER JOIN "Loteria" l ON l.id = s."loteriaId"
      ${whereSql}
    `;

    const [dataRows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<{
        id: string;
        loteriaId: string;
        scheduledAt: Date;
        status: string;
        winningNumber: string | null;
        hasWinner: boolean;
        isActive: boolean;
        deletedAt: Date | null;
        deletedBy: string | null;
        deletedReason: string | null;
        createdAt: Date;
        updatedAt: Date;
        name: string;
        extraMultiplierId: string | null;
        extraMultiplierX: number | null;
        extraOutcomeCode: string | null;
        digits: number;
        deletedByCascade: boolean;
        deletedByCascadeFrom: string | null;
        deletedByCascadeId: string | null;
        hasSales: boolean;
        ticketCount: number;
        loteria: { id: string; name: string; rulesJson: any };
        extraMultiplier: { id: string; name: string; valueX: number } | null;
      }>>(dataQuery),
      prisma.$queryRaw<Array<{ total: number }>>(countQuery),
    ]);

    const total = countRows[0]?.total || 0;

    // Mapear resultados a formato esperado por Prisma
    const data = dataRows.map((row) => ({
      id: row.id,
      loteriaId: row.loteriaId,
      scheduledAt: row.scheduledAt,
      status: row.status as SorteoStatus,
      winningNumber: row.winningNumber,
      hasWinner: row.hasWinner,
      isActive: row.isActive,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      deletedReason: row.deletedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      name: row.name,
      extraMultiplierId: row.extraMultiplierId,
      extraMultiplierX: row.extraMultiplierX,
      extraOutcomeCode: row.extraOutcomeCode,
      digits: row.digits,
      deletedByCascade: row.deletedByCascade,
      deletedByCascadeFrom: row.deletedByCascadeFrom,
      deletedByCascadeId: row.deletedByCascadeId,
      //  NUEVO: Campos de ventas
      hasSales: row.hasSales,
      ticketCount: row.ticketCount,
      loteria: row.loteria,
      extraMultiplier: row.extraMultiplier,
    }));

    return { data, total };
  },

  async softDelete(id: string, userId: string, reason?: string, byCascade = false, cascadeFrom?: string, cascadeId?: string) {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    //  MEJORADO: Usar transacción para marcar sorteo Y tickets como eliminados
    const result = await prisma.$transaction(async (tx) => {
      // 1️⃣ Eliminar sorteo
      const s = await tx.sorteo.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          deletedBy: userId,
          deletedReason: reason || null,
          isActive: false,
          status: SorteoStatus.CLOSED,
          // Campos de cascada: si es por cascada, marcar; si es manual, limpiar
          deletedByCascade: byCascade,
          deletedByCascadeFrom: byCascade ? (cascadeFrom || null) : null,
          deletedByCascadeId: byCascade ? (cascadeId || null) : null,
        },
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });

      // 2️⃣  NUEVO: Marcar tickets como eliminados también
      const ticketsAffected = await tx.ticket.updateMany({
        where: {
          sorteoId: id,
          deletedAt: null,  // Solo tickets no eliminados
        },
        data: {
          deletedAt: new Date(),
          deletedBy: userId,
          deletedReason: `Eliminado por cascada del sorteo: ${reason || 'sin motivo'}`,
        },
      });

      return { sorteo: s, ticketsAffected: ticketsAffected.count };
    });

    logger.warn({
      layer: "repository",
      action: "SORTEO_SOFT_DELETE_CASCADE_DB",
      payload: {
        sorteoId: id,
        reason,
        byCascade,
        cascadeFrom,
        cascadeId,
        ticketsAffected: result.ticketsAffected,  //  NUEVO: Log cuántos tickets se marcaron
      },
    });
    return result.sorteo;
  },

  /**
   * Restaura un sorteo (soft delete revert Y/O reapertura de sorteo cerrado)
   * Maneja dos casos:
   * - Caso A: Sorteo soft-deleted (deletedAt != null) → limpia campos de eliminación y restaura tickets
   * - Caso B: Sorteo cerrado (status = CLOSED) → reabre a OPEN y desbloquea tickets
   * - Caso C: Ambos → aplica ambas restauraciones
   */
  async restore(id: string): Promise<any> {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const isSoftDeleted = existing.deletedAt !== null;
    const isClosed = existing.status === SorteoStatus.CLOSED;

    // Validar que haya algo que restaurar
    if (!isSoftDeleted && !isClosed) {
      throw new AppError(
        "Sorteo no requiere restauración (no está eliminado ni cerrado)",
        400
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // Preparar data de actualización del sorteo
      const updateData: any = {};

      // Caso A: Soft-deleted → limpiar campos de eliminación
      if (isSoftDeleted) {
        updateData.deletedAt = null;
        updateData.deletedBy = null;
        updateData.deletedReason = null;
        updateData.isActive = true;
        updateData.deletedByCascade = false;
        updateData.deletedByCascadeFrom = null;
        updateData.deletedByCascadeId = null;
      }

      // Caso B: Cerrado → reabrir
      if (isClosed) {
        updateData.status = SorteoStatus.OPEN;
      }

      // Actualizar sorteo
      const s = await tx.sorteo.update({
        where: { id },
        data: updateData,
        include: {
          loteria: {
            select: {
              id: true,
              name: true,
              rulesJson: true,
            },
          },
          extraMultiplier: {
            select: { id: true, name: true, valueX: true },
          },
        },
      });

      // Restaurar tickets según el caso
      let ticketsRestored = 0;

      if (isSoftDeleted) {
        // Restaurar tickets eliminados por cascada del sorteo
        const ticketsResult = await tx.ticket.updateMany({
          where: {
            sorteoId: id,
            deletedAt: { not: null }
          },
          data: {
            deletedAt: null,
            deletedBy: null,
            deletedReason: null,
          }
        });
        ticketsRestored = ticketsResult.count;
      }

      if (isClosed) {
        // Desbloquear tickets cerrados (isSorteoClosed)
        const ticketsResult = await tx.ticket.updateMany({
          where: { sorteoId: id },
          data: { isSorteoClosed: false }
        });
        // Si ya restauramos tickets eliminados, este count puede ser diferente
        // Usamos el máximo para el log
        ticketsRestored = Math.max(ticketsRestored, ticketsResult.count);
      }

      return { s, ticketsRestored };
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_RESTORE_DB",
      payload: {
        sorteoId: id,
        wasSoftDeleted: isSoftDeleted,
        wasClosed: isClosed,
        ticketsRestored: result.ticketsRestored
      },
    });
    return result.s;
  },

  /**
   * Inactiva todos los sorteos activos de una lotería por cascada (solo cambia isActive=false)
   * Usado cuando se inactiva una lotería mediante update(isActive=false)
   * Puede usar un cliente de transacción opcional para operaciones atómicas
   */
  async setInactiveSorteosByLoteria(loteriaId: string, tx?: Prisma.TransactionClient): Promise<{ count: number; sorteosIds: string[] }> {
    const client = tx || prisma;

    // Buscar sorteos activos de esta lotería (que no estén soft-deleted)
    const activeSorteos = await client.sorteo.findMany({
      where: {
        loteriaId,
        deletedAt: null, // Solo sorteos no soft-deleted
        isActive: true, // Solo los que están activos
      },
      select: {
        id: true,
      },
    });

    if (activeSorteos.length === 0) {
      return { count: 0, sorteosIds: [] };
    }

    const sorteosIds = activeSorteos.map(s => s.id);

    // Solo cambiar isActive=false, sin hacer soft delete
    const result = await client.sorteo.updateMany({
      where: {
        id: { in: sorteosIds },
      },
      data: {
        isActive: false,
        deletedByCascade: true,
        deletedByCascadeFrom: 'loteria',
        deletedByCascadeId: loteriaId,
      },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_SET_INACTIVE_BY_LOTERIA_CASCADE",
      payload: {
        loteriaId,
        sorteosAffected: result.count,
        sorteosIds,
      },
    });

    return { count: result.count, sorteosIds };
  },

  /**
   * Inactiva todos los sorteos activos de una lotería por cascada (soft delete completo)
   * Usado cuando se hace soft delete de una lotería
   * Solo afecta sorteos que actualmente están activos (deletedAt IS NULL)
   * Puede usar un cliente de transacción opcional para operaciones atómicas
   */
  async inactivateSorteosByLoteria(loteriaId: string, userId: string, tx?: Prisma.TransactionClient): Promise<{ count: number; sorteosIds: string[] }> {
    const client = tx || prisma;
    const now = new Date();

    // Buscar sorteos activos de esta lotería
    const activeSorteos = await client.sorteo.findMany({
      where: {
        loteriaId,
        deletedAt: null, // Solo sorteos activos
      },
      select: {
        id: true,
      },
    });

    if (activeSorteos.length === 0) {
      return { count: 0, sorteosIds: [] };
    }

    const sorteosIds = activeSorteos.map(s => s.id);

    // Actualizar todos en batch
    const result = await client.sorteo.updateMany({
      where: {
        id: { in: sorteosIds },
      },
      data: {
        deletedAt: now,
        deletedBy: userId,
        deletedReason: `Inactivado por cascada desde lotería ${loteriaId}`,
        isActive: false,
        status: SorteoStatus.CLOSED,
        deletedByCascade: true,
        deletedByCascadeFrom: 'loteria',
        deletedByCascadeId: loteriaId,
      },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_INACTIVATE_BY_LOTERIA_CASCADE",
      payload: {
        loteriaId,
        sorteosAffected: result.count,
        sorteosIds,
      },
    });

    return { count: result.count, sorteosIds };
  },

  /**
   * Restaura isActive=true en sorteos que fueron inactivados por cascada desde una lotería
   * Usado cuando se restaura una lotería mediante update(isActive=true)
   * Solo restaura sorteos que tienen deletedByCascade=true y deletedByCascadeFrom='loteria' y deletedByCascadeId=loteriaId
   * Puede usar un cliente de transacción opcional para operaciones atómicas
   */
  async setActiveSorteosByLoteria(loteriaId: string, tx?: Prisma.TransactionClient): Promise<{ count: number; sorteosIds: string[] }> {
    const client = tx || prisma;

    // Buscar sorteos inactivados por cascada desde esta lotería (que no estén soft-deleted)
    const cascadeSorteos = await client.sorteo.findMany({
      where: {
        loteriaId,
        deletedAt: null, // Solo sorteos no soft-deleted
        isActive: false, // Solo los que están inactivos
        deletedByCascade: true,
        deletedByCascadeFrom: 'loteria',
        deletedByCascadeId: loteriaId,
      },
      select: {
        id: true,
      },
    });

    if (cascadeSorteos.length === 0) {
      return { count: 0, sorteosIds: [] };
    }

    const sorteosIds = cascadeSorteos.map(s => s.id);

    // Solo cambiar isActive=true y limpiar campos de cascada
    const result = await client.sorteo.updateMany({
      where: {
        id: { in: sorteosIds },
      },
      data: {
        isActive: true,
        // Limpiar campos de cascada
        deletedByCascade: false,
        deletedByCascadeFrom: null,
        deletedByCascadeId: null,
      },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_SET_ACTIVE_BY_LOTERIA_CASCADE",
      payload: {
        loteriaId,
        sorteosRestored: result.count,
        sorteosIds,
      },
    });

    return { count: result.count, sorteosIds };
  },

  /**
   * Restaura todos los sorteos que fueron inactivados por cascada desde una lotería (soft delete completo)
   * Usado cuando se restaura una lotería mediante restore()
   * Solo restaura sorteos que tienen deletedByCascade=true y deletedByCascadeFrom='loteria' y deletedByCascadeId=loteriaId
   * Puede usar un cliente de transacción opcional para operaciones atómicas
   */
  async restoreSorteosByLoteria(loteriaId: string, tx?: Prisma.TransactionClient): Promise<{ count: number; sorteosIds: string[] }> {
    const client = tx || prisma;

    // Buscar sorteos inactivados por cascada desde esta lotería (soft-deleted)
    const cascadeSorteos = await client.sorteo.findMany({
      where: {
        loteriaId,
        deletedAt: { not: null },
        deletedByCascade: true,
        deletedByCascadeFrom: 'loteria',
        deletedByCascadeId: loteriaId,
      },
      select: {
        id: true,
      },
    });

    if (cascadeSorteos.length === 0) {
      return { count: 0, sorteosIds: [] };
    }

    const sorteosIds = cascadeSorteos.map(s => s.id);

    // Restaurar todos en batch (soft delete completo)
    const result = await client.sorteo.updateMany({
      where: {
        id: { in: sorteosIds },
      },
      data: {
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        isActive: true,
        // Limpiar campos de cascada
        deletedByCascade: false,
        deletedByCascadeFrom: null,
        deletedByCascadeId: null,
      },
    });

    logger.info({
      layer: "repository",
      action: "SORTEO_RESTORE_BY_LOTERIA_CASCADE",
      payload: {
        loteriaId,
        sorteosRestored: result.count,
        sorteosIds,
      },
    });

    return { count: result.count, sorteosIds };
  },

  async bulkCreateIfMissing(loteriaId: string, occurrences: Array<{ scheduledAt: Date; name: string }>, digits: number = 2) {
    if (occurrences.length === 0) return { created: [], skipped: [], alreadyExists: [], processed: [] }

    // Ordenar y construir claves por timestamp para deduplicación robusta
    const items = occurrences
      .map(o => ({ ...o, ts: o.scheduledAt.getTime() }))
      .sort((a, b) => a.ts - b.ts)

    const minAt = new Date(items[0].ts)
    const maxAt = new Date(items[items.length - 1].ts)

    // Pequeño buffer a ambos lados del rango para blindaje de fronteras
    const bufferedMin = new Date(minAt.getTime() - 60_000)
    const bufferedMax = new Date(maxAt.getTime() + 60_000)

    const existing = await prisma.sorteo.findMany({
      where: { loteriaId, scheduledAt: { gte: bufferedMin, lte: bufferedMax } },
      select: { id: true, scheduledAt: true },
    })
    const existingBefore = new Set(existing.map(e => e.scheduledAt.getTime()))

    const toInsert = items.filter(it => !existingBefore.has(it.ts))
    const alreadyExists = items.filter(it => existingBefore.has(it.ts))

    // Inserción masiva idempotente con respaldo de @@unique(loteriaId, scheduledAt)
    if (toInsert.length > 0) {
      logger.info({
        layer: "repository",
        action: "SORTEO_BULK_CREATE_IF_MISSING_BEFORE_INSERT",
        payload: {
          loteriaId,
          toInsertCount: toInsert.length,
          alreadyExistsCount: alreadyExists.length,
          sampleToInsert: toInsert.slice(0, 3).map(it => ({
            name: it.name,
            scheduledAt: formatIsoLocal(new Date(it.ts)),
            timestamp: it.ts,
          })),
        },
      });

      try {
        const createResult = await prisma.sorteo.createMany({
          data: toInsert.map(it => ({
            loteriaId,
            name: it.name,
            scheduledAt: new Date(it.ts),
            status: SorteoStatus.SCHEDULED,
            isActive: true,
            digits, //  Heredar digits de la lotería
          })),
          skipDuplicates: true,
        });

        logger.info({
          layer: "repository",
          action: "SORTEO_BULK_CREATE_IF_MISSING_INSERT_RESULT",
          payload: {
            loteriaId,
            createManyCount: createResult.count,
            attemptedCount: toInsert.length,
            difference: toInsert.length - createResult.count,
          },
        });
      } catch (err: any) {
        logger.error({
          layer: "repository",
          action: "SORTEO_BULK_CREATE_IF_MISSING_INSERT_ERROR",
          payload: {
            loteriaId,
            errorCode: err?.code,
            errorMessage: err?.message,
            attemptedCount: toInsert.length,
          },
        });
        // P2002 / 23505 deben tratarse como skips, no como error fatal
        if (!(err?.code === 'P2002' || String(err?.message).includes('23505'))) {
          throw err
        }
      }
    } else {
      logger.info({
        layer: "repository",
        action: "SORTEO_BULK_CREATE_IF_MISSING_NO_INSERT",
        payload: {
          loteriaId,
          reason: "No hay sorteos para insertar (todos ya existen)",
          alreadyExistsCount: alreadyExists.length,
          totalOccurrences: items.length,
        },
      });
    }

    // Verificación post-inserción para reflejar creados reales bajo concurrencia
    const existingAfter = await prisma.sorteo.findMany({
      where: { loteriaId, scheduledAt: { gte: bufferedMin, lte: bufferedMax } },
      select: { scheduledAt: true },
    })
    const afterSet = new Set(existingAfter.map(e => e.scheduledAt.getTime()))

    const createdTs = toInsert
      .map(it => it.ts)
      .filter(ts => afterSet.has(ts) && !existingBefore.has(ts))
    const skippedTs = items.map(it => it.ts).filter(ts => !createdTs.includes(ts))

    const fmt = (ts: number) => formatIsoLocal(new Date(ts))

    logger.info({
      layer: "repository",
      action: "SORTEO_BULK_CREATE_IF_MISSING_FINAL",
      payload: {
        loteriaId,
        created: createdTs.length,
        skipped: skippedTs.length,
        alreadyExists: alreadyExists.length,
        processed: items.length,
        toInsertCount: toInsert.length,
        existingBeforeCount: existingBefore.size,
        existingAfterCount: afterSet.size,
        createdTimestamps: createdTs.slice(0, 5).map(fmt), // Primeros 5 para debugging
      },
    })

    return {
      created: createdTs.map(fmt),
      skipped: skippedTs.map(fmt),
      alreadyExists: alreadyExists.map(it => fmt(it.ts)),
      processed: items.map(it => fmt(it.ts)),
    }
  },
};

export default SorteoRepository;
