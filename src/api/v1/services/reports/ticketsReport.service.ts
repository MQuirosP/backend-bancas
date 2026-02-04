/**
 * Servicio de reportes de tickets
 */

import { Prisma, TicketStatus, SorteoStatus } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { AppError } from '../../../../core/errors';
import logger from '../../../../core/logger';
import { resolveDateRange, normalizePagination, calculatePercentage, calculatePreviousPeriod, calculateChangePercent } from '../../utils/reports.utils';
import { DateToken, PaymentStatus, PaginationMeta, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';

// Helper para formatear solo fecha YYYY-MM-DD
const formatDateOnly = (date: Date): string => formatIsoLocal(date).split('T')[0];

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
  // Nuevos filtros
  expiredOnly?: boolean;
  minPayout?: number;
  maxPayout?: number;
  betType?: 'NUMERO' | 'REVENTADO' | 'all';
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
    // Nuevos campos
    expiredCount: number;
    expiredAmount: number;
    maxPayout: number;
    maxPayoutTicketId: string | null;
    maxPayoutTicketNumber: string | null;
    byBetType: {
      NUMERO: { count: number; amount: number };
      REVENTADO: { count: number; amount: number };
    };
    payoutDistribution: Array<{
      range: string;
      count: number;
      amount: number;
    }>;
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

    // Determinar qué status de ticket incluir según el filtro de pago
    let ticketStatuses: TicketStatus[];
    if (filters.paymentStatus === 'paid') {
      // Tickets pagados: incluir PAID, PAGADO (y EVALUATED por si tienen remainingAmount=0)
      ticketStatuses = [TicketStatus.EVALUATED, TicketStatus.PAID, TicketStatus.PAGADO];
    } else if (filters.paymentStatus === 'unpaid' || filters.paymentStatus === 'partial') {
      // Tickets pendientes o parciales: solo EVALUATED
      ticketStatuses = [TicketStatus.EVALUATED];
    } else {
      // Todos: incluir todos los status relevantes
      ticketStatuses = [TicketStatus.EVALUATED, TicketStatus.PAID, TicketStatus.PAGADO];
    }

    // Construir filtros WHERE
    const where: Prisma.TicketWhereInput = {
      isWinner: true,
      isActive: true,
      deletedAt: null,
      status: { in: ticketStatuses },
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

    // Filtro por montos de payout
    if (filters.minPayout !== undefined) {
      where.totalPayout = { ...((where.totalPayout as any) || {}), gte: filters.minPayout };
    }
    if (filters.maxPayout !== undefined) {
      where.totalPayout = { ...((where.totalPayout as any) || {}), lte: filters.maxPayout };
    }

    // Filtro expiredOnly: tickets >24h sin pagar completamente
    if (filters.expiredOnly) {
      const expiredThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
      where.remainingAmount = { gt: 0 };
      where.sorteo = {
        status: 'EVALUATED',
        updatedAt: { lt: expiredThreshold },
      };
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
        id: true,
        ticketNumber: true,
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
    let expiredCount = 0;
    let expiredAmount = 0;
    let maxPayoutValue = 0;
    let maxPayoutTicketId: string | null = null;
    let maxPayoutTicketNumber: string | null = null;
    const paymentTimes: number[] = [];

    // Distribución de premios por rangos (rangos más útiles para el negocio)
    const payoutRanges = {
      '0-500': { count: 0, amount: 0 },
      '500-2000': { count: 0, amount: 0 },
      '2000-5000': { count: 0, amount: 0 },
      '5000-15000': { count: 0, amount: 0 },
      '15000-50000': { count: 0, amount: 0 },
      '50000+': { count: 0, amount: 0 },
    };

    const now = new Date();
    const EXPIRED_HOURS = 24;

    summaryTickets.forEach(ticket => {
      const payout = ticket.totalPayout || 0;
      const paid = ticket.totalPaid || 0;
      const pending = ticket.remainingAmount || 0;

      totalPayout += payout;
      totalPaid += paid;
      totalPending += pending;

      // Track max payout
      if (payout > maxPayoutValue) {
        maxPayoutValue = payout;
        maxPayoutTicketId = ticket.id;
        maxPayoutTicketNumber = ticket.ticketNumber;
      }

      // Calcular distribución de premios (rangos más granulares)
      if (payout > 0) {
        if (payout <= 500) {
          payoutRanges['0-500'].count++;
          payoutRanges['0-500'].amount += payout;
        } else if (payout <= 2000) {
          payoutRanges['500-2000'].count++;
          payoutRanges['500-2000'].amount += payout;
        } else if (payout <= 5000) {
          payoutRanges['2000-5000'].count++;
          payoutRanges['2000-5000'].amount += payout;
        } else if (payout <= 15000) {
          payoutRanges['5000-15000'].count++;
          payoutRanges['5000-15000'].amount += payout;
        } else if (payout <= 50000) {
          payoutRanges['15000-50000'].count++;
          payoutRanges['15000-50000'].amount += payout;
        } else {
          payoutRanges['50000+'].count++;
          payoutRanges['50000+'].amount += payout;
        }
      }

      if (paid > 0 && pending > 0) {
        partialPaymentsCount++;
      } else if (paid <= 0) {
        unpaidCount++;
      }

      // Calcular tiempo de pago y expiración
      const evaluatedAt = ticket.sorteo?.status === 'EVALUATED' ? ticket.sorteo.updatedAt : null;
      if (evaluatedAt) {
        // Calcular si está expirado (>24h sin pagar completamente)
        if (pending > 0) {
          const hoursSinceEval = (now.getTime() - evaluatedAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceEval > EXPIRED_HOURS) {
            expiredCount++;
            expiredAmount += pending;
          }
        }

        // Calcular tiempo promedio de pago
        if (ticket.lastPaymentAt) {
          const hours = (ticket.lastPaymentAt.getTime() - evaluatedAt.getTime()) / (1000 * 60 * 60);
          if (hours > 0) {
            paymentTimes.push(hours);
          }
        }
      }
    });

    const averagePaymentTimeHours = paymentTimes.length > 0
      ? parseFloat((paymentTimes.reduce((a, b) => a + b, 0) / paymentTimes.length).toFixed(2))
      : null;

    // Calcular distribución por tipo de apuesta
    const byBetTypeQuery = Prisma.sql`
      SELECT
        j.type,
        COUNT(DISTINCT t.id) as count,
        SUM(j.payout) as amount
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."isWinner" = true
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
        AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        AND j."isWinner" = true
        AND j."deletedAt" IS NULL
        ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY j.type
    `;

    const byBetTypeRaw = await prisma.$queryRaw<Array<{
      type: string;
      count: bigint;
      amount: number | null;
    }>>(byBetTypeQuery);

    const byBetType = {
      NUMERO: { count: 0, amount: 0 },
      REVENTADO: { count: 0, amount: 0 },
    };

    byBetTypeRaw.forEach(row => {
      if (row.type === 'NUMERO') {
        byBetType.NUMERO.count = parseInt(row.count.toString());
        byBetType.NUMERO.amount = parseFloat(row.amount?.toString() || '0');
      } else if (row.type === 'REVENTADO') {
        byBetType.REVENTADO.count = parseInt(row.count.toString());
        byBetType.REVENTADO.amount = parseFloat(row.amount?.toString() || '0');
      }
    });

    const payoutDistribution = Object.entries(payoutRanges).map(([range, data]) => ({
      range,
      count: data.count,
      amount: data.amount,
    }));

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
          // Nuevos campos
          expiredCount,
          expiredAmount,
          maxPayout: maxPayoutValue,
          maxPayoutTicketId,
          maxPayoutTicketNumber,
          byBetType,
          payoutDistribution,
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
    includeWinners?: boolean;
    includeExposure?: boolean;
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

    const DEFAULT_MULTIPLIER = 30;

    // Si se incluye exposure, calcular exposición por número
    let numbersWithExposure: any[] = [];
    let totalExposure = 0;
    let highRiskNumbers = 0;

    if (filters.includeExposure) {
      const exposureQuery = Prisma.sql`
        SELECT
          j.number,
          SUM(j.amount) as total_amount,
          AVG(j."finalMultiplierX") as avg_multiplier
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
      `;

      const exposureData = await prisma.$queryRaw<Array<{
        number: string;
        total_amount: number;
        avg_multiplier: number | null;
      }>>(exposureQuery);

      const exposureMap = new Map(exposureData.map(e => [
        e.number,
        {
          exposure: parseFloat(e.total_amount.toString()) * parseFloat(e.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString()),
          multiplier: parseFloat(e.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString()),
        },
      ]));

      numbersWithExposure = numbers.map(n => {
        const expData = exposureMap.get(n.number);
        const exposure = expData?.exposure || 0;
        totalExposure += exposure;
        if (exposure > 100000) highRiskNumbers++;
        return {
          number: n.number,
          exposure,
        };
      });
    }

    // Números ganadores (hot/cold numbers) si se solicita
    let hotNumbers: any[] = [];
    let coldNumbers: any[] = [];

    if (filters.includeWinners) {
      // Hot numbers: números que más han ganado
      const hotNumbersQuery = Prisma.sql`
        SELECT
          s."winningNumber" as number,
          COUNT(*) as times_won,
          MAX(s."updatedAt") as last_won_date
        FROM "Sorteo" s
        WHERE s."winningNumber" IS NOT NULL
          AND s.status = 'EVALUATED'
          AND s."deletedAt" IS NULL
          ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        GROUP BY s."winningNumber"
        ORDER BY times_won DESC
        LIMIT 10
      `;

      const hotNumbersRaw = await prisma.$queryRaw<Array<{
        number: string;
        times_won: bigint;
        last_won_date: Date;
      }>>(hotNumbersQuery);

      hotNumbers = hotNumbersRaw.map(h => ({
        number: h.number,
        timesWon: parseInt(h.times_won.toString()),
        lastWonDate: h.last_won_date ? formatDateOnly(h.last_won_date) : null,
      }));

      // Cold numbers: números sin ganar hace mucho tiempo
      const coldNumbersQuery = Prisma.sql`
        WITH all_numbers AS (
          SELECT DISTINCT j.number
          FROM "Jugada" j
          INNER JOIN "Ticket" t ON j."ticketId" = t.id
          WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        ),
        last_wins AS (
          SELECT
            s."winningNumber" as number,
            MAX(s."updatedAt") as last_won_date
          FROM "Sorteo" s
          WHERE s."winningNumber" IS NOT NULL
            AND s.status = 'EVALUATED'
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
          GROUP BY s."winningNumber"
        )
        SELECT
          an.number,
          lw.last_won_date,
          EXTRACT(DAY FROM NOW() - COALESCE(lw.last_won_date, '2000-01-01'::timestamp)) as days_since_last_win
        FROM all_numbers an
        LEFT JOIN last_wins lw ON an.number = lw.number
        ORDER BY days_since_last_win DESC
        LIMIT 10
      `;

      const coldNumbersRaw = await prisma.$queryRaw<Array<{
        number: string;
        last_won_date: Date | null;
        days_since_last_win: number;
      }>>(coldNumbersQuery);

      coldNumbers = coldNumbersRaw.map(c => ({
        number: c.number,
        daysSinceLastWin: parseInt(c.days_since_last_win?.toString() || '0'),
        lastWonDate: c.last_won_date ? formatDateOnly(c.last_won_date) : null,
      }));
    }

    // Crear mapa de datos de ganadores para enriquecer numbersData
    const winnerDataMap = new Map<string, { timesWon: number; lastWonDate: string | null }>();
    hotNumbers.forEach(h => {
      winnerDataMap.set(h.number, { timesWon: h.timesWon, lastWonDate: h.lastWonDate });
    });

    const exposureMap = new Map(numbersWithExposure.map(n => [n.number, n.exposure]));

    const numbersData = numbers.map((n, index) => ({
      number: n.number,
      totalAmount: parseFloat(n.total_amount.toString()),
      ticketsCount: parseInt(n.tickets_count.toString()),
      jugadasCount: parseInt(n.jugadas_count.toString()),
      avgAmount: parseFloat(n.avg_amount.toString()),
      rank: index + 1,
      // Campos adicionales si se solicitan
      ...(filters.includeExposure && {
        exposure: exposureMap.get(n.number) || 0,
      }),
      ...(filters.includeWinners && {
        timesWon: winnerDataMap.get(n.number)?.timesWon || 0,
        lastWonDate: winnerDataMap.get(n.number)?.lastWonDate || null,
      }),
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
        ...(filters.includeWinners && { hotNumbers, coldNumbers }),
        summary: {
          totalNumbersPlayed: parseInt(summary?.total_numbers_played?.toString() || '0'),
          totalAmount: parseFloat(summary?.total_amount?.toString() || '0'),
          totalTickets: parseInt(summary?.total_tickets?.toString() || '0'),
          topNumber: topNumber?.number || null,
          topNumberAmount: topNumber?.totalAmount || 0,
          ...(filters.includeExposure && {
            totalExposure,
            highRiskNumbers,
          }),
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

    const byVentanaRaw = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_name: string;
      cancelled_count: bigint;
      cancelled_amount: number;
    }>>(byVentanaQuery);

    // Calcular tasa de cancelación por ventana
    const byVentana = await Promise.all(byVentanaRaw.map(async (v) => {
      const ventanaTotalTickets = await prisma.ticket.count({
        where: {
          ventanaId: v.ventanaId,
          createdAt: { gte: dateRange.from, lte: dateRange.to },
        },
      });
      const cancelledCount = parseInt(v.cancelled_count.toString());
      const cancelledRate = ventanaTotalTickets > 0
        ? calculatePercentage(cancelledCount, ventanaTotalTickets)
        : 0;

      return {
        ventanaId: v.ventanaId,
        ventanaName: v.ventana_name,
        cancelledCount,
        cancelledAmount: parseFloat(v.cancelled_amount?.toString() || '0'),
        cancelledRate,
        totalTickets: ventanaTotalTickets,
      };
    }));

    // Agrupación por vendedor
    const byVendedorQuery = Prisma.sql`
      SELECT
        t."vendedorId",
        u.name as vendedor_name,
        v.name as ventana_name,
        COUNT(*) as cancelled_count,
        SUM(t."totalAmount") as cancelled_amount
      FROM "Ticket" t
      INNER JOIN "User" u ON t."vendedorId" = u.id
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id
      WHERE t.status = 'CANCELLED'
        AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY t."vendedorId", u.name, v.name
      ORDER BY cancelled_count DESC
    `;

    const byVendedorRaw = await prisma.$queryRaw<Array<{
      vendedorId: string;
      vendedor_name: string;
      ventana_name: string;
      cancelled_count: bigint;
      cancelled_amount: number;
    }>>(byVendedorQuery);

    // Calcular tasa de cancelación por vendedor
    const byVendedor = await Promise.all(byVendedorRaw.map(async (v) => {
      const vendedorTotalTickets = await prisma.ticket.count({
        where: {
          vendedorId: v.vendedorId,
          createdAt: { gte: dateRange.from, lte: dateRange.to },
        },
      });
      const cancelledCount = parseInt(v.cancelled_count.toString());
      const cancelledRate = vendedorTotalTickets > 0
        ? calculatePercentage(cancelledCount, vendedorTotalTickets)
        : 0;

      return {
        vendedorId: v.vendedorId,
        vendedorName: v.vendedor_name,
        ventanaName: v.ventana_name,
        cancelledCount,
        cancelledAmount: parseFloat(v.cancelled_amount.toString()),
        cancelledRate,
      };
    }));

    // Agrupación por lotería
    const byLoteriaQuery = Prisma.sql`
      SELECT
        t."loteriaId",
        l.name as loteria_name,
        COUNT(*) as cancelled_count,
        SUM(t."totalAmount") as cancelled_amount
      FROM "Ticket" t
      INNER JOIN "Loteria" l ON t."loteriaId" = l.id
      WHERE t.status = 'CANCELLED'
        AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
        ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY t."loteriaId", l.name
      ORDER BY cancelled_count DESC
    `;

    const byLoteriaRaw = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteria_name: string;
      cancelled_count: bigint;
      cancelled_amount: number;
    }>>(byLoteriaQuery);

    // Calcular tasa de cancelación por lotería
    const byLoteria = await Promise.all(byLoteriaRaw.map(async (l) => {
      const loteriaTotalTickets = await prisma.ticket.count({
        where: {
          loteriaId: l.loteriaId,
          createdAt: { gte: dateRange.from, lte: dateRange.to },
        },
      });
      const cancelledCount = parseInt(l.cancelled_count.toString());
      const cancelledRate = loteriaTotalTickets > 0
        ? calculatePercentage(cancelledCount, loteriaTotalTickets)
        : 0;

      return {
        loteriaId: l.loteriaId,
        loteriaName: l.loteria_name,
        cancelledCount,
        cancelledAmount: parseFloat(l.cancelled_amount.toString()),
        cancelledRate,
      };
    }));

    return {
      data: {
        summary: {
          totalCancelled: total,
          totalCancelledAmount,
          cancelledRate,
          averageCancelledAmount: parseFloat(averageCancelledAmount.toFixed(2)),
          averageTimeToCancel, // minutos promedio
          byTimeRange,
        },
        tickets: ticketsData,
        byVentana,
        byVendedor,
        byLoteria,
      },
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  /**
   * Reporte de exposición y riesgo por número
   * CRÍTICO: Para gestión de riesgo financiero
   */
  async getExposure(filters: {
    sorteoId: string;
    loteriaId?: string;
    top?: number;
    minExposure?: number;
  }): Promise<any> {
    // Obtener información del sorteo
    const sorteo = await prisma.sorteo.findUnique({
      where: { id: filters.sorteoId },
      include: {
        loteria: { select: { id: true, name: true } },
      },
    });

    if (!sorteo) {
      throw new AppError('Sorteo no encontrado', 404);
    }

    const top = filters.top || 20;
    const DEFAULT_MULTIPLIER = 30;

    // Query para obtener exposición por número (consolidado, sin duplicados)
    const numbersQuery = Prisma.sql`
      SELECT
        j.number,
        SUM(j.amount) as total_amount,
        COUNT(DISTINCT j."ticketId") as tickets_count,
        COUNT(*) as jugadas_count,
        COALESCE(AVG(j."finalMultiplierX"), ${DEFAULT_MULTIPLIER}) as avg_multiplier
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."sorteoId" = ${filters.sorteoId}::uuid
        AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND j."isActive" = true
        ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY j.number
      ORDER BY total_amount DESC
    `;

    const numbersRaw = await prisma.$queryRaw<Array<{
      number: string;
      total_amount: number;
      tickets_count: bigint;
      jugadas_count: bigint;
      avg_multiplier: number;
    }>>(numbersQuery);

    // Calcular totales
    const totalVentas = numbersRaw.reduce((sum, n) => sum + parseFloat(n.total_amount.toString()), 0);
    let totalExposure = 0;
    let highRiskNumbers = 0;

    // Procesar números y calcular exposición
    const numbersData = numbersRaw.map(n => {
      const totalAmount = parseFloat(n.total_amount.toString());
      const multiplier = parseFloat(n.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString());
      const exposure = totalAmount * multiplier;
      totalExposure += exposure;

      // Determinar nivel de riesgo basado en concentración
      const percentOfTotal = totalVentas > 0 ? (totalAmount / totalVentas) * 100 : 0;
      let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
      if (percentOfTotal > 15) {
        riskLevel = 'critical';
        highRiskNumbers++;
      } else if (percentOfTotal > 10) {
        riskLevel = 'high';
        highRiskNumbers++;
      } else if (percentOfTotal > 5) {
        riskLevel = 'medium';
      }

      return {
        number: n.number,
        totalAmount,
        ticketsCount: parseInt(n.tickets_count.toString()),
        jugadasCount: parseInt(n.jugadas_count.toString()),
        exposure,
        multiplier: parseFloat(multiplier.toFixed(2)),
        percentOfTotal: parseFloat(percentOfTotal.toFixed(2)),
        riskLevel,
      };
    });

    // Filtrar por exposición mínima si se especifica
    let filteredNumbers = numbersData;
    if (filters.minExposure) {
      filteredNumbers = numbersData.filter(n => n.exposure >= filters.minExposure!);
    }

    // Limitar al top solicitado
    const topNumbers = filteredNumbers.slice(0, top);

    // Generar alertas
    const alerts: Array<{
      type: string;
      number: string;
      message: string;
      severity: 'info' | 'warning' | 'critical';
    }> = [];

    numbersData.forEach(n => {
      if (n.percentOfTotal > 10) {
        alerts.push({
          type: 'HIGH_CONCENTRATION',
          number: n.number,
          message: `El número ${n.number} tiene el ${n.percentOfTotal.toFixed(1)}% de las ventas totales`,
          severity: n.percentOfTotal > 15 ? 'critical' : 'warning',
        });
      }
    });

    // Agrupación por ventana
    const byVentanaQuery = Prisma.sql`
      SELECT
        t."ventanaId",
        v.name as ventana_name,
        SUM(j.amount) as total_amount,
        SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER})) as exposure
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id
      WHERE t."sorteoId" = ${filters.sorteoId}::uuid
        AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND j."isActive" = true
      GROUP BY t."ventanaId", v.name
      ORDER BY exposure DESC
    `;

    const byVentanaRaw = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_name: string;
      total_amount: number;
      exposure: number;
    }>>(byVentanaQuery);

    // Obtener número top por ventana
    const byVentana = await Promise.all(byVentanaRaw.map(async (v) => {
      const topNumberQuery = Prisma.sql`
        SELECT j.number, SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER})) as exposure
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."sorteoId" = ${filters.sorteoId}::uuid
          AND t."ventanaId" = ${v.ventanaId}::uuid
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
        GROUP BY j.number
        ORDER BY exposure DESC
        LIMIT 1
      `;

      const [topNum] = await prisma.$queryRaw<Array<{ number: string; exposure: number }>>(topNumberQuery);

      return {
        ventanaId: v.ventanaId,
        ventanaName: v.ventana_name,
        ventas: parseFloat(v.total_amount.toString()),
        exposure: parseFloat(v.exposure.toString()),
        topNumber: topNum?.number || null,
        topNumberExposure: topNum ? parseFloat(topNum.exposure.toString()) : 0,
      };
    }));

    return {
      data: {
        sorteo: {
          id: sorteo.id,
          name: sorteo.name,
          loteriaId: sorteo.loteriaId,
          loteriaName: sorteo.loteria.name,
          scheduledAt: formatIsoLocal(sorteo.scheduledAt),
          status: sorteo.status,
        },
        summary: {
          totalVentas,
          totalExposure,
          maxPotentialPayout: totalExposure,
          highRiskNumbers,
          averageExposurePerNumber: numbersData.length > 0 ? totalExposure / numbersData.length : 0,
        },
        numbers: topNumbers,
        alerts,
        byVentana,
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    };
  },

  /**
   * Reporte de rentabilidad y márgenes
   */
  async getProfitability(filters: {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  loteriaId?: string;
  includeComparison?: boolean;
  groupBy?: 'day' | 'week' | 'month';
}): Promise<any> {
  const dateRange = resolveDateRange(
    filters.date || 'today',
    filters.fromDate,
    filters.toDate
  );

  // Helper: createdAt siempre evaluado en horario Costa Rica
  const createdAtCR = Prisma.sql`
    (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
  `;

  // ===============================
  // MÉTRICAS PRINCIPALES (RESUMEN)
  // ===============================
  const metricsQuery = Prisma.sql`
    SELECT
      SUM(t."totalAmount") as total_ventas,
      SUM(COALESCE(t."totalPayout", 0)) as total_premios,
      COUNT(*) as tickets_count,
      COUNT(CASE WHEN t."isWinner" = true THEN 1 END) as tickets_ganadores
    FROM "Ticket" t
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    WHERE ${createdAtCR} BETWEEN ${dateRange.from} AND ${dateRange.to}
      AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
      ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
  `;

  const [metrics] = await prisma.$queryRaw<Array<{
    total_ventas: number | null;
    total_premios: number | null;
    tickets_count: bigint;
    tickets_ganadores: bigint;
  }>>(metricsQuery);

  // ===============================
  // COMISIONES DE LISTERO
  // ===============================
  const comisionesQuery = Prisma.sql`
    SELECT SUM(j."listeroCommissionAmount") as total_comisiones
    FROM "Jugada" j
    INNER JOIN "Ticket" t ON j."ticketId" = t.id
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    WHERE ${createdAtCR} BETWEEN ${dateRange.from} AND ${dateRange.to}
      AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND j."isActive" = true
      AND j."deletedAt" IS NULL
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
      ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
  `;

  const [comisiones] = await prisma.$queryRaw<Array<{ total_comisiones: number | null }>>(comisionesQuery);

  // ===============================
  // PARSEOS
  // ===============================
  const totalVentas = Number(metrics?.total_ventas ?? 0);
  const totalPremios = Number(metrics?.total_premios ?? 0);
  const totalComisiones = Number(comisiones?.total_comisiones ?? 0);
  const ticketsCount = Number(metrics?.tickets_count ?? 0);
  const ticketsGanadores = Number(metrics?.tickets_ganadores ?? 0);

  const margenBruto = totalVentas - totalPremios;
  const margenNeto = margenBruto - totalComisiones;

  const summary = {
    totalVentas,
    totalPremios,
    totalComisiones,
    margenBruto,
    margenNeto,
    porcentajeRetorno: totalVentas > 0 ? +(totalPremios / totalVentas * 100).toFixed(2) : 0,
    porcentajeMargen: totalVentas > 0 ? +(margenNeto / totalVentas * 100).toFixed(2) : 0,
    ticketsCount,
    ticketsGanadores,
    tasaGanadores: ticketsCount > 0 ? +(ticketsGanadores / ticketsCount * 100).toFixed(2) : 0,
  };

  // ===============================
  // TENDENCIA
  // ===============================
  let trend: any[] = [];
  if (filters.groupBy) {
    const truncFunc = Prisma.raw(`'${filters.groupBy}'`);

    const trendQuery = Prisma.sql`
      SELECT
        DATE_TRUNC(${truncFunc}, ${createdAtCR}) as period,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE ${createdAtCR} BETWEEN ${dateRange.from} AND ${dateRange.to}
        AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND s.status = 'EVALUATED'
        AND s."deletedAt" IS NULL
        ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      GROUP BY DATE_TRUNC(${truncFunc}, ${createdAtCR})
      ORDER BY period ASC
    `;

    const rows = await prisma.$queryRaw<any[]>(trendQuery);

    trend = rows.map(r => {
      const ventas = Number(r.ventas ?? 0);
      const premios = Number(r.premios ?? 0);
      return {
        period: formatDateOnly(r.period),
        ventas,
        premios,
        margenBruto: ventas - premios,
      };
    });
  }

  // ===============================
  // POR LOTERÍA (SOLO SORTEOS EVALUADOS)
  // ===============================
  const byLoteriaQuery = Prisma.sql`
    SELECT
      t."loteriaId",
      l.name as loteria_name,
      SUM(t."totalAmount") as ventas,
      SUM(COALESCE(t."totalPayout", 0)) as premios
    FROM "Ticket" t
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    INNER JOIN "Loteria" l ON t."loteriaId" = l.id
    WHERE ${createdAtCR} BETWEEN ${dateRange.from} AND ${dateRange.to}
      AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
      ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
    GROUP BY t."loteriaId", l.name
    ORDER BY ventas DESC
  `;

  const byLoteriaRaw = await prisma.$queryRaw<any[]>(byLoteriaQuery);

  const byLoteria = byLoteriaRaw.map(l => {
    const ventas = Number(l.ventas ?? 0);
    const premios = Number(l.premios ?? 0);
    const margenBruto = ventas - premios;

    return {
      loteriaId: l.loteriaId,
      loteriaName: l.loteria_name,
      ventas,
      premios,
      margenBruto,
      porcentajeMargen: ventas > 0 ? +(margenBruto / ventas * 100).toFixed(2) : 0,
    };
  });

  return {
    data: {
      summary,
      ...(trend.length && { trend }),
      byLoteria,
    },
    meta: {
      dateRange: {
        from: dateRange.fromString,
        to: dateRange.toString,
      },
    },
  };
},


  /**
   * Reporte de análisis por hora y día de semana
   */
  async getTimeAnalysis(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    ventanaId?: string;
    loteriaId?: string;
    metric?: 'ventas' | 'tickets' | 'cancelaciones';
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const metric = filters.metric || 'ventas';
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    // Filtro base para tickets válidos (mismas condiciones que accounts)
    // - t."deletedAt" IS NULL
    // - t."isActive" = true
    // - t.status IN ('EVALUATED', 'PAID', 'PAGADO')
    // - s.status = 'EVALUATED' (sorteo evaluado)
    // - s."deletedAt" IS NULL
    const validTicketFilter = Prisma.sql`
      AND t."deletedAt" IS NULL
      AND t."isActive" = true
      AND t.status IN ('EVALUATED', 'PAID', 'PAGADO')
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
    `;

    // Para cancelaciones: tickets cancelados (sin filtro de sorteo)
    const cancelledTicketFilter = Prisma.sql`AND t.status = 'CANCELLED'`;

    // Por hora (convertir a hora local de Costa Rica)
    const byHourQuery = metric === 'cancelaciones'
      ? Prisma.sql`
          SELECT
            EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
            ${cancelledTicketFilter}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
          GROUP BY EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
          ORDER BY hour ASC
        `
      : Prisma.sql`
          SELECT
            EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
            ${validTicketFilter}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
          GROUP BY EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
          ORDER BY hour ASC
        `;

    const byHourRaw = await prisma.$queryRaw<Array<{
      hour: number;
      count: bigint;
      amount: number;
    }>>(byHourQuery);

    // Crear array completo de 24 horas
    const byHour = Array.from({ length: 24 }, (_, i) => {
      const hourData = byHourRaw.find(h => Number(h.hour) === i);
      return {
        hour: i,
        count: hourData ? parseInt(hourData.count.toString()) : 0,
        amount: hourData ? parseFloat(hourData.amount?.toString() || '0') : 0,
      };
    });

    // Por día de semana (convertir a hora local de Costa Rica)
    const byDayQuery = metric === 'cancelaciones'
      ? Prisma.sql`
          SELECT
            EXTRACT(DOW FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as day,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
            ${cancelledTicketFilter}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
          GROUP BY EXTRACT(DOW FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
          ORDER BY day ASC
        `
      : Prisma.sql`
          SELECT
            EXTRACT(DOW FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as day,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
            ${validTicketFilter}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
          GROUP BY EXTRACT(DOW FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
          ORDER BY day ASC
        `;

    const byDayRaw = await prisma.$queryRaw<Array<{
      day: number;
      count: bigint;
      amount: number;
    }>>(byDayQuery);

    // Crear array completo de 7 días (los días fuera del rango tendrán 0)
    const byDayOfWeek = Array.from({ length: 7 }, (_, i) => {
      const dayData = byDayRaw.find(d => Number(d.day) === i);
      return {
        day: i,
        dayName: dayNames[i],
        count: dayData ? parseInt(dayData.count.toString()) : 0,
        amount: dayData ? parseFloat(dayData.amount?.toString() || '0') : 0,
      };
    });

    // Calcular picos
    const peakHourData = byHour.reduce((max, h) => h.amount > max.amount ? h : max, byHour[0]);
    const peakDayData = byDayOfWeek.reduce((max, d) => d.amount > max.amount ? d : max, byDayOfWeek[0]);

    const totalAmount = byHour.reduce((sum, h) => sum + h.amount, 0);
    const totalCount = byHour.reduce((sum, h) => sum + h.count, 0);
    const daysWithData = byDayOfWeek.filter(d => d.count > 0).length;

    const summary = {
      peakHour: peakHourData.hour,
      peakHourAmount: peakHourData.amount,
      peakDay: peakDayData.day,
      peakDayName: peakDayData.dayName,
      peakDayAmount: peakDayData.amount,
      averagePerHour: totalAmount / 24,
      averagePerDay: daysWithData > 0 ? totalAmount / daysWithData : 0,
      totalAmount,
      totalCount,
      daysWithData,
    };

    // Datos de cancelaciones si la métrica principal no es cancelaciones
    let cancellations = null;
    if (metric !== 'cancelaciones') {
      // Cancelaciones por hora (convertir a hora local de Costa Rica)
      const cancelByHourQuery = Prisma.sql`
        SELECT
          EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
          AND t.status = 'CANCELLED'
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        GROUP BY EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
        ORDER BY hour ASC
      `;

      const cancelByHourRaw = await prisma.$queryRaw<Array<{
        hour: number;
        count: bigint;
        amount: number;
      }>>(cancelByHourQuery);

      const cancelByHour = cancelByHourRaw.map(h => ({
        hour: Number(h.hour),
        count: parseInt(h.count.toString()),
        amount: parseFloat(h.amount?.toString() || '0'),
      }));

      const cancelPeak = cancelByHour.reduce((max, h) => h.count > max.count ? h : max, cancelByHour[0] || { hour: 0, count: 0, amount: 0 });
      const cancelTotalCount = cancelByHour.reduce((sum, h) => sum + h.count, 0);
      const cancelTotalAmount = cancelByHour.reduce((sum, h) => sum + h.amount, 0);

      cancellations = {
        byHour: cancelByHour,
        peakHour: cancelPeak.hour,
        totalCount: cancelTotalCount,
        totalAmount: cancelTotalAmount,
      };
    }

    return {
      data: {
        byHour,
        byDayOfWeek,
        summary,
        ...(cancellations && { cancellations }),
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        metric,
      },
    };
  },
};

