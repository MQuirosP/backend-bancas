// src/repositories/sorteo.repository.ts
import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, SorteoStatus } from "@prisma/client";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../api/v1/dto/sorteo.dto";

// ⬇️ helper para validar y obtener X del multiplier extra
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
  scheduledAt:
    d.scheduledAt instanceof Date ? d.scheduledAt : new Date(d.scheduledAt),
  loteria: { connect: { id: d.loteriaId } },
  // extraOutcomeCode, extraMultiplierId/X se quedan nulos al crear
});

const toPrismaUpdate = (d: UpdateSorteoDTO): Prisma.SorteoUpdateInput => ({
  // ✅ ÚNICAMENTE se permite reprogramar la fecha/hora (más name/isActive si lo quieres)
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? d.scheduledAt
      : new Date(d.scheduledAt)
    : undefined,
  name: d.name ?? undefined,
  ...(d.loteriaId ? { loteria: { connect: { id: d.loteriaId } } } : {}),
  ...(typeof d.isActive === "boolean" ? { isActive: d.isActive } : {}),
  // No se permite tocar status/winning/extraOutcome/extraMultiplier aquí
});

const SorteoRepository = {
  async create(data: CreateSorteoDTO) {
    const s = await prisma.sorteo.create({ data: toPrismaCreate(data) });
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
    });
    logger.info({
      layer: "repository",
      action: "SORTEO_OPEN_DB",
      payload: { sorteoId: id },
    });
    return s;
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
      });
      await tx.ticket.updateMany({
        where: { sorteoId: id },
        data: { isActive: false },
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

  // ⬇️ evaluate ahora paga jugadas y asigna multiplierId a REVENTADO ganadores
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

      // 3.2) Ganadores por NUMERO
      const numeroWinners = await tx.jugada.findMany({
        where: {
          ticket: { sorteoId: id },
          type: 'NUMERO',
          number: winningNumber,
          isActive: true,
        },
        select: { id: true, amount: true, finalMultiplierX: true, ticketId: true },
      })

      for (const j of numeroWinners) {
        const fx = typeof j.finalMultiplierX === 'number' && j.finalMultiplierX > 0 ? j.finalMultiplierX : 0
        const payout = j.amount * fx
        await tx.jugada.update({
          where: { id: j.id },
          data: { isWinner: true, payout },
        })
      }

      // 3.3) Ganadores por REVENTADO (solo si hay X > 0)
      let reventadoWinners: { id: string; amount: number; ticketId: string }[] = []

      if (extraX != null && extraX > 0) {
        reventadoWinners = await tx.jugada.findMany({
          where: {
            ticket: { sorteoId: id },
            type: 'REVENTADO',
            reventadoNumber: winningNumber,
            isActive: true,
          },
          select: { id: true, amount: true, ticketId: true },
        })

        if (reventadoWinners.length > 0 && !extraMultiplierId) {
          throw new AppError(
            'Hay jugadas REVENTADO ganadoras: falta extraMultiplierId para asignar multiplierId',
            400
          )
        }

        for (const j of reventadoWinners) {
          const payout = j.amount * (extraX as number)
          await tx.jugada.update({
            where: { id: j.id },
            data: {
              isWinner: true,
              finalMultiplierX: extraX as number, // snapshot del X extra
              payout,
              ...(extraMultiplierId ? { multiplier: { connect: { id: extraMultiplierId } } } : {}),
            },
          })
        }
      }

      // 3.4) Marcar tickets evaluados, inactivos y winners
      const winningTicketIds = new Set<string>([
        ...numeroWinners.map((j) => j.ticketId),
        ...reventadoWinners.map((j) => j.ticketId),
      ])

      // Primero: todos los tickets del sorteo -> evaluados, inactivos y no-ganadores
      await tx.ticket.updateMany({
        where: { sorteoId: id },
        data: { status: 'EVALUATED', isActive: false, isWinner: false },
      })

      // Luego: solo los ganadores -> isWinner = true
      if (winningTicketIds.size > 0) {
        await tx.ticket.updateMany({
          where: { id: { in: Array.from(winningTicketIds) } },
          data: { isWinner: true },
        })
      }

      // Log útil
      logger.info({
        layer: 'repository',
        action: 'SORTEO_EVALUATE_DB',
        payload: {
          sorteoId: id,
          winningNumber,
          extraMultiplierId,
          extraMultiplierX: extraX,
          winners: winningTicketIds.size,
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
  }) {
    const { loteriaId, page, pageSize, status, search, isActive } = params;

    // 👉 “Hoy” en la zona horaria del servidor. Si guardas UTC y quieres “hoy UTC”:
    // const now = new Date(); const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 00:00:00 local

    const where: Prisma.SorteoWhereInput = {
      ...(loteriaId ? { loteriaId } : {}),
      ...(status ? { status } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      // 🔑 FUTURO: de hoy (inclusive) hacia adelante
      scheduledAt: { gte: startOfToday },
    };

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

    const [data, total] = await prisma.$transaction([
      prisma.sorteo.findMany({
        where,
        skip,
        take: pageSize,
        // 🔑 Orden cronológico hacia el futuro
        orderBy: [
          { scheduledAt: 'asc' },
          { createdAt: 'asc' }, // desempate estable
        ],
        include: {
          loteria: { select: { id: true, name: true } },
          extraMultiplier: { select: { id: true, name: true, valueX: true } },
        },
      }),
      prisma.sorteo.count({ where }),
    ]);

    return { data, total };
  },

  async softDelete(id: string, userId: string, reason?: string) {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        isActive: false,
        // campos de borrado lógico deprecated: no se usan
      },
    });

    logger.warn({
      layer: "repository",
      action: "SORTEO_SOFT_DELETE_DB",
      payload: { sorteoId: id, reason },
    });
    return s;
  },

  async bulkCreateIfMissing(loteriaId: string, occurrences: Array<{ scheduledAt: Date; name: string }>) {
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
      try {
        await prisma.sorteo.createMany({
          data: toInsert.map(it => ({
            loteriaId,
            name: it.name,
            scheduledAt: new Date(it.ts),
            status: SorteoStatus.SCHEDULED,
            isActive: true,
          })),
          skipDuplicates: true,
        })
      } catch (err: any) {
        // P2002 / 23505 deben tratarse como skips, no como error fatal
        if (!(err?.code === 'P2002' || String(err?.message).includes('23505'))) {
          throw err
        }
      }
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

    const fmt = (ts: number) => new Date(ts).toISOString()

    logger.info({
      layer: "repository",
      action: "SORTEO_BULK_CREATE_IF_MISSING",
      payload: {
        loteriaId,
        created: createdTs.length,
        skipped: skippedTs.length,
        processed: items.length,
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
