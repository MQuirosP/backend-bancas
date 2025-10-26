// src/api/v1/services/venta.service.ts
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import { Prisma } from "@prisma/client";

/**
 * Interfaz para filtros estándar de ventas
 */
interface VentasFilters {
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
  userId?: string; // Inyectado por scope=mine según rol
}

/**
 * Construye el WHERE de Prisma a partir de filtros normalizados
 */
function buildWhereClause(filters: VentasFilters): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {
    isActive: true, // Solo tickets activos (no soft-deleted)
  };

  // Filtro por fechas (createdAt)
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }

  // Filtro por status
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

    // Búsqueda por número de ticket
    if (!isNaN(Number(searchTerm))) {
      orConditions.push({ ticketNumber: Number(searchTerm) });
    }

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
    const where = buildWhereClause(filters);
    const { skip, take } = getSkipTake(page, pageSize);

    const [data, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
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
    return { data, meta };
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
    lastTicketAt: string | null;
  }> {
    const where = buildWhereClause(filters);

    // Agregaciones en paralelo
    const [ticketsAgg, jugadasAgg, lastTicket] = await prisma.$transaction([
      // Suma de totalAmount y count de tickets
      prisma.ticket.aggregate({
        where,
        _sum: { totalAmount: true },
        _count: { id: true },
      }),

      // Suma de payouts y count de jugadas
      prisma.jugada.aggregate({
        where: {
          ticket: where,
        },
        _sum: { payout: true },
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
    const neto = ventasTotal - payoutTotal;

    return {
      ventasTotal,
      ticketsCount: ticketsAgg._count.id,
      jugadasCount: jugadasAgg._count.id,
      payoutTotal,
      neto,
      lastTicketAt: lastTicket?.createdAt?.toISOString() ?? null,
    };
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
    }>
  > {
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

        // Obtener nombres de ventanas
        const ventanaIds = result.map((r) => r.ventanaId);
        const ventanas = await prisma.ventana.findMany({
          where: { id: { in: ventanaIds } },
          select: { id: true, name: true, code: true },
        });
        const ventanaMap = new Map(ventanas.map((v) => [v.id, v]));

        // Calcular payouts por ventana
        const payouts = await prisma.jugada.groupBy({
          by: ["ticketId"],
          where: { ticket: { ventanaId: { in: ventanaIds }, ...where } },
          _sum: { payout: true },
        });
        const ticketIds = payouts.map((p) => p.ticketId);
        const tickets = await prisma.ticket.findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, ventanaId: true },
        });
        const payoutByVentana = new Map<string, number>();
        tickets.forEach((t) => {
          const payout = payouts.find((p) => p.ticketId === t.id)?._sum.payout ?? 0;
          payoutByVentana.set(t.ventanaId, (payoutByVentana.get(t.ventanaId) ?? 0) + payout);
        });

        return result.map((r) => {
          const ventana = ventanaMap.get(r.ventanaId);
          const ventasTotal = r._sum.totalAmount ?? 0;
          const payoutTotal = payoutByVentana.get(r.ventanaId) ?? 0;
          return {
            key: r.ventanaId,
            name: ventana?.name ?? "Desconocida",
            ventasTotal,
            ticketsCount: r._count.id,
            payoutTotal,
            neto: ventasTotal - payoutTotal,
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

        const payouts = await prisma.jugada.groupBy({
          by: ["ticketId"],
          where: { ticket: { vendedorId: { in: vendedorIds }, ...where } },
          _sum: { payout: true },
        });
        const ticketIds = payouts.map((p) => p.ticketId);
        const tickets = await prisma.ticket.findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, vendedorId: true },
        });
        const payoutByVendedor = new Map<string, number>();
        tickets.forEach((t) => {
          const payout = payouts.find((p) => p.ticketId === t.id)?._sum.payout ?? 0;
          payoutByVendedor.set(t.vendedorId, (payoutByVendedor.get(t.vendedorId) ?? 0) + payout);
        });

        return result.map((r) => {
          const vendedor = vendedorMap.get(r.vendedorId);
          const ventasTotal = r._sum.totalAmount ?? 0;
          const payoutTotal = payoutByVendedor.get(r.vendedorId) ?? 0;
          return {
            key: r.vendedorId,
            name: vendedor?.name ?? "Desconocido",
            ventasTotal,
            ticketsCount: r._count.id,
            payoutTotal,
            neto: ventasTotal - payoutTotal,
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

        const payouts = await prisma.jugada.groupBy({
          by: ["ticketId"],
          where: { ticket: { loteriaId: { in: loteriaIds }, ...where } },
          _sum: { payout: true },
        });
        const ticketIds = payouts.map((p) => p.ticketId);
        const tickets = await prisma.ticket.findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, loteriaId: true },
        });
        const payoutByLoteria = new Map<string, number>();
        tickets.forEach((t) => {
          const payout = payouts.find((p) => p.ticketId === t.id)?._sum.payout ?? 0;
          payoutByLoteria.set(t.loteriaId, (payoutByLoteria.get(t.loteriaId) ?? 0) + payout);
        });

        return result.map((r) => {
          const loteria = loteriaMap.get(r.loteriaId);
          const ventasTotal = r._sum.totalAmount ?? 0;
          const payoutTotal = payoutByLoteria.get(r.loteriaId) ?? 0;
          return {
            key: r.loteriaId,
            name: loteria?.name ?? "Desconocida",
            ventasTotal,
            ticketsCount: r._count.id,
            payoutTotal,
            neto: ventasTotal - payoutTotal,
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
          where: { id: { in: sorteoIds } },
          select: { id: true, name: true, scheduledAt: true },
        });
        const sorteoMap = new Map(sorteos.map((s) => [s.id, s]));

        const payouts = await prisma.jugada.groupBy({
          by: ["ticketId"],
          where: { ticket: { sorteoId: { in: sorteoIds }, ...where } },
          _sum: { payout: true },
        });
        const ticketIds = payouts.map((p) => p.ticketId);
        const tickets = await prisma.ticket.findMany({
          where: { id: { in: ticketIds } },
          select: { id: true, sorteoId: true },
        });
        const payoutBySorteo = new Map<string, number>();
        tickets.forEach((t) => {
          const payout = payouts.find((p) => p.ticketId === t.id)?._sum.payout ?? 0;
          payoutBySorteo.set(t.sorteoId, (payoutBySorteo.get(t.sorteoId) ?? 0) + payout);
        });

        return result.map((r) => {
          const sorteo = sorteoMap.get(r.sorteoId);
          const ventasTotal = r._sum.totalAmount ?? 0;
          const payoutTotal = payoutBySorteo.get(r.sorteoId) ?? 0;
          return {
            key: r.sorteoId,
            name: sorteo?.name ?? "Desconocido",
            ventasTotal,
            ticketsCount: r._count.id,
            payoutTotal,
            neto: ventasTotal - payoutTotal,
          };
        });
      }

      case "numero": {
        const result = await prisma.jugada.groupBy({
          by: ["number"],
          where: { ticket: where },
          _sum: { amount: true, payout: true },
          _count: { id: true },
          orderBy: { _sum: { amount: "desc" } },
          take: top,
        });

        return result.map((r) => {
          const ventasTotal = r._sum.amount ?? 0;
          const payoutTotal = r._sum.payout ?? 0;
          return {
            key: r.number,
            name: `Número ${r.number}`,
            ventasTotal,
            ticketsCount: r._count.id,
            payoutTotal,
            neto: ventasTotal - payoutTotal,
          };
        });
      }

      default:
        throw new AppError("Dimensión no soportada", 400);
    }
  },

  /**
   * 4) Serie de tiempo (timeseries)
   * GET /ventas/timeseries?granularity=hour|day|week
   */
  async timeseries(
    granularity: "hour" | "day" | "week" = "day",
    filters: VentasFilters = {},
    dimension?: "ventana" | "vendedor" | "loteria" | "sorteo"
  ): Promise<
    Array<{
      ts: string;
      ventasTotal: number;
      ticketsCount: number;
      payoutTotal?: number;
      breakdown?: Array<{ key: string; name: string; ventasTotal: number; ticketsCount: number }>;
    }>
  > {
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

    // Query SQL crudo para agrupar por time bucket
    const result = await prisma.$queryRaw<
      Array<{
        ts: Date;
        ventasTotal: string;
        ticketsCount: string;
      }>
    >`
      SELECT
        DATE_TRUNC(${truncFormat}, "createdAt") as ts,
        SUM("totalAmount")::text as "ventasTotal",
        COUNT(*)::text as "ticketsCount"
      FROM "Ticket"
      WHERE "isActive" = true
        ${filters.dateFrom ? Prisma.sql`AND "createdAt" >= ${filters.dateFrom}` : Prisma.empty}
        ${filters.dateTo ? Prisma.sql`AND "createdAt" <= ${filters.dateTo}` : Prisma.empty}
        ${filters.status ? Prisma.sql`AND "status" = ${filters.status}` : Prisma.empty}
        ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        ${filters.vendedorId ? Prisma.sql`AND "vendedorId" = ${filters.vendedorId}` : Prisma.empty}
        ${filters.loteriaId ? Prisma.sql`AND "loteriaId" = ${filters.loteriaId}` : Prisma.empty}
        ${filters.sorteoId ? Prisma.sql`AND "sorteoId" = ${filters.sorteoId}` : Prisma.empty}
      GROUP BY ts
      ORDER BY ts ASC
    `;

    return result.map((r) => ({
      ts: r.ts.toISOString(),
      ventasTotal: parseFloat(r.ventasTotal),
      ticketsCount: parseInt(r.ticketsCount, 10),
    }));
  },
};

export default VentasService;
