// src/api/v1/services/venta.service.ts
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import { Prisma } from "@prisma/client";
import logger from "../../../core/logger";

/**
 * Interfaz para filtros estándar de ventas
 */
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
  search?: string;
  orderBy?: string;
}

/**
 * Construye el WHERE de Prisma a partir de filtros normalizados
 * Nota: Usa deletedAt IS NULL para soft-delete, no isActive
 * Tickets válidos: ACTIVE o EVALUATED
 */
function buildWhereClause(filters: VentasFilters): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {
    deletedAt: null, // Soft-delete: solo tickets no eliminados
    status: { in: ['ACTIVE', 'EVALUATED'] as any }, // Solo tickets activos o evaluados
  };

  // Filtro por fechas (createdAt)
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }

  // Filtro por status personalizado (si se solicita un status específico diferente)
  if (filters.status) {
    where.status = filters.status as any;
  }

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
      const where = buildWhereClause(filters);
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
  async summary(filters: VentasFilters = {}): Promise<{
    ventasTotal: number;
    ticketsCount: number;
    jugadasCount: number;
    payoutTotal: number;
    neto: number;
    commissionTotal: number;
    netoDespuesComision: number;
    lastTicketAt: string | null;
  }> {
    try {
      const where = buildWhereClause(filters);

      // Agregaciones en paralelo
      const [ticketsAgg, jugadasAgg, lastTicket] = await prisma.$transaction([
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
      ]);

      const ventasTotal = ticketsAgg._sum.totalAmount ?? 0;
      const payoutTotal = jugadasAgg._sum.payout ?? 0;
      const commissionTotal = jugadasAgg._sum.commissionAmount ?? 0;
      const neto = ventasTotal - payoutTotal;
      const netoDespuesComision = neto - commissionTotal;

      logger.info({
        layer: "service",
        action: "VENTA_SUMMARY",
        payload: { filters, ventasTotal, ticketsCount: ticketsAgg._count.id, commissionTotal },
      });

      return {
        ventasTotal,
        ticketsCount: ticketsAgg._count.id,
        jugadasCount: jugadasAgg._count.id,
        payoutTotal,
        neto,
        commissionTotal,
        netoDespuesComision,
        lastTicketAt: lastTicket?.createdAt?.toISOString() ?? null,
      };
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
    }>
  > {
    try {
      if (top > 50) {
        throw new AppError("El parámetro 'top' no puede ser mayor a 50", 400, {
          code: "VAL_3001",
          details: [{ field: "top", message: "Máximo permitido: 50" }],
        });
      }

      const where = buildWhereClause(filters);

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
          const result = await prisma.ticket.groupBy({
            by: ["vendedorId"],
            where,
            _sum: { totalAmount: true },
            _count: { id: true },
            orderBy: { _sum: { totalAmount: "desc" } },
            take: top,
          });

          const vendedorIds = result.map((r) => r.vendedorId);
          const vendedores = await prisma.user.findMany({
            where: { id: { in: vendedorIds } },
            select: { id: true, name: true, username: true },
          });
          const vendedorMap = new Map(vendedores.map((v) => [v.id, v]));

          const jugadasAgg = await prisma.jugada.groupBy({
            by: ["ticketId"],
            where: { ticket: { vendedorId: { in: vendedorIds }, ...where } },
            _sum: { payout: true, commissionAmount: true },
          });
          const ticketIds = jugadasAgg.map((p) => p.ticketId);
          const tickets = await prisma.ticket.findMany({
            where: { id: { in: ticketIds } },
            select: { id: true, vendedorId: true, isWinner: true, status: true },
          });
          const payoutByVendedor = new Map<string, number>();
          const commissionByVendedor = new Map<string, number>();
          const winningTicketsByVendedor = new Map<string, number>();
          const paidTicketsByVendedor = new Map<string, number>();

          tickets.forEach((t) => {
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
            }
          });

          return result.map((r) => {
            const vendedor = vendedorMap.get(r.vendedorId);
            const ventasTotal = r._sum.totalAmount ?? 0;
            const payoutTotal = payoutByVendedor.get(r.vendedorId) ?? 0;
            const commissionTotal = commissionByVendedor.get(r.vendedorId) ?? 0;
            return {
              key: r.vendedorId,
              name: vendedor?.name ?? "Desconocido",
              ventasTotal,
              ticketsCount: r._count.id,
              payoutTotal,
              neto: ventasTotal - payoutTotal,
              commissionTotal,
              totalWinningTickets: winningTicketsByVendedor.get(r.vendedorId) ?? 0,
              totalPaidTickets: paidTicketsByVendedor.get(r.vendedorId) ?? 0,
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
      const where = buildWhereClause(filters);

      // Determinar el formato de truncamiento SQL según granularidad
      let truncFormat: string;
      switch (granularity) {
        case "hour":
          truncFormat = "hour";
          break;
        case "day":
          truncFormat = "day";
          break;
        case "week":
          truncFormat = "week";
          break;
        default:
          truncFormat = "day";
      }

      // Construir condiciones WHERE dinámicamente
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."status" IN ('ACTIVE', 'EVALUATED')` // Tickets activos o evaluados
      ];

      if (filters.dateFrom) {
        whereConditions.push(Prisma.sql`t."createdAt" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        whereConditions.push(Prisma.sql`t."createdAt" <= ${filters.dateTo}`);
      }
      if (filters.status) {
        whereConditions.push(Prisma.sql`t."status" = ${filters.status}`);
      }
      if (filters.ventanaId) {
        whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}`);
      }
      if (filters.vendedorId) {
        whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}`);
      }
      if (filters.loteriaId) {
        whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}`);
      }
      if (filters.sorteoId) {
        whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}`);
      }

      const whereClause =
        whereConditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}` : Prisma.empty;

      // Query SQL crudo para agrupar por time bucket con comisiones
      const result = await prisma.$queryRaw<
        Array<{
          ts: Date;
          ventasTotal: string;
          ticketsCount: string;
          commissionTotal: string;
        }>
      >`
        SELECT
          DATE_TRUNC(${truncFormat}, t."createdAt") as ts,
          SUM(t."totalAmount")::text as "ventasTotal",
          COUNT(DISTINCT t.id)::text as "ticketsCount",
          COALESCE(SUM(j."commissionAmount"), 0)::text as "commissionTotal"
        FROM "Ticket" t
        LEFT JOIN "Jugada" j ON j."ticketId" = t.id
        ${whereClause}
        GROUP BY ts
        ORDER BY ts ASC
      `;

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
          scheduledAt: s.scheduledAt.toISOString(),
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
