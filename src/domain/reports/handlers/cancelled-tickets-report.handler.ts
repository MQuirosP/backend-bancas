/**
 * Handler de reportes para Tickets Cancelados
 */

import { Prisma, TicketStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { resolveDateRange, normalizePagination, calculatePercentage } from '../../../api/v1/utils/reports.utils';
import { DateToken } from '../../../api/v1/types/reports.types';
import { formatIsoLocal } from '../../../utils/datetime';
import { resolveBreakdowns } from './reports-common.helper';

export interface CancelledTicketsFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  page?: number;
  pageSize?: number;
  bancaId?: string;
}

export const CancelledTicketsReportHandler = {
  /**
   * Reporte de tickets cancelados
   */
  async getCancelledTickets(filters: CancelledTicketsFilters): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const { page, pageSize, skip } = normalizePagination(filters.page, filters.pageSize);

    const where: Prisma.TicketWhereInput = {
      status: TicketStatus.CANCELLED,
      // NO filtrar por deletedAt: los tickets cancelados DEBEN tener deletedAt
      businessDate: {
        gte: new Date(dateRange.fromString),
        lte: new Date(dateRange.toString),
      },
      ...(filters.ventanaId && filters.ventanaId.trim() !== '' && { ventanaId: filters.ventanaId }),
      ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
      ...(filters.loteriaId && filters.loteriaId.trim() !== '' && { loteriaId: filters.loteriaId }),
      ...(filters.bancaId && filters.bancaId.trim() !== '' && { bancaId: filters.bancaId }),
    };

    const total = await prisma.ticket.count({ where });

    const tickets = await prisma.ticket.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        loteria: { select: { id: true, name: true } },
        ventana: { select: { id: true, name: true } },
        vendedor: { select: { id: true, name: true } },
      },
    });

    // Calcular resumen
    const summaryTickets = await prisma.ticket.findMany({
      where,
      select: {
        totalAmount: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    const totalCancelledAmount = summaryTickets.reduce((sum, t) => sum + (t.totalAmount || 0), 0);
    const averageCancelledAmount = total > 0 ? totalCancelledAmount / total : 0;

    // Calcular tasa de cancelación
    const totalWhere: Prisma.TicketWhereInput = {
      businessDate: {
        gte: new Date(dateRange.fromString),
        lte: new Date(dateRange.toString),
      },
      ...(filters.ventanaId && filters.ventanaId.trim() !== '' && { ventanaId: filters.ventanaId }),
      ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
      ...(filters.loteriaId && filters.loteriaId.trim() !== '' && { loteriaId: filters.loteriaId }),
      ...(filters.bancaId && filters.bancaId.trim() !== '' && { bancaId: filters.bancaId }),
    };

    const totalTicketsInPeriod = await prisma.ticket.count({
      where: totalWhere,
    });
    const cancelledRate = totalTicketsInPeriod > 0
      ? calculatePercentage(total, totalTicketsInPeriod)
      : 0;

    // Calcular distribución por tiempo de cancelación y tiempo promedio
    const byTimeRange = {
      under5min: { count: 0, amount: 0 },
      '5to30min': { count: 0, amount: 0 },
      '30minTo1hr': { count: 0, amount: 0 },
      over1hr: { count: 0, amount: 0 },
    };

    const cancelTimes: number[] = [];

    summaryTickets.forEach(ticket => {
      if (ticket.deletedAt && ticket.createdAt) {
        const minutesToCancel = (ticket.deletedAt.getTime() - ticket.createdAt.getTime()) / (1000 * 60);
        cancelTimes.push(minutesToCancel);
        const amount = ticket.totalAmount || 0;

        if (minutesToCancel < 5) {
          byTimeRange.under5min.count++;
          byTimeRange.under5min.amount += amount;
        } else if (minutesToCancel < 30) {
          byTimeRange['5to30min'].count++;
          byTimeRange['5to30min'].amount += amount;
        } else if (minutesToCancel < 60) {
          byTimeRange['30minTo1hr'].count++;
          byTimeRange['30minTo1hr'].amount += amount;
        } else {
          byTimeRange.over1hr.count++;
          byTimeRange.over1hr.amount += amount;
        }
      }
    });

    const averageTimeToCancel = cancelTimes.length > 0
      ? parseFloat((cancelTimes.reduce((a, b) => a + b, 0) / cancelTimes.length).toFixed(2))
      : 0;

    const ticketsData = tickets.map(ticket => {
      const hoursSinceCreation = ticket.deletedAt && ticket.createdAt
        ? parseFloat(((ticket.deletedAt.getTime() - ticket.createdAt.getTime()) / (1000 * 60 * 60)).toFixed(2))
        : 0;

      return {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        createdAt: formatIsoLocal(ticket.createdAt),
        cancelledAt: ticket.deletedAt ? formatIsoLocal(ticket.deletedAt) : null,
        loteriaId: ticket.loteriaId,
        loteriaName: ticket.loteria.name,
        ventanaId: ticket.ventanaId,
        ventanaName: ticket.ventana.name,
        vendedorId: ticket.vendedorId,
        vendedorName: ticket.vendedor.name,
        totalAmount: ticket.totalAmount,
        hoursSinceCreation,
      };
    });

    // DESGLOSES (breakdowns) según filtros aplicados
    const cbk = resolveBreakdowns(filters);

    const cancelledEntityFilter = Prisma.sql`
      ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
      ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
    `;

    let cByVentana: any[] | undefined;
    if (cbk.includeVentana) {
      const byVentanaQuery = Prisma.sql`
        WITH cancelled_stats AS (
          SELECT
            t."ventanaId",
            v.name as ventana_name,
            COUNT(*)::int as cancelled_count,
            SUM(t."totalAmount")::float as cancelled_amount
          FROM "Ticket" t
          INNER JOIN "Ventana" v ON t."ventanaId" = v.id
          WHERE t."status"::text = 'CANCELLED'
            AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."ventanaId", v.name
        ),
        total_stats AS (
          SELECT
            t."ventanaId",
            COUNT(*)::int as total_tickets
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."ventanaId"
        )
        SELECT 
          cs.*, 
          COALESCE(ts.total_tickets, 0) as total_tickets,
          ROUND(COALESCE((cs.cancelled_count::float / NULLIF(ts.total_tickets, 0)) * 100, 0)::numeric, 2)::float as cancelled_rate
        FROM cancelled_stats cs
        LEFT JOIN total_stats ts ON cs."ventanaId" = ts."ventanaId"
        ORDER BY cs.cancelled_count DESC
      `;

      const byVentanaRaw = await prisma.$queryRaw<Array<{
        ventanaId: string;
        ventana_name: string;
        cancelled_count: number;
        cancelled_amount: number;
        total_tickets: number;
        cancelled_rate: number;
      }>>(byVentanaQuery);

      if (byVentanaRaw.length > 0) {
        cByVentana = byVentanaRaw.map(v => ({
          ventanaId: v.ventanaId,
          ventanaName: v.ventana_name,
          cancelledCount: v.cancelled_count,
          cancelledAmount: v.cancelled_amount,
          cancelledRate: v.cancelled_rate,
          totalTickets: v.total_tickets,
        }));
      }
    }

    let cByVendedor: any[] | undefined;
    if (cbk.includeVendedor) {
      const byVendedorQuery = Prisma.sql`
        WITH cancelled_stats AS (
          SELECT
            t."vendedorId",
            u.name as vendedor_name,
            v.name as ventana_name,
            COUNT(*)::int as cancelled_count,
            SUM(t."totalAmount")::float as cancelled_amount
          FROM "Ticket" t
          INNER JOIN "User" u ON t."vendedorId" = u.id
          INNER JOIN "Ventana" v ON t."ventanaId" = v.id
          WHERE t."status"::text = 'CANCELLED'
            AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."vendedorId", u.name, v.name
        ),
        total_stats AS (
          SELECT
            t."vendedorId",
            COUNT(*)::int as total_tickets
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."vendedorId"
        )
        SELECT 
          cs.*,
          COALESCE(ts.total_tickets, 0) as total_tickets,
          ROUND(COALESCE((cs.cancelled_count::float / NULLIF(ts.total_tickets, 0)) * 100, 0)::numeric, 2)::float as cancelled_rate
        FROM cancelled_stats cs
        LEFT JOIN total_stats ts ON cs."vendedorId" = ts."vendedorId"
        ORDER BY cs.cancelled_count DESC
      `;

      const byVendedorRaw = await prisma.$queryRaw<Array<{
        vendedorId: string;
        vendedor_name: string;
        ventana_name: string;
        cancelled_count: number;
        cancelled_amount: number;
        total_tickets: number;
        cancelled_rate: number;
      }>>(byVendedorQuery);

      if (byVendedorRaw.length > 0) {
        cByVendedor = byVendedorRaw.map(v => ({
          vendedorId: v.vendedorId,
          vendedorName: v.vendedor_name,
          ventanaName: v.ventana_name,
          cancelledCount: v.cancelled_count,
          cancelledAmount: v.cancelled_amount,
          cancelledRate: v.cancelled_rate,
        }));
      }
    }

    let cByLoteria: any[] | undefined;
    if (cbk.includeLoteria) {
      const byLoteriaQuery = Prisma.sql`
        WITH cancelled_stats AS (
          SELECT
            t."loteriaId",
            l.name as loteria_name,
            COUNT(*)::int as cancelled_count,
            SUM(t."totalAmount")::float as cancelled_amount
          FROM "Ticket" t
          INNER JOIN "Loteria" l ON t."loteriaId" = l.id
          WHERE t."status"::text = 'CANCELLED'
            AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."loteriaId", l.name
        ),
        total_stats AS (
          SELECT
            t."loteriaId",
            COUNT(*)::int as total_tickets
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."loteriaId"
        )
        SELECT 
          cs.*,
          COALESCE(ts.total_tickets, 0) as total_tickets,
          ROUND(COALESCE((cs.cancelled_count::float / NULLIF(ts.total_tickets, 0)) * 100, 0)::numeric, 2)::float as cancelled_rate
        FROM cancelled_stats cs
        LEFT JOIN total_stats ts ON cs."loteriaId" = ts."loteriaId"
        ORDER BY cs.cancelled_count DESC
      `;

      const byLoteriaRaw = await prisma.$queryRaw<Array<{
        loteriaId: string;
        loteria_name: string;
        cancelled_count: number;
        cancelled_amount: number;
        total_tickets: number;
        cancelled_rate: number;
      }>>(byLoteriaQuery);

      if (byLoteriaRaw.length > 0) {
        cByLoteria = byLoteriaRaw.map(l => ({
          loteriaId: l.loteriaId,
          loteriaName: l.loteria_name,
          cancelledCount: l.cancelled_count,
          cancelledAmount: l.cancelled_amount,
          cancelledRate: l.cancelled_rate,
        }));
      }
    }

    let cBySorteo: any[] | undefined;
    if (cbk.includeSorteo) {
      const bySorteoQuery = Prisma.sql`
        WITH cancelled_stats AS (
          SELECT
            t."sorteoId",
            s.name as sorteo_name,
            COUNT(*)::int as cancelled_count,
            SUM(t."totalAmount")::float as cancelled_amount
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."status"::text = 'CANCELLED'
            AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."sorteoId", s.name
        ),
        total_stats AS (
          SELECT
            t."sorteoId",
            COUNT(*)::int as total_tickets
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledEntityFilter}
          GROUP BY t."sorteoId"
        )
        SELECT 
          cs.*,
          COALESCE(ts.total_tickets, 0) as total_tickets,
          ROUND(COALESCE((cs.cancelled_count::float / NULLIF(ts.total_tickets, 0)) * 100, 0)::numeric, 2)::float as cancelled_rate
        FROM cancelled_stats cs
        LEFT JOIN total_stats ts ON cs."sorteoId" = ts."sorteoId"
        ORDER BY cs.cancelled_count DESC
      `;

      const bySorteoRaw = await prisma.$queryRaw<Array<{
        sorteoId: string;
        sorteo_name: string;
        cancelled_count: number;
        cancelled_amount: number;
        total_tickets: number;
        cancelled_rate: number;
      }>>(bySorteoQuery);

      if (bySorteoRaw.length > 0) {
        cBySorteo = bySorteoRaw.map(s => ({
          sorteoId: s.sorteoId,
          sorteoName: s.sorteo_name,
          cancelledCount: s.cancelled_count,
          cancelledAmount: s.cancelled_amount,
          cancelledRate: s.cancelled_rate,
        }));
      }
    }

    return {
      data: {
        summary: {
          totalCancelled: total,
          totalCancelledAmount,
          cancelledRate,
          averageCancelledAmount: parseFloat(averageCancelledAmount.toFixed(2)),
          averageTimeToCancel,
          byTimeRange,
        },
        tickets: ticketsData,
        ...(cByVentana && { byVentana: cByVentana }),
        ...(cByVendedor && { byVendedor: cByVendedor }),
        ...(cByLoteria && { byLoteria: cByLoteria }),
        ...(cBySorteo && { bySorteo: cBySorteo }),
      },
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },
};
