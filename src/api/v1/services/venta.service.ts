// src/api/v1/services/venta.service.ts
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import { Prisma, Role } from "@prisma/client";
import logger from "../../../core/logger";
import { formatIsoLocal } from "../../../utils/datetime";
import { resolveCommission } from "../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../services/commission/commission.resolver";

const BUSINESS_TZ = "America/Costa_Rica";
const COSTA_RICA_OFFSET_HOURS = -6;

function toCostaRicaDateString(date: Date): string {
  const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  return local.toISOString().split("T")[0];
}

function combineSqlWithAnd(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) {
    return Prisma.sql`TRUE`;
  }
  let combined = parts[0];
  for (let i = 1; i < parts.length; i++) {
    combined = Prisma.sql`${combined} AND ${parts[i]}`;
  }
  return combined;
}

export interface VentasFilters {
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  winnersOnly?: boolean;
  bancaId?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  sorteoId?: string;
  multiplierId?: string;
  search?: string;
  orderBy?: string;
}

/**
 * Construye el WHERE de Prisma a partir de filtros normalizados
 * Nota: Usa deletedAt IS NULL para soft-delete, no isActive
 * Incluye todos los statuses (ACTIVE, EVALUATED, PAID, CANCELLED) excepto soft-deleted
 */
function buildWhereClause(filters: VentasFilters): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {
    deletedAt: null, // Soft-delete: solo tickets no eliminados
    isActive: true, // Solo tickets activos
    // Excluir tickets CANCELLED por defecto
    // Si se especifica filters.status, usar ese valor; si no, excluir CANCELLED
    status: filters.status
      ? (filters.status as any)
      : { not: "CANCELLED" }, // Excluir CANCELLED si no se especifica status
    // ✅ NUEVO: Solo incluir datos de sorteos EVALUATED (Global Filter)
    sorteo: {
      status: "EVALUATED",
      deletedAt: null,
    },
  };

  if (filters.dateFrom || filters.dateTo) {
    const orConditions: Prisma.TicketWhereInput[] = [];

    if (filters.dateFrom || filters.dateTo) {
      const businessCondition: Prisma.TicketWhereInput = {};
      const businessRange: Prisma.DateTimeFilter = {};

      if (filters.dateFrom) {
        const fromDateStr = toCostaRicaDateString(filters.dateFrom);
        businessRange.gte = new Date(`${fromDateStr}T00:00:00.000Z`);
      }
      if (filters.dateTo) {
        const toDateStr = toCostaRicaDateString(filters.dateTo);
        businessRange.lte = new Date(`${toDateStr}T00:00:00.000Z`);
      }

      if (Object.keys(businessRange).length > 0) {
        businessCondition.businessDate = businessRange;
        orConditions.push(businessCondition);
      }

      const createdCondition: Prisma.TicketWhereInput = {
        businessDate: null,
      };
      const createdRange: Prisma.DateTimeFilter = {};

      if (filters.dateFrom) {
        const fromDateStr = toCostaRicaDateString(filters.dateFrom);
        createdRange.gte = new Date(`${fromDateStr}T06:00:00.000Z`);
      }
      if (filters.dateTo) {
        const toDateStr = toCostaRicaDateString(filters.dateTo);
        const endBase = new Date(`${toDateStr}T06:00:00.000Z`);
        createdRange.lte = new Date(endBase.getTime() + 24 * 60 * 60 * 1000 - 1);
      }

      if (Object.keys(createdRange).length > 0) {
        createdCondition.createdAt = createdRange;
        orConditions.push(createdCondition);
      }
    }

    if (orConditions.length > 0) {
      const existingAnd = Array.isArray(where.AND)
        ? where.AND
        : where.AND
          ? [where.AND]
          : [];
      where.AND = [...existingAnd, { OR: orConditions }];
    }
  }

  // Filtro por status personalizado (si se solicita un status específico diferente)
  // NOTA: Si filters.status está definido, ya se aplicó arriba en el where inicial
  // Si no está definido, el where inicial ya excluye CANCELLED por defecto

  // Filtro por ganadores
  if (filters.winnersOnly) {
    where.isWinner = true;
  }

  // Filtros por IDs
  if (filters.bancaId) {
    where.ventana = { bancaId: filters.bancaId };
  }
  if (filters.ventanaId) {
    where.ventanaId = filters.ventanaId;
  }
  if (filters.vendedorId) {
    where.vendedorId = filters.vendedorId;
  }
  if (filters.loteriaId) {
    where.loteriaId = filters.loteriaId;
  }
  if (filters.sorteoId) {
    where.sorteoId = filters.sorteoId;
  }
  if (filters.multiplierId) {
    where.jugadas = {
      some: {
        multiplierId: filters.multiplierId,
      },
    };
  }

  // Búsqueda unificada (search)
  if (filters.search) {
    const searchTerm = filters.search.trim();
    const orConditions: Prisma.TicketWhereInput[] = [];

    // Búsqueda por número de ticket (ahora es string, soporta búsqueda exacta y contains)
    // Formato nuevo: TYYMMDD-XXXXXX-CC (ej: T250126-00000A-42)
    // También soporta números antiguos convertidos a string (ej: "12345")
    orConditions.push({
      ticketNumber: {
        contains: searchTerm,
        mode: "insensitive" as Prisma.QueryMode
      }
    });

    // Búsqueda por nombre de vendedor, ventana, lotería, sorteo
    orConditions.push(
      { vendedor: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { ventana: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { loteria: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { sorteo: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } }
    );

    where.OR = orConditions;
  }

  return where;
}

function buildRawDateConditions(filters: VentasFilters) {
  if (!filters.dateFrom && !filters.dateTo) {
    return { dateCondition: null };
  }

  const fromDateStr = filters.dateFrom ? toCostaRicaDateString(filters.dateFrom) : null;
  const toDateStr = filters.dateTo ? toCostaRicaDateString(filters.dateTo) : null;

  const businessParts: Prisma.Sql[] = [];
  const createdParts: Prisma.Sql[] = [];

  if (fromDateStr) {
    businessParts.push(Prisma.sql`t."businessDate" >= ${new Date(`${fromDateStr}T00:00:00.000Z`)}`);
    createdParts.push(Prisma.sql`t."createdAt" >= ${new Date(`${fromDateStr}T06:00:00.000Z`)}`);
  }

  if (toDateStr) {
    businessParts.push(Prisma.sql`t."businessDate" <= ${new Date(`${toDateStr}T00:00:00.000Z`)}`);
    const endBase = new Date(`${toDateStr}T06:00:00.000Z`);
    createdParts.push(Prisma.sql`t."createdAt" <= ${new Date(endBase.getTime() + 24 * 60 * 60 * 1000 - 1)}`);
  }

  const businessSql = businessParts.length ? combineSqlWithAnd(businessParts) : Prisma.sql`TRUE`;
  const createdSql = createdParts.length ? combineSqlWithAnd(createdParts) : Prisma.sql`TRUE`;

  const dateCondition = Prisma.sql`
    (
      (${businessSql})
      OR (
        t."businessDate" IS NULL AND ${createdSql}
      )
    )
  `;

  return { dateCondition };
}

/**
 * Helper para obtener condiciones de exclusión de listas
 * Resuelve el workaround del esquema (ventanaId apunta a User)
 */
async function getExclusionsWhere(filters: VentasFilters): Promise<Prisma.TicketWhereInput> {
  // Optimización: Si hay filtro de sorteo, solo buscar exclusiones para ese sorteo
  const whereExclusion: Prisma.SorteoListaExclusionWhereInput = {};
  if (filters.sorteoId) {
    whereExclusion.sorteoId = filters.sorteoId;
  }

  const exclusions = await prisma.sorteoListaExclusion.findMany({
    where: whereExclusion,
    include: {
      ventana: {
        select: { ventanaId: true } // ventana es User, obtenemos su ventanaId real
      }
    }
  });

  if (exclusions.length === 0) {
    return {};
  }

  const notConditions: Prisma.TicketWhereInput[] = exclusions
    .filter(ex => ex.ventana?.ventanaId) // Asegurar que tenemos el ID real de la ventana
    .map(ex => ({
      sorteoId: ex.sorteoId,
      ventanaId: ex.ventana!.ventanaId!, // ID real de la ventana
      ...(ex.vendedorId ? { vendedorId: ex.vendedorId } : {}) // Si es específico de vendedor
    }));

  if (notConditions.length === 0) {
    return {};
  }

  return {
    NOT: notConditions
  };
}

/**
 * VentasService
 * Expone endpoints para reportes y análisis de ventas
 */
export const VentasService = {
  /**
   * 1) Listado transaccional (detalle)
   * GET /ventas
   */
  async list(page = 1, pageSize = 10, filters: VentasFilters = {}): Promise<PaginatedResult<any>> {
    try {
      const baseWhere = buildWhereClause(filters);
      const exclusionWhere = await getExclusionsWhere(filters);

      // Combinar filtros base con exclusiones
      const where: Prisma.TicketWhereInput = {
        AND: [baseWhere, exclusionWhere]
      };

      const { skip, take } = getSkipTake(page, pageSize);

      // Determinar orderBy
      let orderBy: Prisma.TicketOrderByWithRelationInput = { createdAt: "desc" };
      if (filters.orderBy) {
        const [field, direction] = filters.orderBy.startsWith("-")
          ? [filters.orderBy.slice(1), "desc"]
          : [filters.orderBy, "asc"];

        if (["createdAt", "totalAmount", "ticketNumber"].includes(field)) {
          orderBy = { [field]: direction };
        }
      }

      const [data, total] = await prisma.$transaction([
        prisma.ticket.findMany({
          where,
          skip,
          take,
          orderBy,
          include: {
            ventana: { select: { id: true, name: true, code: true } },
            vendedor: { select: { id: true, name: true, username: true } },
            loteria: { select: { id: true, name: true } },
            sorteo: { select: { id: true, name: true, scheduledAt: true, status: true } },
            jugadas: {
              select: {
                id: true,
                type: true,
                number: true,
                amount: true,
                finalMultiplierX: true,
                payout: true,
                isWinner: true,
                multiplierId: true,
                multiplier: {
                  select: {
                    id: true,
                    name: true,
                    valueX: true,
                    kind: true,
                    isActive: true,
                  },
                },
              },
            },
          },
        }),
        prisma.ticket.count({ where }),
      ]);

      const meta = buildMeta(total, page, pageSize);

      logger.info({
        layer: "service",
        action: "VENTA_LIST",
        payload: { filters, page, pageSize, total },
      });

      return { data, meta };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "VENTA_LIST_FAIL",
        payload: { message: err.message, filters },
      });
      throw err;
    }
  },

  /**
   * 2) Resumen ejecutivo (KPI)
   * GET /ventas/summary
   */
  async summary(
    filters: VentasFilters = {},
    options?: {
      userId?: string;
      role?: string;
      scope?: string;
    }
  ): Promise<{
    ventasTotal: number;
    ticketsCount: number;
    jugadasCount: number;
    payoutTotal: number;
    neto: number;
    commissionTotal: number;
    netoDespuesComision: number;
    lastTicketAt: string | null;
    // Campos de pagos (coinciden con campos de Ticket model)
    totalPaid: number;           // Total pagado a ganadores
    remainingAmount: number;     // Pendiente de pago (antes totalPending)
    paidTicketsCount: number;    // Tickets completamente pagados
    unpaidTicketsCount: number;  // Tickets con pago pendiente
    // Campos adicionales solo para VENDEDOR con scope='mine' (opcionales)
    pendingPayment?: number;     // Total pendiente de pago en tickets EVALUATED
    // Campos adicionales solo para VENTANA con scope='mine' (opcionales)
    commissionVendedorTotal?: number;  // Suma de comisiones de todos los vendedores
    commissionListeroTotal?: number;    // Comisión propia del listero (ventana)
    gananciaNeta?: number;              // BACKWARD COMPAT: Ventas - Premios - Comisión Listero
    balanceDueToBanca?: number;         // ✅ NUEVO: Deuda a la banca (Ventas - Premios - Comisión Listero)
    myGain?: number;                    // ✅ NUEVO: Ganancia personal (Comisión Listero - Comisión Vendedor)
  }> {
    try {
      const baseWhere = buildWhereClause(filters);
      const exclusionWhere = await getExclusionsWhere(filters);

      // Combinar filtros base con exclusiones
      const where: Prisma.TicketWhereInput = {
        AND: [baseWhere, exclusionWhere]
      };

      // Agregaciones en paralelo
      const [ticketsAgg, jugadasAgg, lastTicket, paymentStats] = await prisma.$transaction([
        // Suma de totalAmount y count de tickets
        prisma.ticket.aggregate({
          where,
          _sum: { totalAmount: true },
          _count: { id: true },
        }),

        // Suma de payouts, commissionAmount y count de jugadas
        prisma.jugada.aggregate({
          where: {
            ticket: where,
          },
          _sum: { payout: true, commissionAmount: true },
          _count: { id: true },
        }),

        // Último ticket creado
        prisma.ticket.findFirst({
          where,
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),

        // Agregaciones de pagos
        prisma.ticket.aggregate({
          where,
          _sum: {
            totalPaid: true,
            remainingAmount: true,
          },
        }),
      ]);

      // Contar tickets pagados vs no pagados (solo tickets ganadores)
      const winnerWhere = { ...where, isWinner: true };
      const [paidCount, unpaidCount] = await prisma.$transaction([
        // Tickets completamente pagados (status PAID o remainingAmount = 0 con totalPaid > 0)
        prisma.ticket.count({
          where: {
            ...winnerWhere,
            OR: [
              { status: 'PAID' }, // Status PAID significa pago completo
              {
                remainingAmount: 0,
                totalPaid: { gt: 0 }
              }
            ]
          },
        }),
        // Tickets con pago pendiente (remainingAmount > 0 y no PAID)
        prisma.ticket.count({
          where: {
            ...winnerWhere,
            remainingAmount: { gt: 0 },
            status: { not: 'PAID' }
          },
        }),
      ]);

      const ventasTotal = ticketsAgg._sum.totalAmount ?? 0;
      const payoutTotal = jugadasAgg._sum.payout ?? 0;
      const commissionTotal = jugadasAgg._sum.commissionAmount ?? 0;
      const totalPaid = paymentStats._sum.totalPaid ?? 0;
      const remainingAmount = paymentStats._sum.remainingAmount ?? 0;
      const neto = ventasTotal - payoutTotal;
      const netoDespuesComision = neto - commissionTotal;

      // Calcular pendingPayment solo para VENDEDOR con scope='mine'
      // pendingPayment = suma de remainingAmount de tickets con isWinner=true y status='EVALUATED'
      let pendingPayment: number | undefined = undefined;
      if (options?.role === 'VENDEDOR' && options?.scope === 'mine' && options?.userId) {
        const evaluatedWinnerWhere = {
          ...where,
          isWinner: true,
          status: 'EVALUATED' as const,
          vendedorId: options.userId, // Asegurar que es del vendedor
        };

        const evaluatedStats = await prisma.ticket.aggregate({
          where: evaluatedWinnerWhere,
          _sum: {
            remainingAmount: true,
          },
        });

        pendingPayment = evaluatedStats._sum.remainingAmount ?? 0;
      }

      // ✅ NUEVO: Calcular comisiones separadas para VENTANA con scope='mine'
      let commissionVendedorTotal: number | undefined = undefined;
      let commissionListeroTotal: number | undefined = undefined;
      let gananciaNeta: number | undefined = undefined;
      let balanceDueToBanca: number | undefined = undefined;
      let myGain: number | undefined = undefined;

      if (options?.role === 'VENTANA' && options?.scope === 'mine' && options?.userId) {
        // Obtener ventanaId del usuario VENTANA
        const ventanaUser = await prisma.user.findUnique({
          where: { id: options.userId },
          select: { ventanaId: true },
        });

        if (ventanaUser?.ventanaId) {
          // 1. Calcular commissionVendedorTotal: Suma de comisiones de todos los vendedores
          // Las comisiones de vendedores están guardadas en jugadas.commissionAmount cuando commissionOrigin='USER'
          // Nota: commissionOrigin='USER' ya garantiza que el ticket tiene vendedorId, así que no necesitamos filtrar explícitamente
          const vendedorCommissionsAgg = await prisma.jugada.aggregate({
            where: {
              ticket: {
                ...where,
                ventanaId: ventanaUser.ventanaId,
                // ✅ No incluimos filtro vendedorId porque commissionOrigin='USER' ya garantiza que existe
              },
              commissionOrigin: 'USER', // Comisiones de vendedores (esto ya garantiza que el ticket tiene vendedorId)
            },
            _sum: {
              commissionAmount: true,
            },
          });
          // ✅ Verificar que _sum existe antes de acceder
          commissionVendedorTotal = parseFloat((vendedorCommissionsAgg._sum?.commissionAmount ?? 0).toFixed(2));

          // 2. Calcular commissionListeroTotal: Comisión propia del listero (ventana)
          // ✅ CAMBIO: Usar snapshot de comisión del listero guardado en BD, NO recalcular
          // Las comisiones están guardadas en jugada.listeroCommissionAmount (snapshot del momento de creación)
          const listeroCommissionsAgg = await prisma.jugada.aggregate({
            where: {
              ticket: {
                ...where,
                ventanaId: ventanaUser.ventanaId,
              },
            },
            _sum: {
              listeroCommissionAmount: true,
            },
          });
          // ✅ Verificar que _sum existe antes de acceder
          commissionListeroTotal = parseFloat((listeroCommissionsAgg._sum?.listeroCommissionAmount ?? 0).toFixed(2));

          // 3. Calcular balanceDueToBanca: ventasTotal - payoutTotal - commissionListeroTotal
          // ✅ NUEVO: Lo que se debe pagar a la banca
          balanceDueToBanca = parseFloat((ventasTotal - payoutTotal - commissionListeroTotal).toFixed(2));

          // 4. Calcular myGain: commissionListeroTotal - commissionVendedorTotal
          // ✅ NUEVO: Lo que gana personalmente el listero
          myGain = parseFloat((commissionListeroTotal - commissionVendedorTotal).toFixed(2));

          // BACKWARD COMPAT: gananciaNeta sigue siendo lo mismo que balanceDueToBanca
          gananciaNeta = balanceDueToBanca;
        }
      }

      logger.info({
        layer: "service",
        action: "VENTA_SUMMARY",
        payload: {
          filters,
          ventasTotal,
          ticketsCount: ticketsAgg._count.id,
          commissionTotal,
          totalPaid,
          remainingAmount,
          paidTicketsCount: paidCount,
          unpaidTicketsCount: unpaidCount,
          pendingPayment,
          isVendedorMine: options?.role === 'VENDEDOR' && options?.scope === 'mine',
        },
      });

      const result: any = {
        ventasTotal,
        ticketsCount: ticketsAgg._count.id,
        jugadasCount: jugadasAgg._count.id,
        payoutTotal,
        neto,
        commissionTotal,
        netoDespuesComision,
        lastTicketAt: lastTicket?.createdAt?.toISOString() ?? null,
        // Campos de pagos
        totalPaid,
        remainingAmount,
        paidTicketsCount: paidCount,
        unpaidTicketsCount: unpaidCount,
      };

      // Agregar campos adicionales solo para VENDEDOR con scope='mine'
      if (options?.role === 'VENDEDOR' && options?.scope === 'mine') {
        result.pendingPayment = pendingPayment;
      }

      // ✅ NUEVO: Agregar campos adicionales solo para VENTANA con scope='mine'
      if (options?.role === 'VENTANA' && options?.scope === 'mine') {
        result.commissionVendedorTotal = commissionVendedorTotal ?? 0;
        result.commissionListeroTotal = commissionListeroTotal ?? 0;
        result.gananciaNeta = gananciaNeta ?? parseFloat((ventasTotal - payoutTotal).toFixed(2));
        result.balanceDueToBanca = balanceDueToBanca ?? parseFloat((ventasTotal - payoutTotal - (commissionListeroTotal ?? 0)).toFixed(2));
        result.myGain = myGain ?? parseFloat(((commissionListeroTotal ?? 0) - (commissionVendedorTotal ?? 0)).toFixed(2));
      }

      return result;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "VENTA_SUMMARY_FAIL",
        payload: { message: err.message, filters },
      });
      throw err;
    }
  },

  /**
   * 3) Desglose por dimensión (Top-N)
   * GET /ventas/breakdown?dimension=ventana|vendedor|loteria|sorteo|numero&top=10
   */
  async breakdown(
    dimension: "ventana" | "vendedor" | "loteria" | "sorteo" | "numero",
    top = 10,
    filters: VentasFilters = {}
  ): Promise<
    Array<{
      key: string;
      name: string;
      ventasTotal: number;
      ticketsCount: number;
      payoutTotal: number;
      neto: number;
      commissionTotal: number;
      totalWinningTickets: number;
      totalPaidTickets: number;
      // Campos adicionales para vendedor (opcionales)
      winningTicketsCount?: number;
      paidTicketsCount?: number;
      unpaidTicketsCount?: number;
      totalPaid?: number;
      pendingPayment?: number;
      avgTicketAmount?: number;
      winRate?: number;
      payoutRate?: number;
      commissionAmount?: number;
      lastTicketAt?: string;
      firstTicketAt?: string;
      activityDays?: number;
      vendedorCode?: string;
      status?: 'active' | 'inactive';
      ventanaName?: string;
    }>
  > {
    try {
      if (top > 50) {
        throw new AppError("El parámetro 'top' no puede ser mayor a 50", 400, {
          code: "VAL_3001",
          details: [{ field: "top", message: "Máximo permitido: 50" }],
        });
      }

      const baseWhere = buildWhereClause(filters);
      const exclusionWhere = await getExclusionsWhere(filters);

      // Combinar filtros base con exclusiones
      const where: Prisma.TicketWhereInput = {
        AND: [baseWhere, exclusionWhere]
      };

      switch (dimension) {
        case "ventana": {
          const result = await prisma.ticket.groupBy({
            by: ["ventanaId"],
            where,
            _sum: { totalAmount: true },
            _count: { id: true },
            orderBy: { _sum: { totalAmount: "desc" } },
            take: top,
          });

          const ventanaIds = result.map((r) => r.ventanaId);
          const ventanas = await prisma.ventana.findMany({
            where: { id: { in: ventanaIds } },
            select: { id: true, name: true, code: true },
          });
          const ventanaMap = new Map(ventanas.map((v) => [v.id, v]));

          const jugadasAgg = await prisma.jugada.groupBy({
            by: ["ticketId"],
            where: { ticket: { ventanaId: { in: ventanaIds }, ...where } },
            _sum: { payout: true, commissionAmount: true },
          });
          const ticketIds = jugadasAgg.map((p) => p.ticketId);
          const tickets = await prisma.ticket.findMany({
            where: { id: { in: ticketIds } },
            select: { id: true, ventanaId: true, isWinner: true, status: true },
          });
          const payoutByVentana = new Map<string, number>();
          const commissionByVentana = new Map<string, number>();
          const winningTicketsByVentana = new Map<string, number>();
          const paidTicketsByVentana = new Map<string, number>();

          tickets.forEach((t) => {
            const jugada = jugadasAgg.find((p) => p.ticketId === t.id);
            const payout = jugada?._sum.payout ?? 0;
            const commission = jugada?._sum.commissionAmount ?? 0;
            payoutByVentana.set(t.ventanaId, (payoutByVentana.get(t.ventanaId) ?? 0) + payout);
            commissionByVentana.set(t.ventanaId, (commissionByVentana.get(t.ventanaId) ?? 0) + commission);

            // Count winning tickets
            if (t.isWinner) {
              winningTicketsByVentana.set(t.ventanaId, (winningTicketsByVentana.get(t.ventanaId) ?? 0) + 1);
            }

            // Count paid tickets
            if (t.status === 'PAID') {
              paidTicketsByVentana.set(t.ventanaId, (paidTicketsByVentana.get(t.ventanaId) ?? 0) + 1);
            }
          });

          return result.map((r) => {
            const ventana = ventanaMap.get(r.ventanaId);
            const ventasTotal = r._sum.totalAmount ?? 0;
            const payoutTotal = payoutByVentana.get(r.ventanaId) ?? 0;
            const commissionTotal = commissionByVentana.get(r.ventanaId) ?? 0;
            return {
              key: r.ventanaId,
              name: ventana?.name ?? "Desconocida",
              ventasTotal,
              ticketsCount: r._count.id,
              payoutTotal,
              neto: ventasTotal - payoutTotal,
              commissionTotal,
              totalWinningTickets: winningTicketsByVentana.get(r.ventanaId) ?? 0,
              totalPaidTickets: paidTicketsByVentana.get(r.ventanaId) ?? 0,
            };
          });
        }

        case "vendedor": {
          // DEBUG: Log filters to see if ventanaId is present
          logger.info({
            layer: "service",
            action: "BREAKDOWN_VENDEDOR_DEBUG",
            payload: {
              filters,
              whereClause: where,
              message: "Breakdown vendedor - checking filters"
            }
          });

          const result = await prisma.ticket.groupBy({
            by: ["vendedorId"],
            where,
            _sum: { totalAmount: true },
            _count: { id: true },
            orderBy: { _sum: { totalAmount: "desc" } },
            take: top,
          });

          const vendedorIds = result.map((r) => r.vendedorId);

          // DEBUG: Log vendedorIds found
          logger.info({
            layer: "service",
            action: "BREAKDOWN_VENDEDOR_RESULT",
            payload: {
              vendedorIds,
              count: vendedorIds.length,
              message: "VendedorIds after groupBy filtering"
            }
          });
          const vendedores = await prisma.user.findMany({
            where: { id: { in: vendedorIds } },
            select: {
              id: true,
              name: true,
              username: true,
              code: true,
              isActive: true,
              ventanaId: true,
              ventana: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          });
          const vendedorMap = new Map(vendedores.map((v) => [v.id, v]));

          const jugadasAgg = await prisma.jugada.groupBy({
            by: ["ticketId"],
            where: { ticket: { vendedorId: { in: vendedorIds }, ...where } },
            _sum: { payout: true, commissionAmount: true },
          });
          // Obtener todos los tickets del vendedor para cálculos adicionales
          const allTickets = await prisma.ticket.findMany({
            where: {
              vendedorId: { in: vendedorIds },
              ...where,
            },
            select: {
              id: true,
              vendedorId: true,
              isWinner: true,
              status: true,
              createdAt: true,
              businessDate: true,
              totalAmount: true,
            },
          });

          const ticketIds = jugadasAgg.map((p) => p.ticketId);
          const tickets = allTickets.filter((t) => ticketIds.includes(t.id));

          const payoutByVendedor = new Map<string, number>();
          const commissionByVendedor = new Map<string, number>();
          const winningTicketsByVendedor = new Map<string, number>();
          const paidTicketsByVendedor = new Map<string, number>();
          const unpaidTicketsByVendedor = new Map<string, number>();
          const totalPaidByVendedor = new Map<string, number>();
          const pendingPaymentByVendedor = new Map<string, number>();
          const lastTicketAtByVendedor = new Map<string, Date>();
          const firstTicketAtByVendedor = new Map<string, Date>();
          const ticketDatesByVendedor = new Map<string, Set<string>>();

          // Calcular payout total de tickets ganadores y pagos
          const winningTickets = allTickets.filter((t) => t.isWinner);
          const payoutByTicket = new Map<string, number>();
          const paidByTicket = new Map<string, number>();

          if (winningTickets.length > 0) {
            const winningTicketIds = winningTickets.map((t) => t.id);

            // Obtener payouts de jugadas ganadoras
            const winningJugadas = await prisma.jugada.findMany({
              where: {
                ticketId: { in: winningTicketIds },
                ticket: { vendedorId: { in: vendedorIds }, ...where },
              },
              select: {
                ticketId: true,
                payout: true,
              },
            });

            winningJugadas.forEach((j) => {
              const currentPayout = payoutByTicket.get(j.ticketId) ?? 0;
              payoutByTicket.set(j.ticketId, currentPayout + (j.payout ?? 0));
            });

            // Calcular pagos desde TicketPayment
            const ticketPayments = await prisma.ticketPayment.findMany({
              where: {
                ticketId: { in: winningTicketIds },
                isReversed: false,
              },
              select: {
                ticketId: true,
                amountPaid: true,
              },
            });

            ticketPayments.forEach((tp) => {
              const currentPaid = paidByTicket.get(tp.ticketId) ?? 0;
              paidByTicket.set(tp.ticketId, currentPaid + tp.amountPaid);
            });
          }

          // Calcular totalPaid y pendingPayment por vendedor
          allTickets.forEach((t) => {
            if (t.isWinner) {
              const ticketPaid = paidByTicket.get(t.id) ?? 0;
              const ticketPayout = payoutByTicket.get(t.id) ?? 0;

              totalPaidByVendedor.set(
                t.vendedorId,
                (totalPaidByVendedor.get(t.vendedorId) ?? 0) + ticketPaid
              );

              // Pending payment = payout - paid
              const pending = Math.max(0, ticketPayout - ticketPaid);
              pendingPaymentByVendedor.set(
                t.vendedorId,
                (pendingPaymentByVendedor.get(t.vendedorId) ?? 0) + pending
              );
            }
          });

          allTickets.forEach((t) => {
            const jugada = jugadasAgg.find((p) => p.ticketId === t.id);
            const payout = jugada?._sum.payout ?? 0;
            const commission = jugada?._sum.commissionAmount ?? 0;
            payoutByVendedor.set(t.vendedorId, (payoutByVendedor.get(t.vendedorId) ?? 0) + payout);
            commissionByVendedor.set(t.vendedorId, (commissionByVendedor.get(t.vendedorId) ?? 0) + commission);

            // Count winning tickets
            if (t.isWinner) {
              winningTicketsByVendedor.set(t.vendedorId, (winningTicketsByVendedor.get(t.vendedorId) ?? 0) + 1);
            }

            // Count paid tickets
            if (t.status === 'PAID') {
              paidTicketsByVendedor.set(t.vendedorId, (paidTicketsByVendedor.get(t.vendedorId) ?? 0) + 1);
            } else if (t.isWinner) {
              // Count unpaid winning tickets
              unpaidTicketsByVendedor.set(t.vendedorId, (unpaidTicketsByVendedor.get(t.vendedorId) ?? 0) + 1);
            }

            // Track ticket dates
            const ticketDate = t.businessDate || t.createdAt;
            const dateKey = new Date(ticketDate).toISOString().split('T')[0];
            if (!ticketDatesByVendedor.has(t.vendedorId)) {
              ticketDatesByVendedor.set(t.vendedorId, new Set());
            }
            ticketDatesByVendedor.get(t.vendedorId)!.add(dateKey);

            // Track last and first ticket dates
            const currentLast = lastTicketAtByVendedor.get(t.vendedorId);
            if (!currentLast || ticketDate > currentLast) {
              lastTicketAtByVendedor.set(t.vendedorId, ticketDate);
            }

            const currentFirst = firstTicketAtByVendedor.get(t.vendedorId);
            if (!currentFirst || ticketDate < currentFirst) {
              firstTicketAtByVendedor.set(t.vendedorId, ticketDate);
            }
          });


          return result.map((r) => {
            const vendedor = vendedorMap.get(r.vendedorId);
            const ventasTotal = r._sum.totalAmount ?? 0;
            const payoutTotal = payoutByVendedor.get(r.vendedorId) ?? 0;
            const commissionTotal = commissionByVendedor.get(r.vendedorId) ?? 0;
            const ticketsCount = r._count.id;
            const winningTicketsCount = winningTicketsByVendedor.get(r.vendedorId) ?? 0;
            const paidTicketsCount = paidTicketsByVendedor.get(r.vendedorId) ?? 0;
            const unpaidTicketsCount = unpaidTicketsByVendedor.get(r.vendedorId) ?? 0;
            const totalPaid = totalPaidByVendedor.get(r.vendedorId) ?? 0;
            const pendingPayment = pendingPaymentByVendedor.get(r.vendedorId) ?? 0;

            // Calcular métricas derivadas
            const avgTicketAmount = ticketsCount > 0 ? ventasTotal / ticketsCount : 0;
            const winRate = ticketsCount > 0 ? (winningTicketsCount / ticketsCount) * 100 : 0;
            const payoutRate = ventasTotal > 0 ? (payoutTotal / ventasTotal) * 100 : 0;
            const activityDays = ticketDatesByVendedor.get(r.vendedorId)?.size ?? 0;

            const lastTicketAt = lastTicketAtByVendedor.get(r.vendedorId);
            const firstTicketAt = firstTicketAtByVendedor.get(r.vendedorId);

            // Calcular neto: ventas - premios - comisión vendedor
            // Para VENTANA con scope=mine, debe restar la comisión del vendedor
            const neto = ventasTotal - payoutTotal - commissionTotal;

            return {
              key: r.vendedorId,
              name: vendedor?.name ?? "Desconocido",
              ventasTotal,
              ticketsCount,
              payoutTotal,
              neto, // ✅ CORREGIDO: ventasTotal - payoutTotal - commissionTotal
              commissionTotal,
              totalWinningTickets: winningTicketsCount,
              totalPaidTickets: paidTicketsCount,
              // Campos adicionales para vendedor
              winningTicketsCount,
              paidTicketsCount,
              unpaidTicketsCount,
              totalPaid,
              pendingPayment,
              avgTicketAmount: Math.round(avgTicketAmount * 100) / 100, // Redondear a 2 decimales
              winRate: Math.round(winRate * 100) / 100, // Redondear a 2 decimales
              payoutRate: Math.round(payoutRate * 100) / 100, // Redondear a 2 decimales
              commissionAmount: commissionTotal, // ✅ Comisión del vendedor (ya estaba presente)
              lastTicketAt: lastTicketAt ? lastTicketAt.toISOString() : undefined,
              firstTicketAt: firstTicketAt ? firstTicketAt.toISOString() : undefined,
              activityDays,
              vendedorCode: vendedor?.code ?? undefined,
              status: vendedor?.isActive ? 'active' : 'inactive' as 'active' | 'inactive',
              ventanaName: vendedor?.ventana?.name ?? undefined,
            };
          });
        }

        case "loteria": {
          const result = await prisma.ticket.groupBy({
            by: ["loteriaId"],
            where,
            _sum: { totalAmount: true },
            _count: { id: true },
            orderBy: { _sum: { totalAmount: "desc" } },
            take: top,
          });

          const loteriaIds = result.map((r) => r.loteriaId);
          const loterias = await prisma.loteria.findMany({
            where: { id: { in: loteriaIds } },
            select: { id: true, name: true },
          });
          const loteriaMap = new Map(loterias.map((l) => [l.id, l]));

          const jugadasAgg = await prisma.jugada.groupBy({
            by: ["ticketId"],
            where: { ticket: { loteriaId: { in: loteriaIds }, ...where } },
            _sum: { payout: true, commissionAmount: true },
          });
          const ticketIds = jugadasAgg.map((p) => p.ticketId);
          const tickets = await prisma.ticket.findMany({
            where: { id: { in: ticketIds } },
            select: { id: true, loteriaId: true, isWinner: true, status: true },
          });
          const payoutByLoteria = new Map<string, number>();
          const commissionByLoteria = new Map<string, number>();
          const winningTicketsByLoteria = new Map<string, number>();
          const paidTicketsByLoteria = new Map<string, number>();

          tickets.forEach((t) => {
            const jugada = jugadasAgg.find((p) => p.ticketId === t.id);
            const payout = jugada?._sum.payout ?? 0;
            const commission = jugada?._sum.commissionAmount ?? 0;
            payoutByLoteria.set(t.loteriaId, (payoutByLoteria.get(t.loteriaId) ?? 0) + payout);
            commissionByLoteria.set(t.loteriaId, (commissionByLoteria.get(t.loteriaId) ?? 0) + commission);

            // Count winning tickets
            if (t.isWinner) {
              winningTicketsByLoteria.set(t.loteriaId, (winningTicketsByLoteria.get(t.loteriaId) ?? 0) + 1);
            }

            // Count paid tickets
            if (t.status === 'PAID') {
              paidTicketsByLoteria.set(t.loteriaId, (paidTicketsByLoteria.get(t.loteriaId) ?? 0) + 1);
            }
          });

          return result.map((r) => {
            const loteria = loteriaMap.get(r.loteriaId);
            const ventasTotal = r._sum.totalAmount ?? 0;
            const payoutTotal = payoutByLoteria.get(r.loteriaId) ?? 0;
            const commissionTotal = commissionByLoteria.get(r.loteriaId) ?? 0;
            return {
              key: r.loteriaId,
              name: loteria?.name ?? "Desconocida",
              ventasTotal,
              ticketsCount: r._count.id,
              payoutTotal,
              neto: ventasTotal - payoutTotal,
              commissionTotal,
              totalWinningTickets: winningTicketsByLoteria.get(r.loteriaId) ?? 0,
              totalPaidTickets: paidTicketsByLoteria.get(r.loteriaId) ?? 0,
            };
          });
        }

        case "sorteo": {
          const result = await prisma.ticket.groupBy({
            by: ["sorteoId"],
            where,
            _sum: { totalAmount: true },
            _count: { id: true },
            orderBy: { _sum: { totalAmount: "desc" } },
            take: top,
          });

          const sorteoIds = result.map((r) => r.sorteoId);
          const sorteos = await prisma.sorteo.findMany({
            where: { id: { in: sorteoIds }, status: 'EVALUATED' },
            select: { id: true, name: true, scheduledAt: true },
          });
          const sorteoMap = new Map(sorteos.map((s) => [s.id, s]));

          const jugadasAgg = await prisma.jugada.groupBy({
            by: ["ticketId"],
            where: { ticket: { sorteoId: { in: sorteoIds }, ...where } },
            _sum: { payout: true, commissionAmount: true },
          });
          const ticketIds = jugadasAgg.map((p) => p.ticketId);
          const tickets = await prisma.ticket.findMany({
            where: { id: { in: ticketIds } },
            select: { id: true, sorteoId: true, isWinner: true, status: true },
          });
          const payoutBySorteo = new Map<string, number>();
          const commissionBySorteo = new Map<string, number>();
          const winningTicketsBySorteo = new Map<string, number>();
          const paidTicketsBySorteo = new Map<string, number>();

          tickets.forEach((t) => {
            const jugada = jugadasAgg.find((p) => p.ticketId === t.id);
            const payout = jugada?._sum.payout ?? 0;
            const commission = jugada?._sum.commissionAmount ?? 0;
            payoutBySorteo.set(t.sorteoId, (payoutBySorteo.get(t.sorteoId) ?? 0) + payout);
            commissionBySorteo.set(t.sorteoId, (commissionBySorteo.get(t.sorteoId) ?? 0) + commission);

            // Count winning tickets
            if (t.isWinner) {
              winningTicketsBySorteo.set(t.sorteoId, (winningTicketsBySorteo.get(t.sorteoId) ?? 0) + 1);
            }

            // Count paid tickets
            if (t.status === 'PAID') {
              paidTicketsBySorteo.set(t.sorteoId, (paidTicketsBySorteo.get(t.sorteoId) ?? 0) + 1);
            }
          });

          return result.map((r) => {
            const sorteo = sorteoMap.get(r.sorteoId);
            const ventasTotal = r._sum.totalAmount ?? 0;
            const payoutTotal = payoutBySorteo.get(r.sorteoId) ?? 0;
            const commissionTotal = commissionBySorteo.get(r.sorteoId) ?? 0;
            return {
              key: r.sorteoId,
              name: sorteo?.name ?? "Desconocido",
              ventasTotal,
              ticketsCount: r._count.id,
              payoutTotal,
              neto: ventasTotal - payoutTotal,
              commissionTotal,
              totalWinningTickets: winningTicketsBySorteo.get(r.sorteoId) ?? 0,
              totalPaidTickets: paidTicketsBySorteo.get(r.sorteoId) ?? 0,
            };
          });
        }

        case "numero": {
          const result = await prisma.jugada.groupBy({
            by: ["number"],
            where: { ticket: where },
            _sum: { amount: true, payout: true, commissionAmount: true },
            _count: { id: true },
            orderBy: { _sum: { amount: "desc" } },
            take: top,
          });

          // Get all jugadas for these numbers to count winning and paid tickets
          const numeros = result.map((r) => r.number);
          const jugadas = await prisma.jugada.findMany({
            where: { number: { in: numeros }, ticket: where },
            select: { number: true, ticket: { select: { id: true, isWinner: true, status: true } } },
          });

          const winningTicketsByNumero = new Map<string, Set<string>>();
          const paidTicketsByNumero = new Map<string, Set<string>>();

          jugadas.forEach((j) => {
            if (!winningTicketsByNumero.has(j.number)) {
              winningTicketsByNumero.set(j.number, new Set());
            }
            if (!paidTicketsByNumero.has(j.number)) {
              paidTicketsByNumero.set(j.number, new Set());
            }

            if (j.ticket.isWinner) {
              winningTicketsByNumero.get(j.number)!.add(j.ticket.id);
            }
            if (j.ticket.status === 'PAID') {
              paidTicketsByNumero.get(j.number)!.add(j.ticket.id);
            }
          });

          return result.map((r) => {
            const ventasTotal = r._sum.amount ?? 0;
            const payoutTotal = r._sum.payout ?? 0;
            const commissionTotal = r._sum.commissionAmount ?? 0;
            return {
              key: r.number,
              name: `Número ${r.number}`,
              ventasTotal,
              ticketsCount: r._count.id,
              payoutTotal,
              neto: ventasTotal - payoutTotal,
              commissionTotal,
              totalWinningTickets: winningTicketsByNumero.get(r.number)?.size ?? 0,
              totalPaidTickets: paidTicketsByNumero.get(r.number)?.size ?? 0,
            };
          });
        }

        default:
          throw new AppError("Dimensión no soportada", 400, {
            code: "SLS_2002",
            details: [{ field: "dimension", message: "Dimensión inválida" }],
          });
      }
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "VENTA_BREAKDOWN_FAIL",
        payload: { message: err.message, dimension, filters },
      });
      throw err;
    }
  },

  /**
   * 4) Serie de tiempo (timeseries)
   * GET /ventas/timeseries?granularity=hour|day|week
   */
  async timeseries(
    granularity: "hour" | "day" | "week" = "day",
    filters: VentasFilters = {}
  ): Promise<
    Array<{
      ts: string;
      ventasTotal: number;
      ticketsCount: number;
      commissionTotal: number;
    }>
  > {
    try {
      const truncKeyword = Prisma.raw(
        `'${granularity === "hour" ? "hour" : granularity === "week" ? "week" : "day"}'`
      );
      const { dateCondition } = buildRawDateConditions(filters);

      const whereSqlParts: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" != 'CANCELLED'`,
        Prisma.sql`EXISTS (
          SELECT 1 FROM "Sorteo" s
          WHERE s.id = t."sorteoId"
          AND s.status = 'EVALUATED'
        )`
      ];

      if (dateCondition) {
        whereSqlParts.push(dateCondition);
      }
      if (filters.status) {
        whereSqlParts.push(Prisma.sql`t."status" = ${filters.status}`);
      }
      if (filters.ventanaId) {
        whereSqlParts.push(
          Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`
        );
      }
      if (filters.vendedorId) {
        whereSqlParts.push(
          Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`
        );
      }
      if (filters.loteriaId) {
        whereSqlParts.push(
          Prisma.sql`t."loteriaId" = CAST(${filters.loteriaId} AS uuid)`
        );
      }
      if (filters.sorteoId) {
        whereSqlParts.push(
          Prisma.sql`t."sorteoId" = CAST(${filters.sorteoId} AS uuid)`
        );
      }

      let combinedWhere = whereSqlParts[0];
      for (let i = 1; i < whereSqlParts.length; i++) {
        combinedWhere = Prisma.sql`${combinedWhere} AND ${whereSqlParts[i]}`;
      }

      const result = await prisma.$queryRaw<
        Array<{
          ts: Date;
          ventasTotal: string;
          ticketsCount: string;
          commissionTotal: string;
        }>
      >(
        Prisma.sql`
        SELECT
          DATE_TRUNC(${truncKeyword}, COALESCE(
            t."businessDate",
            (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${BUSINESS_TZ})
          )) as ts,
          SUM(t."totalAmount")::text as "ventasTotal",
          COUNT(DISTINCT t.id)::text as "ticketsCount",
          COALESCE(SUM(t."totalCommission"), 0)::text as "commissionTotal"
        FROM "Ticket" t
        WHERE ${combinedWhere}
        GROUP BY ts
        ORDER BY ts DESC
      `
      );

      logger.info({
        layer: "service",
        action: "VENTA_TIMESERIES",
        payload: { granularity, filters, resultCount: result.length },
      });

      return result.map((r) => ({
        ts: r.ts.toISOString(),
        ventasTotal: parseFloat(r.ventasTotal),
        ticketsCount: parseInt(r.ticketsCount, 10),
        commissionTotal: parseFloat(r.commissionTotal),
      }));
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "VENTA_TIMESERIES_FAIL",
        payload: { message: err.message, granularity, filters },
      });
      throw err;
    }
  },

  /**
   * 5) Facets - Valores válidos para filtros dinámicos
   * GET /ventas/facets
   */
  async facets(filters: VentasFilters = {}): Promise<{
    ventanas: Array<{ id: string; name: string; code: string }>;
    vendedores: Array<{ id: string; name: string; username: string }>;
    loterias: Array<{ id: string; name: string }>;
    sorteos: Array<{ id: string; name: string; scheduledAt: string }>;
  }> {
    try {
      const where = buildWhereClause(filters);

      // Obtener IDs únicos de las entidades relacionadas
      const [ventanaIds, vendedorIds, loteriaIds, sorteoIds] = await Promise.all([
        prisma.ticket
          .findMany({
            where,
            select: { ventanaId: true },
            distinct: ["ventanaId"],
          })
          .then((r) => r.map((t) => t.ventanaId)),

        prisma.ticket
          .findMany({
            where,
            select: { vendedorId: true },
            distinct: ["vendedorId"],
          })
          .then((r) => r.map((t) => t.vendedorId)),

        prisma.ticket
          .findMany({
            where,
            select: { loteriaId: true },
            distinct: ["loteriaId"],
          })
          .then((r) => r.map((t) => t.loteriaId)),

        prisma.ticket
          .findMany({
            where,
            select: { sorteoId: true },
            distinct: ["sorteoId"],
          })
          .then((r) => r.map((t) => t.sorteoId)),
      ]);

      // Obtener detalles de cada entidad en paralelo
      const [ventanas, vendedores, loterias, sorteos] = await Promise.all([
        prisma.ventana.findMany({
          where: { id: { in: ventanaIds }, isActive: true },
          select: { id: true, name: true, code: true },
          orderBy: { name: "asc" },
        }),

        prisma.user.findMany({
          where: { id: { in: vendedorIds }, isActive: true },
          select: { id: true, name: true, username: true },
          orderBy: { name: "asc" },
        }),

        prisma.loteria.findMany({
          where: { id: { in: loteriaIds }, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),

        prisma.sorteo.findMany({
          where: { id: { in: sorteoIds }, status: 'EVALUATED' },
          select: { id: true, name: true, scheduledAt: true },
          orderBy: { scheduledAt: "desc" },
          take: 50, // Limitar sorteos a los últimos 50
        }),
      ]);

      logger.info({
        layer: "service",
        action: "VENTA_FACETS",
        payload: { filters, counts: { ventanas: ventanas.length, vendedores: vendedores.length } },
      });

      return {
        ventanas,
        vendedores,
        loterias,
        sorteos: sorteos.map((s) => ({
          ...s,
          scheduledAt: formatIsoLocal(s.scheduledAt),
        })),
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "VENTA_FACETS_FAIL",
        payload: { message: err.message, filters },
      });
      throw err;
    }
  },
};

export default VentasService;
