/**
 * Servicio de reportes de tickets
 */

import { Prisma, TicketStatus } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { AppError } from '../../../../core/errors';
import logger from '../../../../core/logger';
import { resolveDateRange, normalizePagination, calculatePercentage, calculatePreviousPeriod } from '../../utils/reports.utils';
import { DateToken, PaymentStatus, PaginationMeta, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';

interface WinnersPaymentsFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  paymentStatus?: PaymentStatus;
  page?: number;
  pageSize?: number;
}

interface WinnersPaymentsResult {
  summary: {
    totalWinningTickets: number;
    totalPayout: number;
    totalPaid: number;
    totalPending: number;
    partialPaymentsCount: number;
    unpaidCount: number;
    averagePaymentTimeHours: number | null;
  };
  tickets: Array<{
    id: string;
    ticketNumber: string;
    createdAt: string;
    evaluatedAt: string | null;
    loteriaId: string;
    loteriaName: string;
    sorteoId: string;
    sorteoName: string;
    ventanaId: string;
    ventanaName: string;
    vendedorId: string;
    vendedorName: string;
    totalAmount: number;
    totalPayout: number;
    totalPaid: number;
    remainingAmount: number;
    paymentStatus: 'paid' | 'partial' | 'unpaid';
    paymentCount: number;
    lastPaymentAt: string | null;
    daysSinceEvaluation: number | null;
    hoursSinceEvaluation: number | null;
  }>;
}

