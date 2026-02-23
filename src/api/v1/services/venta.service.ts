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
  lastId?: string;
  lastCreatedAt?: Date;
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
    //  NUEVO: Solo incluir datos de sorteos EVALUATED (Global Filter)
    sorteo: {
      status: "EVALUATED",
      deletedAt: null,
    },
  };

  if (filters.dateFrom || filters.dateTo) {
    where.businessDate = {
      ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
      ...(filters.dateTo ? { lte: filters.dateTo } : {}),
    };
  }

  // Keyset pagination
  if (filters.lastId && filters.lastCreatedAt) {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [
      ...existingAnd,
      {
        OR: [
          { createdAt: { lt: filters.lastCreatedAt } },
          { AND: [{ createdAt: filters.lastCreatedAt }, { id: { lt: filters.lastId } }] }
        ]
      }
    ];
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

  if (fromDateStr) {
    businessParts.push(Prisma.sql`t."businessDate" >= ${new Date(`${fromDateStr}T00:00:00.000Z`)}::date`);
  }

  if (toDateStr) {
    businessParts.push(Prisma.sql`t."businessDate" <= ${new Date(`${toDateStr}T00:00:00.000Z`)}::date`);
  }

  const dateCondition = businessParts.length ? combineSqlWithAnd(businessParts) : Prisma.sql`TRUE`;

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
    select: {
      sorteoId: true,
      ventanaId: true,
      vendedorId: true,
      multiplierId: true,
    }
  });

  if (exclusions.length === 0) {
    return {};
  }

  const notConditions: Prisma.TicketWhereInput[] = exclusions
    .map(ex => {
      const condition: Prisma.TicketWhereInput = {
        sorteoId: ex.sorteoId,
        ventanaId: ex.ventanaId,
        ...(ex.vendedorId ? { vendedorId: ex.vendedorId } : {}) // Si es específico de vendedor
      };

      //  NUEVO: Si la exclusión tiene multiplierId, filtrar tickets que contengan jugadas con ese multiplicador
      if (ex.multiplierId) {
        condition.jugadas = {
          some: {
            multiplierId: ex.multiplierId,
            deletedAt: null,
          }
        };
      }

      return condition;
    });

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

      // Aplicar keyset pagination si lastId está presente
      if (filters.lastId) {
        const direction = filters.orderBy?.startsWith("-") ? "desc" : "asc";
        const op = direction === "desc" ? "lt" : "gt";

        if (filters.lastCreatedAt) {
          where.OR = [
            { createdAt: { [op]: new Date(filters.lastCreatedAt) } },
            {
              AND: [
                { createdAt: new Date(filters.lastCreatedAt) },
                { id: { [op]: filters.lastId } }
              ]
            }
          ];
        } else {
          where.id = { [op]: filters.lastId };
        }
      }

      const { skip, take } = filters.lastId ? { skip: undefined, take: pageSize } : getSkipTake(page, pageSize);

      // Determinar orderBy
      let orderBy: any = [{ createdAt: "desc" }, { id: "desc" }];
      if (filters.orderBy) {
        const [field, direction] = filters.orderBy.startsWith("-")
          ? [filters.orderBy.slice(1), "desc"]
          : [filters.orderBy, "asc"];

        if (["createdAt", "totalAmount", "ticketNumber"].includes(field)) {
          orderBy = [{ [field]: direction }, { id: direction }];
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
    balanceDueToBanca?: number;         //  NUEVO: Deuda a la banca (Ventas - Premios - Comisión Listero)
    myGain?: number;                    //  NUEVO: Ganancia personal (Comisión Listero - Comisión Vendedor)
  }> {
    try {
      //  FAST PATH: Usar AccountStatement si es consulta de una ventana con fecha
      if (filters.ventanaId && filters.dateFrom) {
        const crDate = toCostaRicaDateString(filters.dateFrom);
        const statement = await prisma.accountStatement.findFirst({
          where: {
            date: new Date(crDate + 'T00:00:00.000Z'),
            ventanaId: filters.ventanaId,
            vendedorId: null, // Statement consolidado de ventana
          },
          select: {
            totalSales: true,
            totalPayouts: true,
            ticketCount: true,
            listeroCommission: true,
            vendedorCommission: true,
          },
        });

        if (statement) {
          const ventasTotal = Number(statement.totalSales);
          const payoutTotal = Number(statement.totalPayouts);
          const ticketsCount = statement.ticketCount;
          const commissionListeroTotal = Number(statement.listeroCommission);
          const commissionVendedorTotal = Number(statement.vendedorCommission);
          const commissionTotal = commissionListeroTotal + commissionVendedorTotal;
          const neto = ventasTotal - payoutTotal;
          const netoDespuesComision = neto - commissionTotal;

          // Queries ligeras a Ticket (sin JOIN a Jugada) para pagos de premios
          const ticketWhere: Prisma.TicketWhereInput = {
            ventanaId: filters.ventanaId,
            businessDate: { gte: filters.dateFrom, ...(filters.dateTo ? { lte: filters.dateTo } : {}) },
            deletedAt: null,
            isActive: true,
            status: { not: 'CANCELLED' },
            sorteo: { status: 'EVALUATED', deletedAt: null },
          };
          const winnerWhere = { ...ticketWhere, isWinner: true };

          const [paymentStats, paidCount, unpaidCount] = await prisma.$transaction([
            prisma.ticket.aggregate({
              where: ticketWhere,
              _sum: { totalPaid: true, remainingAmount: true },
            }),
            prisma.ticket.count({
              where: {
                ...winnerWhere,
                OR: [
                  { status: 'PAID' },
                  { remainingAmount: 0, totalPaid: { gt: 0 } },
                ],
              },
            }),
            prisma.ticket.count({
              where: { ...winnerWhere, remainingAmount: { gt: 0 }, status: { not: 'PAID' } },
            }),
          ]);

          const totalPaid = paymentStats._sum.totalPaid ?? 0;
          const remainingAmount = paymentStats._sum.remainingAmount ?? 0;
          const balanceDueToBanca = parseFloat((ventasTotal - payoutTotal - commissionListeroTotal).toFixed(2));
          const myGain = parseFloat((commissionListeroTotal - commissionVendedorTotal).toFixed(2));

          const result: any = {
            ventasTotal,
            ticketsCount,
            jugadasCount: 0,
            payoutTotal,
            neto,
            commissionTotal,
            netoDespuesComision,
            lastTicketAt: null,
            totalPaid,
            remainingAmount,
            paidTicketsCount: paidCount,
            unpaidTicketsCount: unpaidCount,
          };

          if (options?.role === 'VENTANA' && options?.scope === 'mine') {
            result.commissionVendedorTotal = commissionVendedorTotal;
            result.commissionListeroTotal = commissionListeroTotal;
            result.gananciaNeta = balanceDueToBanca;
            result.balanceDueToBanca = balanceDueToBanca;
            result.myGain = myGain;
          }

          return result;
        }
      }

      // FALLBACK: Cálculo completo (ventanas nuevas sin AccountStatement)
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

      //  NUEVO: Calcular comisiones separadas para VENTANA con scope='mine'
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
                //  No incluimos filtro vendedorId porque commissionOrigin='USER' ya garantiza que existe
              },
              commissionOrigin: 'USER', // Comisiones de vendedores (esto ya garantiza que el ticket tiene vendedorId)
            },
            _sum: {
              commissionAmount: true,
            },
          });
          //  Verificar que _sum existe antes de acceder
          commissionVendedorTotal = parseFloat((vendedorCommissionsAgg._sum?.commissionAmount ?? 0).toFixed(2));

          // 2. Calcular commissionListeroTotal: Comisión propia del listero (ventana)
          //  CAMBIO: Usar snapshot de comisión del listero guardado en BD, NO recalcular
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
          //  Verificar que _sum existe antes de acceder
          commissionListeroTotal = parseFloat((listeroCommissionsAgg._sum?.listeroCommissionAmount ?? 0).toFixed(2));

          // 3. Calcular balanceDueToBanca: ventasTotal - payoutTotal - commissionListeroTotal
          //  NUEVO: Lo que se debe pagar a la banca
          balanceDueToBanca = parseFloat((ventasTotal - payoutTotal - commissionListeroTotal).toFixed(2));

          // 4. Calcular myGain: commissionListeroTotal - commissionVendedorTotal
          //  NUEVO: Lo que gana personalmente el listero
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

      //  NUEVO: Agregar campos adicionales solo para VENTANA con scope='mine'
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
          // OPTIMIZACIÓN: Single raw SQL query for all metrics
          // Evita N queries y loops en JS
          const { dateCondition } = buildRawDateConditions(filters);
          
          const rawResult = await prisma.$queryRawUnsafe<any[]>(`
            WITH filtered_tickets AS (
              SELECT t.id, t."ventanaId", t."totalAmount", t."isWinner", t.status
              FROM "Ticket" t
              INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
              WHERE t."deletedAt" IS NULL 
                AND t."isActive" = true
                AND s.status = 'EVALUATED'
                AND t.status != 'CANCELLED'
                ${filters.bancaId ? `AND EXISTS (SELECT 1 FROM "Ventana" v_sub WHERE v_sub.id = t."ventanaId" AND v_sub."bancaId" = '${filters.bancaId}'::uuid)` : ''}
                ${filters.ventanaId ? `AND t."ventanaId" = '${filters.ventanaId}'::uuid` : ''}
                ${filters.loteriaId ? `AND t."loteriaId" = '${filters.loteriaId}'::uuid` : ''}
                ${filters.sorteoId ? `AND t."sorteoId" = '${filters.sorteoId}'::uuid` : ''}
                ${dateCondition ? `AND ${dateCondition.text}` : ''}
            ),
            jugada_stats AS (
              SELECT j."ticketId", SUM(j.payout) as payout, SUM(j."commissionAmount") as commission
              FROM "Jugada" j
              WHERE j."deletedAt" IS NULL
              GROUP BY j."ticketId"
            )
            SELECT 
                v.id as key,
                v.name as name,
                SUM(ft."totalAmount") as "ventasTotal",
                COUNT(ft.id) as "ticketsCount",
                SUM(COALESCE(js.payout, 0)) as "payoutTotal",
                SUM(ft."totalAmount") - SUM(COALESCE(js.payout, 0)) as neto,
                SUM(COALESCE(js.commission, 0)) as "commissionTotal",
                COUNT(CASE WHEN ft."isWinner" THEN 1 END) as "totalWinningTickets",
                COUNT(CASE WHEN ft.status = 'PAID' THEN 1 END) as "totalPaidTickets"
            FROM "Ventana" v
            INNER JOIN filtered_tickets ft ON ft."ventanaId" = v.id
            LEFT JOIN jugada_stats js ON js."ticketId" = ft.id
            GROUP BY v.id, v.name
            ORDER BY "ventasTotal" DESC
            LIMIT ${top}
          `, ...(dateCondition?.values || []));

          return rawResult.map(r => ({
            ...r,
            ventasTotal: Number(r.ventasTotal) || 0,
            ticketsCount: Number(r.ticketsCount) || 0,
            payoutTotal: Number(r.payoutTotal) || 0,
            neto: Number(r.neto) || 0,
            commissionTotal: Number(r.commissionTotal) || 0,
            totalWinningTickets: Number(r.totalWinningTickets) || 0,
            totalPaidTickets: Number(r.totalPaidTickets) || 0,
          }));
        }

        case "vendedor": {
          const { dateCondition } = buildRawDateConditions(filters);
          
          const rawResult = await prisma.$queryRawUnsafe<any[]>(`
            WITH filtered_tickets AS (
              SELECT t.id, t."vendedorId", t."ventanaId", t."totalAmount", t."isWinner", t.status, t."createdAt", t."businessDate"
              FROM "Ticket" t
              INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
              WHERE t."deletedAt" IS NULL 
                AND t."isActive" = true
                AND s.status = 'EVALUATED'
                AND t.status != 'CANCELLED'
                ${filters.bancaId ? `AND EXISTS (SELECT 1 FROM "Ventana" v_sub WHERE v_sub.id = t."ventanaId" AND v_sub."bancaId" = '${filters.bancaId}'::uuid)` : ''}
                ${filters.ventanaId ? `AND t."ventanaId" = '${filters.ventanaId}'::uuid` : ''}
                ${filters.vendedorId ? `AND t."vendedorId" = '${filters.vendedorId}'::uuid` : ''}
                ${filters.loteriaId ? `AND t."loteriaId" = '${filters.loteriaId}'::uuid` : ''}
                ${filters.sorteoId ? `AND t."sorteoId" = '${filters.sorteoId}'::uuid` : ''}
                ${dateCondition ? `AND ${dateCondition.text}` : ''}
            ),
            jugada_stats AS (
              SELECT j."ticketId", SUM(j.payout) as payout, SUM(j."commissionAmount") as commission
              FROM "Jugada" j
              WHERE j."deletedAt" IS NULL
              GROUP BY j."ticketId"
            ),
            payment_stats AS (
              SELECT tp."ticketId", SUM(tp."amountPaid") as paid
              FROM "TicketPayment" tp
              WHERE tp."isReversed" = false
              GROUP BY tp."ticketId"
            )
            SELECT 
                u.id as key,
                u.name as name,
                u.code as "vendedorCode",
                u."isActive" as "isActiveUser",
                v.name as "ventanaName",
                SUM(ft."totalAmount") as "ventasTotal",
                COUNT(ft.id) as "ticketsCount",
                SUM(COALESCE(js.payout, 0)) as "payoutTotal",
                SUM(ft."totalAmount") - SUM(COALESCE(js.payout, 0)) - SUM(COALESCE(js.commission, 0)) as neto,
                SUM(COALESCE(js.commission, 0)) as "commissionTotal",
                COUNT(CASE WHEN ft."isWinner" THEN 1 END) as "totalWinningTickets",
                COUNT(CASE WHEN ft.status = 'PAID' THEN 1 END) as "totalPaidTickets",
                COUNT(CASE WHEN ft."isWinner" AND ft.status != 'PAID' THEN 1 END) as "unpaidTicketsCount",
                SUM(COALESCE(ps.paid, 0)) as "totalPaid",
                SUM(CASE WHEN ft."isWinner" THEN GREATEST(0, COALESCE(js.payout, 0) - COALESCE(ps.paid, 0)) ELSE 0 END) as "pendingPayment",
                MAX(ft."createdAt") as "lastTicketAt",
                MIN(ft."createdAt") as "firstTicketAt",
                COUNT(DISTINCT ft."businessDate") as "activityDays"
            FROM "User" u
            INNER JOIN filtered_tickets ft ON ft."vendedorId" = u.id
            INNER JOIN "Ventana" v ON v.id = ft."ventanaId"
            LEFT JOIN jugada_stats js ON js."ticketId" = ft.id
            LEFT JOIN payment_stats ps ON ps."ticketId" = ft.id
            GROUP BY u.id, u.name, u.code, u."isActive", v.name
            ORDER BY "ventasTotal" DESC
            LIMIT ${top}
          `, ...(dateCondition?.values || []));

          return rawResult.map(r => ({
            ...r,
            ventasTotal: Number(r.ventasTotal) || 0,
            ticketsCount: Number(r.ticketsCount) || 0,
            payoutTotal: Number(r.payoutTotal) || 0,
            neto: Number(r.neto) || 0,
            commissionTotal: Number(r.commissionTotal) || 0,
            totalWinningTickets: Number(r.totalWinningTickets) || 0,
            totalPaidTickets: Number(r.totalPaidTickets) || 0,
            unpaidTicketsCount: Number(r.unpaidTicketsCount) || 0,
            totalPaid: Number(r.totalPaid) || 0,
            pendingPayment: Number(r.pendingPayment) || 0,
            avgTicketAmount: r.ticketsCount > 0 ? Number(r.ventasTotal) / Number(r.ticketsCount) : 0,
            winRate: r.ticketsCount > 0 ? (Number(r.totalWinningTickets) / Number(r.ticketsCount)) * 100 : 0,
            payoutRate: r.ventasTotal > 0 ? (Number(r.payoutTotal) / Number(r.ventasTotal)) * 100 : 0,
            status: r.isActiveUser ? 'active' : 'inactive',
            lastTicketAt: r.lastTicketAt ? r.lastTicketAt.toISOString() : undefined,
            firstTicketAt: r.firstTicketAt ? r.firstTicketAt.toISOString() : undefined,
            activityDays: Number(r.activityDays) || 0,
          }));
        }

        case "loteria": {
          const { dateCondition } = buildRawDateConditions(filters);
          
          const rawResult = await prisma.$queryRawUnsafe<any[]>(`
            WITH filtered_tickets AS (
              SELECT t.id, t."loteriaId", t."ventanaId", t."totalAmount", t."isWinner", t.status
              FROM "Ticket" t
              INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
              WHERE t."deletedAt" IS NULL 
                AND t."isActive" = true
                AND s.status = 'EVALUATED'
                AND t.status != 'CANCELLED'
                ${filters.bancaId ? `AND EXISTS (SELECT 1 FROM "Ventana" v_sub WHERE v_sub.id = t."ventanaId" AND v_sub."bancaId" = '${filters.bancaId}'::uuid)` : ''}
                ${filters.ventanaId ? `AND t."ventanaId" = '${filters.ventanaId}'::uuid` : ''}
                ${filters.vendedorId ? `AND t."vendedorId" = '${filters.vendedorId}'::uuid` : ''}
                ${filters.loteriaId ? `AND t."loteriaId" = '${filters.loteriaId}'::uuid` : ''}
                ${filters.sorteoId ? `AND t."sorteoId" = '${filters.sorteoId}'::uuid` : ''}
                ${dateCondition ? `AND ${dateCondition.text}` : ''}
            ),
            jugada_stats AS (
              SELECT j."ticketId", SUM(j.payout) as payout, SUM(j."commissionAmount") as commission
              FROM "Jugada" j
              WHERE j."deletedAt" IS NULL
              GROUP BY j."ticketId"
            )
            SELECT 
                l.id as key,
                l.name as name,
                SUM(ft."totalAmount") as "ventasTotal",
                COUNT(ft.id) as "ticketsCount",
                SUM(COALESCE(js.payout, 0)) as "payoutTotal",
                SUM(ft."totalAmount") - SUM(COALESCE(js.payout, 0)) as neto,
                SUM(COALESCE(js.commission, 0)) as "commissionTotal",
                COUNT(CASE WHEN ft."isWinner" THEN 1 END) as "totalWinningTickets",
                COUNT(CASE WHEN ft.status = 'PAID' THEN 1 END) as "totalPaidTickets"
            FROM "Loteria" l
            INNER JOIN filtered_tickets ft ON ft."loteriaId" = l.id
            LEFT JOIN jugada_stats js ON js."ticketId" = ft.id
            GROUP BY l.id, l.name
            ORDER BY "ventasTotal" DESC
            LIMIT ${top}
          `, ...(dateCondition?.values || []));

          return rawResult.map(r => ({
            ...r,
            ventasTotal: Number(r.ventasTotal) || 0,
            ticketsCount: Number(r.ticketsCount) || 0,
            payoutTotal: Number(r.payoutTotal) || 0,
            neto: Number(r.neto) || 0,
            commissionTotal: Number(r.commissionTotal) || 0,
            totalWinningTickets: Number(r.totalWinningTickets) || 0,
            totalPaidTickets: Number(r.totalPaidTickets) || 0,
          }));
        }

        case "sorteo": {
          const { dateCondition } = buildRawDateConditions(filters);
          
          const rawResult = await prisma.$queryRawUnsafe<any[]>(`
            WITH filtered_tickets AS (
              SELECT t.id, t."sorteoId", t."ventanaId", t."totalAmount", t."isWinner", t.status
              FROM "Ticket" t
              INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
              WHERE t."deletedAt" IS NULL 
                AND t."isActive" = true
                AND s.status = 'EVALUATED'
                AND t.status != 'CANCELLED'
                ${filters.bancaId ? `AND EXISTS (SELECT 1 FROM "Ventana" v_sub WHERE v_sub.id = t."ventanaId" AND v_sub."bancaId" = '${filters.bancaId}'::uuid)` : ''}
                ${filters.ventanaId ? `AND t."ventanaId" = '${filters.ventanaId}'::uuid` : ''}
                ${filters.vendedorId ? `AND t."vendedorId" = '${filters.vendedorId}'::uuid` : ''}
                ${filters.loteriaId ? `AND t."loteriaId" = '${filters.loteriaId}'::uuid` : ''}
                ${filters.sorteoId ? `AND t."sorteoId" = '${filters.sorteoId}'::uuid` : ''}
                ${dateCondition ? `AND ${dateCondition.text}` : ''}
            ),
            jugada_stats AS (
              SELECT j."ticketId", SUM(j.payout) as payout, SUM(j."commissionAmount") as commission
              FROM "Jugada" j
              WHERE j."deletedAt" IS NULL
              GROUP BY j."ticketId"
            )
            SELECT 
                s.id as key,
                s.name as name,
                SUM(ft."totalAmount") as "ventasTotal",
                COUNT(ft.id) as "ticketsCount",
                SUM(COALESCE(js.payout, 0)) as "payoutTotal",
                SUM(ft."totalAmount") - SUM(COALESCE(js.payout, 0)) as neto,
                SUM(COALESCE(js.commission, 0)) as "commissionTotal",
                COUNT(CASE WHEN ft."isWinner" THEN 1 END) as "totalWinningTickets",
                COUNT(CASE WHEN ft.status = 'PAID' THEN 1 END) as "totalPaidTickets"
            FROM "Sorteo" s
            INNER JOIN filtered_tickets ft ON ft."sorteoId" = s.id
            LEFT JOIN jugada_stats js ON js."ticketId" = ft.id
            GROUP BY s.id, s.name
            ORDER BY "ventasTotal" DESC
            LIMIT ${top}
          `, ...(dateCondition?.values || []));

          return rawResult.map(r => ({
            ...r,
            ventasTotal: Number(r.ventasTotal) || 0,
            ticketsCount: Number(r.ticketsCount) || 0,
            payoutTotal: Number(r.payoutTotal) || 0,
            neto: Number(r.neto) || 0,
            commissionTotal: Number(r.commissionTotal) || 0,
            totalWinningTickets: Number(r.totalWinningTickets) || 0,
            totalPaidTickets: Number(r.totalPaidTickets) || 0,
          }));
        }

        case "numero": {
          const { dateCondition } = buildRawDateConditions(filters);
          
          const rawResult = await prisma.$queryRawUnsafe<any[]>(`
            WITH filtered_tickets AS (
              SELECT t.id, t."ventanaId", t."isWinner", t.status
              FROM "Ticket" t
              INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
              WHERE t."deletedAt" IS NULL 
                AND t."isActive" = true
                AND s.status = 'EVALUATED'
                AND t.status != 'CANCELLED'
                ${filters.bancaId ? `AND EXISTS (SELECT 1 FROM "Ventana" v_sub WHERE v_sub.id = t."ventanaId" AND v_sub."bancaId" = '${filters.bancaId}'::uuid)` : ''}
                ${filters.ventanaId ? `AND t."ventanaId" = '${filters.ventanaId}'::uuid` : ''}
                ${filters.vendedorId ? `AND t."vendedorId" = '${filters.vendedorId}'::uuid` : ''}
                ${filters.loteriaId ? `AND t."loteriaId" = '${filters.loteriaId}'::uuid` : ''}
                ${filters.sorteoId ? `AND t."sorteoId" = '${filters.sorteoId}'::uuid` : ''}
                ${dateCondition ? `AND ${dateCondition.text}` : ''}
            )
            SELECT 
                j.number as key,
                CONCAT('Número ', j.number) as name,
                SUM(j.amount) as "ventasTotal",
                COUNT(DISTINCT j."ticketId") as "ticketsCount",
                SUM(COALESCE(j.payout, 0)) as "payoutTotal",
                SUM(j.amount) - SUM(COALESCE(j.payout, 0)) as neto,
                SUM(COALESCE(j."commissionAmount", 0)) as "commissionTotal",
                COUNT(DISTINCT CASE WHEN ft."isWinner" THEN ft.id END) as "totalWinningTickets",
                COUNT(DISTINCT CASE WHEN ft.status = 'PAID' THEN ft.id END) as "totalPaidTickets"
            FROM "Jugada" j
            INNER JOIN filtered_tickets ft ON ft.id = j."ticketId"
            WHERE j."deletedAt" IS NULL AND j."isActive" = true
            GROUP BY j.number
            ORDER BY "ventasTotal" DESC
            LIMIT ${top}
          `, ...(dateCondition?.values || []));

          return rawResult.map(r => ({
            ...r,
            ventasTotal: Number(r.ventasTotal) || 0,
            ticketsCount: Number(r.ticketsCount) || 0,
            payoutTotal: Number(r.payoutTotal) || 0,
            neto: Number(r.neto) || 0,
            commissionTotal: Number(r.commissionTotal) || 0,
            totalWinningTickets: Number(r.totalWinningTickets) || 0,
            totalPaidTickets: Number(r.totalPaidTickets) || 0,
          }));
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
