// src/repositories/sorteo.repository.ts
import prisma from "../core/prismaClient";
import logger from "../core/logger";
import { AppError } from "../core/errors";
import { Prisma, SorteoStatus, TicketStatus } from "@prisma/client";
import { CreateSorteoDTO, UpdateSorteoDTO } from "../api/v1/dto/sorteo.dto";
import { formatIsoLocal, parseCostaRicaDateTime } from "../utils/datetime";

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
    d.scheduledAt instanceof Date
      ? new Date(d.scheduledAt.getTime())
      : parseCostaRicaDateTime(d.scheduledAt),
  loteria: { connect: { id: d.loteriaId } },
  // extraOutcomeCode, extraMultiplierId/X se quedan nulos al crear
});

const toPrismaUpdate = (d: UpdateSorteoDTO): Prisma.SorteoUpdateInput => ({
  // ✅ ÚNICAMENTE se permite reprogramar la fecha/hora (más name/isActive si lo quieres)
  scheduledAt: d.scheduledAt
    ? d.scheduledAt instanceof Date
      ? new Date(d.scheduledAt.getTime())
      : parseCostaRicaDateTime(d.scheduledAt)
    : undefined,
  name: d.name ?? undefined,
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
      action: "SORTEO_FORCE_OPEN_DB",
      payload: { sorteoId: id, previousStatus: current.status },
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

      const paymentsDeleted = await tx.ticketPayment.deleteMany({
        where: { ticket: { sorteoId: id } },
      });

      await tx.jugada.updateMany({
        where: { ticket: { sorteoId: id } },
        data: {
          isWinner: false,
          payout: 0,
        },
      });

      await tx.jugada.updateMany({
        where: {
          ticket: { sorteoId: id },
          type: "REVENTADO",
        },
        data: {
          finalMultiplierX: 0,
          multiplierId: null,
        },
      });

      await tx.ticket.updateMany({
        where: {
          sorteoId: id,
          status: TicketStatus.EVALUATED,
        },
        data: {
          status: TicketStatus.ACTIVE,
          isWinner: false,
          totalPayout: 0,
          totalPaid: 0,
          remainingAmount: 0,
          lastPaymentAt: null,
          paidById: null,
          paymentMethod: null,
          paymentNotes: null,
          paymentHistory: Prisma.JsonNull,
        },
      });

      await tx.ticket.updateMany({
        where: {
          sorteoId: id,
          status: TicketStatus.PAID,
        },
        data: {
          status: TicketStatus.ACTIVE,
          isWinner: false,
          totalPayout: 0,
          totalPaid: 0,
          remainingAmount: 0,
          lastPaymentAt: null,
          paidById: null,
          paymentMethod: null,
          paymentNotes: null,
          paymentHistory: Prisma.JsonNull,
        },
      });

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

      const statementIds: Array<{ id: string; balance: number }> = [];

      if (ventanaTargets.size > 0) {
        const ventanaStatements = await tx.accountStatement.findMany({
          where: {
            OR: Array.from(ventanaTargets.values()).map(({ ventanaId, date }) => ({
              date,
              ventanaId,
              vendedorId: null,
            })),
          },
          select: { id: true, balance: true },
        });
        statementIds.push(...ventanaStatements);
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
          select: { id: true, balance: true },
        });
        statementIds.push(...vendedorStatements);
      }

      let accountPaymentsDeleted = 0;
      if (statementIds.length > 0) {
        const ids = statementIds.map((s) => s.id);
        const res = await tx.accountPayment.deleteMany({
          where: {
            accountStatementId: { in: ids },
          },
        });
        accountPaymentsDeleted = res.count;

        await Promise.all(
          statementIds.map((stmt) =>
            tx.accountStatement.update({
              where: { id: stmt.id },
              data: {
                totalPaid: 0,
                remainingBalance: stmt.balance,
                isSettled: false,
                canEdit: true,
              },
            })
          )
        );
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
          paymentsDeleted: paymentsDeleted.count,
          accountPaymentsDeleted,
        },
      });

      return updated;
    });

    return sorteo;
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

      const hasWinner = winningTicketIds.size > 0

      // Primero: todos los tickets del sorteo -> evaluados y no-ganadores
      await tx.ticket.updateMany({
        where: { sorteoId: id },
        data: { status: 'EVALUATED', isWinner: false },
      })

      // Luego: solo los ganadores -> isWinner = true
      if (hasWinner) {
        await tx.ticket.updateMany({
          where: { id: { in: Array.from(winningTicketIds) } },
          data: { isWinner: true },
        })
      }

      // 3.5) Actualizar sorteo con hasWinner
      await tx.sorteo.update({
        where: { id },
        data: { hasWinner },
      })

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
          hasWinner,
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
  }) {
    const { loteriaId, page, pageSize, status, search, isActive, dateFrom, dateTo } = params;

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
      // 🔑 Filtro de fecha: si se proporciona, usarlo; si no, sin restricción de fecha
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

    // Optimización: Usar Promise.all en lugar de $transaction para mejor performance
    // (no necesitamos transacción para queries de solo lectura)
    const [data, total] = await Promise.all([
      prisma.sorteo.findMany({
        where,
        skip,
        take: pageSize,
        // 🔑 Orden cronológico descendente (más recientes primero)
        orderBy: [
          { scheduledAt: 'desc' },
          { createdAt: 'desc' }, // desempate estable
        ],
        select: {
          id: true,
          loteriaId: true,
          scheduledAt: true,
          status: true,
          winningNumber: true,
          hasWinner: true,
          isActive: true,
          deletedAt: true,
          deletedBy: true,
          deletedReason: true,
          createdAt: true,
          updatedAt: true,
          name: true,
          extraMultiplierId: true,
          extraMultiplierX: true,
          extraOutcomeCode: true,
          deletedByCascade: true,
          deletedByCascadeFrom: true,
          deletedByCascadeId: true,
          loteria: { select: { id: true, name: true, rulesJson: true } },
          extraMultiplier: { select: { id: true, name: true, valueX: true } },
        },
      }),
      prisma.sorteo.count({ where }),
    ]);

    return { data, total };
  },

  async softDelete(id: string, userId: string, reason?: string, byCascade = false, cascadeFrom?: string, cascadeId?: string) {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);

    const s = await prisma.sorteo.update({
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

    logger.warn({
      layer: "repository",
      action: "SORTEO_SOFT_DELETE_DB",
      payload: { 
        sorteoId: id, 
        reason,
        byCascade,
        cascadeFrom,
        cascadeId,
      },
    });
    return s;
  },

  /**
   * Restaura un sorteo (soft delete revert)
   * Limpia los campos de cascada para indicar que fue restaurado manualmente
   */
  async restore(id: string): Promise<any> {
    const existing = await prisma.sorteo.findUnique({ where: { id } });
    if (!existing) throw new AppError("Sorteo no encontrado", 404);
    if (!existing.deletedAt) {
      throw new AppError("Sorteo no está inactivo", 400);
    }

    const s = await prisma.sorteo.update({
      where: { id },
      data: {
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        isActive: true,
        // Limpiar campos de cascada (restauración manual)
        deletedByCascade: false,
        deletedByCascadeFrom: null,
        deletedByCascadeId: null,
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
      action: "SORTEO_RESTORE_DB",
      payload: { sorteoId: id },
    });
    return s;
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