export const TicketsReportService = {
  /**
   * Reporte de tickets ganadores y pagos pendientes
   */
  async getWinnersPayments(filters: WinnersPaymentsFilters): Promise<{
    data: WinnersPaymentsResult;
    meta: ReportMeta;
  }> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const { page, pageSize, skip } = normalizePagination(filters.page, filters.pageSize);

    // Construir filtros WHERE
    const where: Prisma.TicketWhereInput = {
      isWinner: true,
      isActive: true,
      deletedAt: null,
      status: { in: [TicketStatus.EVALUATED, TicketStatus.ACTIVE] },
      createdAt: {
        gte: dateRange.from,
        lte: dateRange.to,
      },
      ...(filters.ventanaId && filters.ventanaId.trim() !== '' && { ventanaId: filters.ventanaId }),
      ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
      ...(filters.loteriaId && filters.loteriaId.trim() !== '' && { loteriaId: filters.loteriaId }),
    };

    // Filtro por estado de pago
    if (filters.paymentStatus && filters.paymentStatus !== 'all') {
      if (filters.paymentStatus === 'paid') {
        where.remainingAmount = { lte: 0 };
      } else if (filters.paymentStatus === 'partial') {
        where.AND = [
          { remainingAmount: { gt: 0 } },
          { totalPaid: { gt: 0 } },
        ];
      } else if (filters.paymentStatus === 'unpaid') {
        where.totalPaid = { lte: 0 };
      }
    }

    // Obtener conteo total
    const total = await prisma.ticket.count({ where });

    // Obtener tickets con paginación
    const tickets = await prisma.ticket.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: [
        { createdAt: 'desc' },
      ],
      include: {
        loteria: {
          select: { id: true, name: true },
        },
        sorteo: {
          select: { id: true, name: true, status: true, updatedAt: true },
        },
        ventana: {
          select: { id: true, name: true },
        },
        vendedor: {
          select: { id: true, name: true },
        },
      },
    });

    // Obtener conteo de pagos por ticket usando TicketPayment
    const ticketIds = tickets.map(t => t.id);
    const paymentsByTicket = await prisma.ticketPayment.groupBy({
      by: ['ticketId'],
      where: {
        ticketId: { in: ticketIds },
        isReversed: false,
      },
      _count: { id: true },
      _max: { paymentDate: true },
    });

    const paymentsMap = new Map(
      paymentsByTicket.map(p => [
        p.ticketId,
        {
          count: p._count.id,
          lastPaymentAt: p._max.paymentDate,
        },
      ])
    );

    // Calcular resumen
    const summaryTickets = await prisma.ticket.findMany({
      where,
      select: {
        totalPayout: true,
        totalPaid: true,
        remainingAmount: true,
        sorteo: {
          select: { status: true, updatedAt: true },
        },
        lastPaymentAt: true,
      },
    });

    let totalPayout = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let partialPaymentsCount = 0;
    let unpaidCount = 0;
    const paymentTimes: number[] = [];

    summaryTickets.forEach(ticket => {
      const payout = ticket.totalPayout || 0;
      const paid = ticket.totalPaid || 0;
      const pending = ticket.remainingAmount || 0;

      totalPayout += payout;
      totalPaid += paid;
      totalPending += pending;

      if (paid > 0 && pending > 0) {
        partialPaymentsCount++;
      } else if (paid <= 0) {
        unpaidCount++;
      }

      // Calcular tiempo de pago si hay evaluación y pago
      // Usar updatedAt cuando el status es EVALUATED como aproximación de la fecha de evaluación
      const evaluatedAt = ticket.sorteo?.status === 'EVALUATED' ? ticket.sorteo.updatedAt : null;
      if (evaluatedAt && ticket.lastPaymentAt) {
        const hours = (ticket.lastPaymentAt.getTime() - evaluatedAt.getTime()) / (1000 * 60 * 60);
        if (hours > 0) {
          paymentTimes.push(hours);
        }
      }
    });

    const averagePaymentTimeHours = paymentTimes.length > 0
      ? parseFloat((paymentTimes.reduce((a, b) => a + b, 0) / paymentTimes.length).toFixed(2))
      : null;

    // Mapear tickets a formato de respuesta
    const ticketsData = tickets.map(ticket => {
      const payments = paymentsMap.get(ticket.id) || { count: 0, lastPaymentAt: null };
      // Usar updatedAt cuando el status es EVALUATED como aproximación de la fecha de evaluación
      const evaluatedAt = ticket.sorteo?.status === 'EVALUATED' ? ticket.sorteo.updatedAt : null;
      const now = new Date();
      
      let daysSinceEvaluation: number | null = null;
      let hoursSinceEvaluation: number | null = null;
      
      if (evaluatedAt) {
        const diffMs = now.getTime() - evaluatedAt.getTime();
        daysSinceEvaluation = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        hoursSinceEvaluation = parseFloat((diffMs / (1000 * 60 * 60)).toFixed(2));
      }

      const totalPayout = ticket.totalPayout || 0;
      const totalPaid = ticket.totalPaid || 0;
      const remainingAmount = ticket.remainingAmount || 0;

      let paymentStatus: 'paid' | 'partial' | 'unpaid';
      if (remainingAmount <= 0) {
        paymentStatus = 'paid';
      } else if (totalPaid > 0) {
        paymentStatus = 'partial';
      } else {
        paymentStatus = 'unpaid';
      }

      return {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        createdAt: formatIsoLocal(ticket.createdAt),
        evaluatedAt: evaluatedAt ? formatIsoLocal(evaluatedAt) : null,
        loteriaId: ticket.loteriaId,
        loteriaName: ticket.loteria.name,
        sorteoId: ticket.sorteoId,
        sorteoName: ticket.sorteo.name,
        ventanaId: ticket.ventanaId,
        ventanaName: ticket.ventana.name,
        vendedorId: ticket.vendedorId,
        vendedorName: ticket.vendedor.name,
        totalAmount: ticket.totalAmount,
        totalPayout,
        totalPaid,
        remainingAmount,
        paymentStatus,
        paymentCount: payments.count,
        lastPaymentAt: payments.lastPaymentAt ? formatIsoLocal(payments.lastPaymentAt) : null,
        daysSinceEvaluation,
        hoursSinceEvaluation,
      };
    });

    return {
      data: {
        summary: {
          totalWinningTickets: total,
          totalPayout,
          totalPaid,
          totalPending,
          partialPaymentsCount,
          unpaidCount,
          averagePaymentTimeHours,
        },
        tickets: ticketsData,
      },
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
      },
    };
  },

  /**
   * Reporte de números más jugados
   */
  async getNumbersAnalysis(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    loteriaId?: string;
    betType?: 'NUMERO' | 'REVENTADO' | 'all';
    top?: number;
    includeComparison?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Query optimizada para números más jugados
    const numbersQuery = Prisma.sql`
      SELECT
        j.number,
        SUM(j.amount) as total_amount,
        COUNT(DISTINCT j."ticketId") as tickets_count,
        COUNT(*) as jugadas_count,
        AVG(j.amount) as avg_amount
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
      GROUP BY j.number
      ORDER BY total_amount DESC
      LIMIT ${filters.top || 20}
    `;

    const numbers = await prisma.$queryRaw<Array<{
      number: string;
      total_amount: number;
      tickets_count: number;
      jugadas_count: number;
      avg_amount: number;
    }>>(numbersQuery);

    // Calcular resumen
    const summaryQuery = Prisma.sql`
      SELECT
        COUNT(DISTINCT j.number) as total_numbers_played,
        SUM(j.amount) as total_amount,
        COUNT(DISTINCT j."ticketId") as total_tickets
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
    `;

    const [summary] = await prisma.$queryRaw<Array<{
      total_numbers_played: number;
      total_amount: number;
      total_tickets: number;
    }>>(summaryQuery);

    const numbersData = numbers.map((n, index) => ({
      number: n.number,
      totalAmount: parseFloat(n.total_amount.toString()),
      ticketsCount: parseInt(n.tickets_count.toString()),
      jugadasCount: parseInt(n.jugadas_count.toString()),
      avgAmount: parseFloat(n.avg_amount.toString()),
      rank: index + 1,
    }));

    const topNumber = numbersData[0] || null;

    let previousPeriod: any = null;
    if (filters.includeComparison) {
      const previousRange = calculatePreviousPeriod(dateRange);
      // Implementar comparación con período anterior si es necesario
      // Por ahora, dejamos null
    }

    return {
      data: {
        currentPeriod: {
          from: dateRange.fromString,
          to: dateRange.toString,
          numbers: numbersData,
        },
        ...(previousPeriod && { previousPeriod }),
        summary: {
          totalNumbersPlayed: parseInt(summary?.total_numbers_played?.toString() || '0'),
          totalAmount: parseFloat(summary?.total_amount?.toString() || '0'),
          totalTickets: parseInt(summary?.total_tickets?.toString() || '0'),
          topNumber: topNumber?.number || null,
          topNumberAmount: topNumber?.totalAmount || 0,
        },
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        comparisonEnabled: filters.includeComparison || false,
      },
    };
  },

  /**
   * Reporte de tickets cancelados
   */
  async getCancelledTickets(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    ventanaId?: string;
    vendedorId?: string;
    loteriaId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const { page, pageSize, skip } = normalizePagination(filters.page, filters.pageSize);

    const where: Prisma.TicketWhereInput = {
      status: TicketStatus.CANCELLED,
      // NO filtrar por deletedAt: los tickets cancelados DEBEN tener deletedAt
      createdAt: {
        gte: dateRange.from,
        lte: dateRange.to,
      },
      ...(filters.ventanaId && filters.ventanaId.trim() !== '' && { ventanaId: filters.ventanaId }),
      ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
      ...(filters.loteriaId && filters.loteriaId.trim() !== '' && { loteriaId: filters.loteriaId }),
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

    // Calcular tasa de cancelación (necesitaríamos total de tickets para esto)
    const totalTicketsInPeriod = await prisma.ticket.count({
      where: {
        createdAt: {
          gte: dateRange.from,
          lte: dateRange.to,
        },
      },
    });
    const cancelledRate = totalTicketsInPeriod > 0
      ? calculatePercentage(total, totalTicketsInPeriod)
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

    // Agrupación por ventana
    const byVentanaQuery = Prisma.sql`
      SELECT
        t."ventanaId",
        v.name as ventana_name,
        COUNT(*) as cancelled_count,
        SUM(t."totalAmount") as cancelled_amount
      FROM "Ticket" t
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id
      WHERE t.status = 'CANCELLED'
        AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY t."ventanaId", v.name
    `;

    const byVentana = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_name: string;
      cancelled_count: number;
      cancelled_amount: number;
    }>>(byVentanaQuery);

    return {
      data: {
        summary: {
          totalCancelled: total,
          totalCancelledAmount,
          cancelledRate,
          averageCancelledAmount: parseFloat(averageCancelledAmount.toFixed(2)),
        },
        tickets: ticketsData,
        byVentana: byVentana.map(v => ({
          ventanaId: v.ventanaId,
          ventanaName: v.ventana_name,
          cancelledCount: parseInt(v.cancelled_count.toString()),
          cancelledAmount: parseFloat(v.cancelled_amount.toString()),
        })),
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

