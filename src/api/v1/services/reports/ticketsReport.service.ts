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

/**
 * Determina qué desgloses incluir según los filtros aplicados.
 * Regla:
 *  - byLoteria:  cuando NO hay loteriaId
 *  - bySorteo:   cuando SÍ hay loteriaId
 *  - byVentana:  cuando NO hay ventanaId Y NO hay vendedorId
 *  - byVendedor: cuando NO hay vendedorId Y SÍ hay ventanaId
 */
function resolveBreakdowns(filters: { loteriaId?: string; ventanaId?: string; vendedorId?: string }) {
  const hasLoteria = !!(filters.loteriaId && filters.loteriaId.trim() !== '');
  const hasVentana = !!(filters.ventanaId && filters.ventanaId.trim() !== '');
  const hasVendedor = !!(filters.vendedorId && filters.vendedorId.trim() !== '');

  return {
    includeLoteria: !hasLoteria,
    includeSorteo: hasLoteria,
    includeVentana: !hasVentana && !hasVendedor,
    includeVendedor: !hasVendedor && hasVentana,
  };
}

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
  bancaId?: string;
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
      businessDate: {
        gte: new Date(dateRange.fromString),
        lte: new Date(dateRange.toString),
      },
      ...(filters.ventanaId && filters.ventanaId.trim() !== '' && { ventanaId: filters.ventanaId }),
      ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
      ...(filters.loteriaId && filters.loteriaId.trim() !== '' && { loteriaId: filters.loteriaId }),
      ...(filters.bancaId && filters.bancaId.trim() !== '' && { bancaId: filters.bancaId }),
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
    // Optimización: Incluir metadatos de pagos directamente en la consulta principal (Query 2 de 4)
    const tickets = await prisma.ticket.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: [
        { createdAt: 'desc' },
      ],
      select: {
        id: true,
        ticketNumber: true,
        createdAt: true,
        totalAmount: true,
        totalPayout: true,
        totalPaid: true,
        remainingAmount: true,
        loteriaId: true,
        sorteoId: true,
        ventanaId: true,
        vendedorId: true,
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
        // Obtener metadatos de pagos sin query extra
        _count: {
          select: { TicketPayment: { where: { isReversed: false } } }
        },
        TicketPayment: {
          where: { isReversed: false },
          select: { paymentDate: true },
          orderBy: { paymentDate: 'desc' },
          take: 1
        }
      },
    });

    // Mapear pagos de los 20 tickets procesados
    const paymentsMap = new Map(
      tickets.map(t => [
        t.id,
        {
          count: t._count.TicketPayment,
          lastPaymentAt: t.TicketPayment[0]?.paymentDate || null,
        },
      ])
    );

    // FASE 3: Obtener RESUMEN consolidado en SQL (Query 3 de 4)
    // Evita cargar miles de tiquetes en memoria (antes findMany masivo + loop JS)
    const expiredThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Construir fragmentos SQL para filtros compartidos
    const summaryBaseWhere = Prisma.sql`
      t."isWinner" = true
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND t."status"::text IN (${Prisma.join(ticketStatuses)})
      AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
      ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
      ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
      ${filters.paymentStatus === 'paid' ? Prisma.sql`AND t."remainingAmount" <= 0` : Prisma.empty}
      ${filters.paymentStatus === 'partial' ? Prisma.sql`AND t."remainingAmount" > 0 AND t."totalPaid" > 0` : Prisma.empty}
      ${filters.paymentStatus === 'unpaid' ? Prisma.sql`AND t."totalPaid" <= 0` : Prisma.empty}
      ${filters.minPayout !== undefined ? Prisma.sql`AND t."totalPayout" >= ${filters.minPayout}` : Prisma.empty}
      ${filters.maxPayout !== undefined ? Prisma.sql`AND t."totalPayout" <= ${filters.maxPayout}` : Prisma.empty}
    `;

    const summaryQuery = Prisma.sql`
      WITH filtered AS MATERIALIZED (
        SELECT
          t.id,
          t."ticketNumber",
          t."totalPayout",
          t."totalPaid",
          t."remainingAmount",
          t."lastPaymentAt",
          s.status          AS sorteo_status,
          s."updatedAt"     AS sorteo_updated_at
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE \${summaryBaseWhere}
      )
      SELECT
        COUNT(*)::int AS total_winning_tickets,
        SUM(COALESCE("totalPayout", 0))::float AS total_payout,
        SUM(COALESCE("totalPaid", 0))::float AS total_paid,
        SUM(COALESCE("remainingAmount", 0))::float AS total_pending,
        COUNT(*) FILTER (WHERE "totalPaid" > 0 AND "remainingAmount" > 0)::int AS partial_payments_count,
        COUNT(*) FILTER (WHERE COALESCE("totalPaid", 0) <= 0)::int AS unpaid_count,
        MAX("totalPayout")::float AS max_payout_value,
        (
          SELECT json_build_object('id', id, 'ticketNumber', "ticketNumber")
          FROM filtered
          WHERE "totalPayout" = (SELECT MAX("totalPayout") FROM filtered)
          LIMIT 1
        ) AS max_payout_ticket,
        COUNT(*) FILTER (WHERE "remainingAmount" > 0 AND sorteo_status = 'EVALUATED' AND sorteo_updated_at < ${expiredThreshold})::int AS expired_count,
        SUM(COALESCE("remainingAmount", 0)) FILTER (WHERE "remainingAmount" > 0 AND sorteo_status = 'EVALUATED' AND sorteo_updated_at < ${expiredThreshold})::float AS expired_amount,
        AVG(EXTRACT(EPOCH FROM ("lastPaymentAt" - sorteo_updated_at)) / 3600) FILTER (WHERE "lastPaymentAt" IS NOT NULL AND sorteo_status = 'EVALUATED' AND "lastPaymentAt" > sorteo_updated_at)::float AS avg_payment_time
      FROM filtered
    `;

    const [summaryResult] = await prisma.$queryRaw<any[]>(summaryQuery);
    
    // Variables de apoyo mapeadas desde el resultado
    const maxPayoutTicket = summaryResult?.max_payout_ticket;

    const payoutDistribution: any[] = [];

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

    // FASE 4: Obtener DESGLOSES consolidados (Query 4 de 4)
    // Combina todas las dimensiones en una sola consulta SQL para minimizar conexiones
    const breakdownsQuery = Prisma.sql`
      WITH filtered_tickets AS MATERIALIZED (
        SELECT t.id, t."sorteoId", t."loteriaId", t."ventanaId", t."vendedorId", t."totalPayout", t."totalPaid", t."remainingAmount"
        FROM "Ticket" t
        WHERE \${summaryBaseWhere}
      ),
      desglose_sorteo AS (
        SELECT
          t."sorteoId", s.name, 
          COUNT(*)::int as count,
          SUM(t."totalPayout")::float as total_payout,
          SUM(t."totalPaid")::float as total_paid,
          SUM(t."remainingAmount")::float as total_pending
        FROM filtered_tickets t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        GROUP BY t."sorteoId", s.name
      ),
      desglose_loteria AS (
        SELECT
          t."loteriaId", l.name, 
          COUNT(*)::int as count,
          SUM(t."totalPayout")::float as total_payout,
          SUM(t."totalPaid")::float as total_paid,
          SUM(t."remainingAmount")::float as total_pending
        FROM filtered_tickets t
        INNER JOIN "Loteria" l ON t."loteriaId" = l.id
        GROUP BY t."loteriaId", l.name
      ),
      desglose_ventana AS (
        SELECT
          t."ventanaId", v.name, 
          COUNT(*)::int as count,
          SUM(t."totalPayout")::float as total_payout,
          SUM(t."totalPaid")::float as total_paid,
          SUM(t."remainingAmount")::float as total_pending
        FROM filtered_tickets t
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        GROUP BY t."ventanaId", v.name
      ),
      desglose_vendedor AS (
        SELECT
          t."vendedorId", u.name, 
          COUNT(*)::int as count,
          SUM(t."totalPayout")::float as total_payout,
          SUM(t."totalPaid")::float as total_paid,
          SUM(t."remainingAmount")::float as total_pending
        FROM filtered_tickets t
        INNER JOIN "User" u ON t."vendedorId" = u.id
        GROUP BY t."vendedorId", u.name
      ),
      desglose_bet_type AS (
        SELECT
          j.type,
          COUNT(DISTINCT t.id)::int as count,
          SUM(j.payout)::float as amount
        FROM "Jugada" j
        INNER JOIN filtered_tickets t ON j."ticketId" = t.id
        WHERE j."ticketId" = t.id
          AND j."isWinner" = true
          AND j."deletedAt" IS NULL
        GROUP BY j.type
      )
      SELECT 
        (SELECT json_agg(x) FROM desglose_sorteo x) as by_sorteo,
        (SELECT json_agg(x) FROM desglose_loteria x) as by_loteria,
        (SELECT json_agg(x) FROM desglose_ventana x) as by_ventana,
        (SELECT json_agg(x) FROM desglose_vendedor x) as by_vendedor,
        (SELECT json_agg(x) FROM desglose_bet_type x) as by_bet_type
    `;

    const [breakdownsRaw] = await prisma.$queryRaw<any[]>(breakdownsQuery);

    const byBetType = {
      NUMERO: { count: 0, amount: 0 },
      REVENTADO: { count: 0, amount: 0 },
    };

    breakdownsRaw?.by_bet_type?.forEach((row: any) => {
      if (row.type === 'NUMERO') {
        byBetType.NUMERO.count = row.count;
        byBetType.NUMERO.amount = row.amount || 0;
      } else if (row.type === 'REVENTADO') {
        byBetType.REVENTADO.count = row.count;
        byBetType.REVENTADO.amount = row.amount || 0;
      }
    });

    const bySorteo = breakdownsRaw?.by_sorteo?.map((r: any) => ({
      sorteoId: r.sorteoId,
      sorteoName: r.name,
      count: r.count,
      totalPayout: r.total_payout,
      totalPaid: r.total_paid,
      totalPending: r.total_pending,
    }));

    const byLoteria = breakdownsRaw?.by_loteria?.map((r: any) => ({
      loteriaId: r.loteriaId,
      loteriaName: r.name,
      count: r.count,
      totalPayout: r.total_payout,
      totalPaid: r.total_paid,
      totalPending: r.total_pending,
    }));

    const byVentana = breakdownsRaw?.by_ventana?.map((r: any) => ({
      ventanaId: r.ventanaId,
      ventanaName: r.name,
      count: r.count,
      totalPayout: r.total_payout,
      totalPaid: r.total_paid,
      totalPending: r.total_pending,
    }));

    const byVendedor = breakdownsRaw?.by_vendedor?.map((r: any) => ({
      vendedorId: r.vendedorId,
      vendedorName: r.name,
      count: r.count,
      totalPayout: r.total_payout,
      totalPaid: r.total_paid,
      totalPending: r.total_pending,
    }));

    return {
      data: {
        summary: {
          totalWinningTickets: summaryResult?.total_winning_tickets || 0,
          totalPayout: summaryResult?.total_payout || 0,
          totalPaid: summaryResult?.total_paid || 0,
          totalPending: summaryResult?.total_pending || 0,
          partialPaymentsCount: summaryResult?.partial_payments_count || 0,
          unpaidCount: summaryResult?.unpaid_count || 0,
          averagePaymentTimeHours: summaryResult?.avg_payment_time ? parseFloat(summaryResult.avg_payment_time.toFixed(2)) : null,
          expiredCount: summaryResult?.expired_count || 0,
          expiredAmount: summaryResult?.expired_amount || 0,
          maxPayout: summaryResult?.max_payout_value || 0,
          maxPayoutTicketId: maxPayoutTicket?.id || null,
          maxPayoutTicketNumber: maxPayoutTicket?.ticketNumber || null,
          byBetType,
          payoutDistribution,
          ...(bySorteo && { bySorteo }),
          ...(byLoteria && { byLoteria }),
          ...(byVentana && { byVentana }),
          ...(byVendedor && { byVendedor }),
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
    ventanaId?: string;
    vendedorId?: string;
    betType?: 'NUMERO' | 'REVENTADO' | 'all';
    top?: number;
    includeComparison?: boolean;
    includeWinners?: boolean;
    includeExposure?: boolean;
    bancaId?: string;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Filtros comunes de entidad para reutilizar
    const numbersEntityFilters = Prisma.sql`
      ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
      ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
      ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid) AND j."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
      ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
    `;

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
      WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
        AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${numbersEntityFilters}
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
      WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
        AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${numbersEntityFilters}
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
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          ${numbersEntityFilters}
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
          ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
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
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
        ),
        last_wins AS (
          SELECT
            s."winningNumber" as number,
            MAX(s."updatedAt") as last_won_date
          FROM "Sorteo" s
          WHERE s."winningNumber" IS NOT NULL
            AND s.status = 'EVALUATED'
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
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

    // ======================================================
    // DESGLOSES (breakdowns) según filtros aplicados
    // ======================================================
    const numbersBaseFilter = Prisma.sql`
      t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
      AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND j."deletedAt" IS NULL
      ${numbersEntityFilters}
    `;

    const nbk = resolveBreakdowns(filters);

    let numBySorteo: any[] | undefined;
    if (nbk.includeSorteo) {
      const q = Prisma.sql`
        SELECT
          t."sorteoId" as "sorteoId",
          s.name as sorteo_name,
          SUM(j.amount) as total_amount,
          COUNT(DISTINCT j."ticketId") as tickets_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE ${numbersBaseFilter}
        GROUP BY t."sorteoId", s.name
        ORDER BY total_amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        numBySorteo = raw.map(r => {
          // Find the top number for this sorteo
          return {
            sorteoId: r.sorteoId,
            sorteoName: r.sorteo_name,
            totalAmount: Number(r.total_amount ?? 0),
            ticketsCount: Number(r.tickets_count ?? 0),
          };
        });
      }
    }

    let numByLoteria: any[] | undefined;
    if (nbk.includeLoteria) {
      const q = Prisma.sql`
        SELECT
          t."loteriaId" as "loteriaId",
          l.name as loteria_name,
          SUM(j.amount) as total_amount,
          COUNT(DISTINCT j."ticketId") as tickets_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Loteria" l ON t."loteriaId" = l.id
        WHERE ${numbersBaseFilter}
        GROUP BY t."loteriaId", l.name
        ORDER BY total_amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        numByLoteria = raw.map(r => ({
          loteriaId: r.loteriaId,
          loteriaName: r.loteria_name,
          totalAmount: Number(r.total_amount ?? 0),
          ticketsCount: Number(r.tickets_count ?? 0),
        }));
      }
    }

    let numByVentana: any[] | undefined;
    if (nbk.includeVentana) {
      const q = Prisma.sql`
        SELECT
          t."ventanaId" as "ventanaId",
          v.name as ventana_name,
          SUM(j.amount) as total_amount,
          COUNT(DISTINCT j."ticketId") as tickets_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${numbersBaseFilter}
        GROUP BY t."ventanaId", v.name
        ORDER BY total_amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        numByVentana = raw.map(r => ({
          ventanaId: r.ventanaId,
          ventanaName: r.ventana_name,
          totalAmount: Number(r.total_amount ?? 0),
          ticketsCount: Number(r.tickets_count ?? 0),
        }));
      }
    }

    let numByVendedor: any[] | undefined;
    if (nbk.includeVendedor) {
      const q = Prisma.sql`
        SELECT
          t."vendedorId" as "vendedorId",
          u.name as vendedor_name,
          SUM(j.amount) as total_amount,
          COUNT(DISTINCT j."ticketId") as tickets_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "User" u ON t."vendedorId" = u.id
        WHERE ${numbersBaseFilter}
        GROUP BY t."vendedorId", u.name
        ORDER BY total_amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        numByVendedor = raw.map(r => ({
          vendedorId: r.vendedorId,
          vendedorName: r.vendedor_name,
          totalAmount: Number(r.total_amount ?? 0),
          ticketsCount: Number(r.tickets_count ?? 0),
        }));
      }
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
        ...(numBySorteo && { bySorteo: numBySorteo }),
        ...(numByLoteria && { byLoteria: numByLoteria }),
        ...(numByVentana && { byVentana: numByVentana }),
        ...(numByVendedor && { byVendedor: numByVendedor }),
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
    bancaId?: string;
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

    // Calcular tasa de cancelación (necesitaríamos total de tickets para esto)
    const totalTicketsInPeriod = await prisma.ticket.count({
      where: {
        businessDate: {
          gte: new Date(dateRange.fromString),
          lte: new Date(dateRange.toString),
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

    // ======================================================
    // DESGLOSES (breakdowns) según filtros aplicados
    // ======================================================
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
          WHERE t."createdAt" BETWEEN ${dateRange.from}::timestamp AND ${dateRange.to}::timestamp
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
          WHERE t."createdAt" BETWEEN ${dateRange.from}::timestamp AND ${dateRange.to}::timestamp
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
          WHERE t."createdAt" BETWEEN ${dateRange.from}::timestamp AND ${dateRange.to}::timestamp
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
          WHERE t."createdAt" BETWEEN ${dateRange.from}::timestamp AND ${dateRange.to}::timestamp
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

  /**
   * Reporte de exposición y riesgo por número
   * CRÍTICO: Para gestión de riesgo financiero
   */
  async getExposure(filters: {
    sorteoId: string;
    loteriaId?: string;
    top?: number;
    minExposure?: number;
    bancaId?: string;
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
      WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
        AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND j."isActive" = true
        ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
        ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
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

    // Agrupación por ventana con ventana-functions para obtener el top number en una sola query
    const byVentanaQuery = Prisma.sql`
      WITH number_exposure AS (
        SELECT
          t."sorteoId",
          t."ventanaId",
          j.number,
          SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER}))::float as exposure
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
          AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY t."sorteoId", t."ventanaId", j.number
      ),
      top_numbers AS (
        SELECT
          *,
          ROW_NUMBER() OVER(PARTITION BY "sorteoId", "ventanaId" ORDER BY exposure DESC) as rnk
        FROM number_exposure
      ),
      ventana_totals AS (
        SELECT
          t."ventanaId",
          v.name as ventana_name,
          SUM(j.amount)::float as total_amount,
          SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER}))::float as exposure
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
          AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY t."ventanaId", v.name
      )
      SELECT
        vt.*,
        tn.number as top_number,
        COALESCE(tn.exposure, 0) as top_number_exposure
      FROM ventana_totals vt
      LEFT JOIN top_numbers tn ON vt."ventanaId" = tn."ventanaId" AND tn.rnk = 1
      ORDER BY vt.exposure DESC
    `;

    const byVentanaRaw = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_name: string;
      total_amount: number;
      exposure: number;
      top_number: string | null;
      top_number_exposure: number;
    }>>(byVentanaQuery);

    const byVentana = byVentanaRaw.map(v => ({
      ventanaId: v.ventanaId,
      ventanaName: v.ventana_name,
      ventas: v.total_amount,
      exposure: v.exposure,
      topNumber: v.top_number,
      topNumberExposure: v.top_number_exposure,
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
  vendedorId?: string;
  loteriaId?: string;
  includeComparison?: boolean;
  groupBy?: 'day' | 'week' | 'month';
  bancaId?: string;
}): Promise<any> {

  const dateRange = resolveDateRange(
    filters.date || 'today',
    filters.fromDate,
    filters.toDate
  );

  // Filtro de entidad reutilizable para profitability
  const profitEntityFilter = Prisma.sql`
    ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
    ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
    ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
    ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
  `;

  // ======================================================
  // MÉTRICAS PRINCIPALES (SUMMARY) — SOLO businessDate
  // ======================================================
  const metricsQuery = Prisma.sql`
    SELECT
      SUM(t."totalAmount") as total_ventas,
      SUM(COALESCE(t."totalPayout", 0)) as total_premios,
      COUNT(*) as tickets_count,
      COUNT(CASE WHEN t."isWinner" = true THEN 1 END) as tickets_ganadores
    FROM "Ticket" t
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date
                                AND ${dateRange.toString}::date
      AND t."status"::text IN ('EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
      ${profitEntityFilter}
  `;

  const [metrics] = await prisma.$queryRaw<Array<{
    total_ventas: number | null;
    total_premios: number | null;
    tickets_count: bigint;
    tickets_ganadores: bigint;
  }>>(metricsQuery);

  // ======================================================
  // COMISIONES — por ticket → businessDate
  // ======================================================
  const comisionesQuery = Prisma.sql`
    SELECT SUM(j."listeroCommissionAmount") as total_comisiones
    FROM "Jugada" j
    INNER JOIN "Ticket" t ON j."ticketId" = t.id
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date
                                AND ${dateRange.toString}::date
      AND t."status"::text IN ('EVALUATED', 'PAID', 'PAGADO')
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND j."isActive" = true
      AND j."deletedAt" IS NULL
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
      ${profitEntityFilter}
  `;

  const [comisiones] = await prisma.$queryRaw<Array<{
    total_comisiones: number | null;
  }>>(comisionesQuery);

  // ======================================================
  // PARSEOS Y CÁLCULOS
  // ======================================================
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
    porcentajeRetorno: totalVentas > 0
      ? +(totalPremios / totalVentas * 100).toFixed(2)
      : 0,
    porcentajeMargen: totalVentas > 0
      ? +(margenNeto / totalVentas * 100).toFixed(2)
      : 0,
    ticketsCount,
    ticketsGanadores,
    tasaGanadores: ticketsCount > 0
      ? +(ticketsGanadores / ticketsCount * 100).toFixed(2)
      : 0,
  };

  // ======================================================
  // TENDENCIA — businessDate
  // ======================================================
  let trend: any[] = [];

  if (filters.groupBy) {

    const groupExpr =
      filters.groupBy === 'day'
        ? Prisma.sql`t."businessDate"`
        : filters.groupBy === 'week'
        ? Prisma.sql`DATE_TRUNC('week', t."businessDate")`
        : Prisma.sql`DATE_TRUNC('month', t."businessDate")`;

    const trendQuery = Prisma.sql`
      SELECT
        ${groupExpr} as period,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date
                                  AND ${dateRange.toString}::date
        AND t."status"::text IN ('EVALUATED', 'PAID', 'PAGADO')
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND s.status = 'EVALUATED'
        AND s."deletedAt" IS NULL
        ${profitEntityFilter}
      GROUP BY ${groupExpr}
      ORDER BY period ASC
    `;

    const rows = await prisma.$queryRaw<any[]>(trendQuery);

    trend = rows.map(r => {
      const ventas = Number(r.ventas ?? 0);
      const premios = Number(r.premios ?? 0);
      return {
        period: formatDateOnly(new Date(r.period)),
        ventas,
        premios,
        margenBruto: ventas - premios,
      };
    });
  }

  // ======================================================
  // DESGLOSES (breakdowns) según filtros aplicados
  // ======================================================
  const profitBaseFilter = Prisma.sql`
    t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
    AND t."status"::text IN ('EVALUATED', 'PAID', 'PAGADO')
    AND t."isActive" = true
    AND t."deletedAt" IS NULL
    AND s.status = 'EVALUATED'
    AND s."deletedAt" IS NULL
    ${profitEntityFilter}
  `;

  const pbk = resolveBreakdowns(filters);

  const mapProfitRow = (r: any) => {
    const ventas = Number(r.ventas ?? 0);
    const premios = Number(r.premios ?? 0);
    const mb = ventas - premios;
    return { ventas, premios, margenBruto: mb, porcentajeMargen: ventas > 0 ? +(mb / ventas * 100).toFixed(2) : 0 };
  };

  let pByLoteria: any[] | undefined;
  if (pbk.includeLoteria) {
    const q = Prisma.sql`
      SELECT
        t."loteriaId",
        l.name as loteria_name,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "Loteria" l ON t."loteriaId" = l.id
      WHERE ${profitBaseFilter}
      GROUP BY t."loteriaId", l.name
      ORDER BY ventas DESC
    `;
    const raw = await prisma.$queryRaw<any[]>(q);
    if (raw.length > 0) {
      pByLoteria = raw.map(r => ({
        loteriaId: r.loteriaId,
        loteriaName: r.loteria_name,
        ...mapProfitRow(r),
      }));
    }
  }

  let pBySorteo: any[] | undefined;
  if (pbk.includeSorteo) {
    const q = Prisma.sql`
      SELECT
        t."sorteoId",
        s.name as sorteo_name,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      WHERE ${profitBaseFilter}
      GROUP BY t."sorteoId", s.name
      ORDER BY ventas DESC
    `;
    const raw = await prisma.$queryRaw<any[]>(q);
    if (raw.length > 0) {
      pBySorteo = raw.map(r => ({
        sorteoId: r.sorteoId,
        sorteoName: r.sorteo_name,
        ...mapProfitRow(r),
      }));
    }
  }

  let pByVentana: any[] | undefined;
  if (pbk.includeVentana) {
    const q = Prisma.sql`
      SELECT
        t."ventanaId",
        v.name as ventana_name,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id
      WHERE ${profitBaseFilter}
      GROUP BY t."ventanaId", v.name
      ORDER BY ventas DESC
    `;
    const raw = await prisma.$queryRaw<any[]>(q);
    if (raw.length > 0) {
      pByVentana = raw.map(r => ({
        ventanaId: r.ventanaId,
        ventanaName: r.ventana_name,
        ...mapProfitRow(r),
      }));
    }
  }

  let pByVendedor: any[] | undefined;
  if (pbk.includeVendedor) {
    const q = Prisma.sql`
      SELECT
        t."vendedorId",
        u.name as vendedor_name,
        SUM(t."totalAmount") as ventas,
        SUM(COALESCE(t."totalPayout", 0)) as premios
      FROM "Ticket" t
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "User" u ON t."vendedorId" = u.id
      WHERE ${profitBaseFilter}
      GROUP BY t."vendedorId", u.name
      ORDER BY ventas DESC
    `;
    const raw = await prisma.$queryRaw<any[]>(q);
    if (raw.length > 0) {
      pByVendedor = raw.map(r => ({
        vendedorId: r.vendedorId,
        vendedorName: r.vendedor_name,
        ...mapProfitRow(r),
      }));
    }
  }

  return {
    data: {
      summary,
      ...(trend.length && { trend }),
      ...(pByLoteria && { byLoteria: pByLoteria }),
      ...(pBySorteo && { bySorteo: pBySorteo }),
      ...(pByVentana && { byVentana: pByVentana }),
      ...(pByVendedor && { byVendedor: pByVendedor }),
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
    vendedorId?: string;
    loteriaId?: string;
    metric?: 'ventas' | 'tickets' | 'cancelaciones';
    bancaId?: string;
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
      AND t."status"::text IN ('EVALUATED', 'PAID', 'PAGADO')
      AND s.status = 'EVALUATED'
      AND s."deletedAt" IS NULL
    `;

    // Para cancelaciones: tickets cancelados (sin filtro de sorteo)
    const cancelledTicketFilter = Prisma.sql`AND t."status"::text = 'CANCELLED'`;

    // Filtro de entidad reutilizable para time-analysis
    const timeEntityFilter = Prisma.sql`
      ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
      ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
    `;

    // Por hora (convertir a hora local de Costa Rica)
    // Filtro por businessDate para consistencia con Profitability
    const byHourQuery = metric === 'cancelaciones'
      ? Prisma.sql`
          SELECT
            EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledTicketFilter}
            ${timeEntityFilter}
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
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${validTicketFilter}
            ${timeEntityFilter}
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

    // Por día de semana (usa businessDate que es la fecha de negocio)
    const byDayQuery = metric === 'cancelaciones'
      ? Prisma.sql`
          SELECT
            EXTRACT(DOW FROM t."businessDate") as day,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${cancelledTicketFilter}
            ${timeEntityFilter}
          GROUP BY EXTRACT(DOW FROM t."businessDate")
          ORDER BY day ASC
        `
      : Prisma.sql`
          SELECT
            EXTRACT(DOW FROM t."businessDate") as day,
            COUNT(*) as count,
            SUM(t."totalAmount") as amount
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${validTicketFilter}
            ${timeEntityFilter}
          GROUP BY EXTRACT(DOW FROM t."businessDate")
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
      const cancelByHourQuery = Prisma.sql`
        SELECT
          EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          AND t."status"::text = 'CANCELLED'
          ${timeEntityFilter}
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

    // ======================================================
    // DESGLOSES (breakdowns) según filtros aplicados
    // ======================================================
    const tbk = resolveBreakdowns(filters);

    // Para time-analysis, el desglose principal son count y amount + peakHour
    // Usamos el query base de ventas (no cancelaciones) para los breakdowns
    let tBySorteo: any[] | undefined;
    if (tbk.includeSorteo) {
      const q = Prisma.sql`
        SELECT
          t."sorteoId" as "sorteoId",
          s.name as sorteo_name,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          ${validTicketFilter}
          ${timeEntityFilter}
        GROUP BY t."sorteoId", s.name
        ORDER BY amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        tBySorteo = raw.map(r => ({
          sorteoId: r.sorteoId,
          sorteoName: r.sorteo_name,
          count: Number(r.count),
          amount: Number(r.amount ?? 0),
        }));
      }
    }

    let tByLoteria: any[] | undefined;
    if (tbk.includeLoteria) {
      const q = Prisma.sql`
        SELECT
          t."loteriaId" as "loteriaId",
          l.name as loteria_name,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        INNER JOIN "Loteria" l ON t."loteriaId" = l.id
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          ${validTicketFilter}
          ${timeEntityFilter}
        GROUP BY t."loteriaId", l.name
        ORDER BY amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        tByLoteria = raw.map(r => ({
          loteriaId: r.loteriaId,
          loteriaName: r.loteria_name,
          count: Number(r.count),
          amount: Number(r.amount ?? 0),
        }));
      }
    }

    let tByVentana: any[] | undefined;
    if (tbk.includeVentana) {
      const q = Prisma.sql`
        SELECT
          t."ventanaId" as "ventanaId",
          v.name as ventana_name,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          ${validTicketFilter}
          ${timeEntityFilter}
        GROUP BY t."ventanaId", v.name
        ORDER BY amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        tByVentana = raw.map(r => ({
          ventanaId: r.ventanaId,
          ventanaName: r.ventana_name,
          count: Number(r.count),
          amount: Number(r.amount ?? 0),
        }));
      }
    }

    let tByVendedor: any[] | undefined;
    if (tbk.includeVendedor) {
      const q = Prisma.sql`
        SELECT
          t."vendedorId" as "vendedorId",
          u.name as vendedor_name,
          COUNT(*) as count,
          SUM(t."totalAmount") as amount
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        INNER JOIN "User" u ON t."vendedorId" = u.id
        WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
          ${validTicketFilter}
          ${timeEntityFilter}
        GROUP BY t."vendedorId", u.name
        ORDER BY amount DESC
      `;
      const raw = await prisma.$queryRaw<any[]>(q);
      if (raw.length > 0) {
        tByVendedor = raw.map(r => ({
          vendedorId: r.vendedorId,
          vendedorName: r.vendedor_name,
          count: Number(r.count),
          amount: Number(r.amount ?? 0),
        }));
      }
    }

    return {
      data: {
        byHour,
        byDayOfWeek,
        summary,
        ...(cancellations && { cancellations }),
        ...(tBySorteo && { bySorteo: tBySorteo }),
        ...(tByLoteria && { byLoteria: tByLoteria }),
        ...(tByVentana && { byVentana: tByVentana }),
        ...(tByVendedor && { byVendedor: tByVendedor }),
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

  /**
   * Obtiene la lista de ganadores de un sorteo específico, optimizada para reportes
   */
  async getWinnersList(sorteoId: string, filters: { vendedorId?: string; bancaId?: string }) {
    // 1. Obtener datos del sorteo, lotería y vendedor (si aplica)
    const sorteo = await prisma.sorteo.findUnique({
      where: { id: sorteoId },
      include: {
        loteria: {
          select: { name: true }
        }
      }
    });

    if (!sorteo) {
      throw new AppError('Sorteo no encontrado', 404);
    }

    // 2. Obtener tickets ganadores para este sorteo
    const tickets = await prisma.ticket.findMany({
      where: {
        sorteoId,
        isWinner: true,
        isActive: true,
        deletedAt: null,
        ...(filters.vendedorId && filters.vendedorId.trim() !== '' && { vendedorId: filters.vendedorId }),
        ...(filters.bancaId && filters.bancaId.trim() !== '' && { bancaId: filters.bancaId }),
      },
      select: {
        id: true,
        ticketNumber: true,
        totalAmount: true,
        totalPayout: true,
        clienteNombre: true,
        vendedor: {
          select: { name: true }
        },
        jugadas: {
          where: {
            isWinner: true,
            deletedAt: null
          },
          select: {
            number: true,
            type: true,
            amount: true,
            payout: true
          }
        }
      },
      orderBy: {
        totalPayout: 'desc'
      }
    });

    // 3. Determinar el nombre del vendedor para el encabezado
    let vendedorName = 'Todos';
    if (filters.vendedorId && filters.vendedorId.trim() !== '') {
      const vendedor = await prisma.user.findUnique({
        where: { id: filters.vendedorId },
        select: { name: true }
      });
      vendedorName = vendedor?.name || 'Desconocido';
    } else if (tickets.length > 0) {
      // Si todos los tickets son del mismo vendedor, podemos mostrar su nombre
      const firstVendedor = tickets[0].vendedor.name;
      const allSame = tickets.every(t => t.vendedor.name === firstVendedor);
      if (allSame) {
        vendedorName = firstVendedor;
      }
    }

    // 4. Calcular totales e informados
    let totalAmountVal = 0;
    let totalPayoutVal = 0;
    let totalPayoutByNumber = 0;
    let totalPayoutByReventado = 0;

    const ticketsData = tickets.map(t => {
      // Sumar solo los montos apostados a las jugadas ganadoras de este ticket
      const winningAmount = t.jugadas.reduce((sum, j) => sum + (j.amount || 0), 0);
      totalAmountVal += winningAmount;
      totalPayoutVal += t.totalPayout || 0;

      // Desglose por tipo de jugada para los totales
      t.jugadas.forEach(j => {
        if (j.type === 'NUMERO') {
          totalPayoutByNumber += j.payout || 0;
        } else if (j.type === 'REVENTADO') {
          totalPayoutByReventado += j.payout || 0;
        }
      });

      return {
        ticketNumber: t.ticketNumber,
        clienteNombre: t.clienteNombre,
        totalAmount: winningAmount,
        totalPayout: t.totalPayout,
        winningJugadas: t.jugadas.map(j => ({
          number: j.number,
          type: j.type,
          amount: j.amount,
          payout: j.payout
        }))
      };
    });

    return {
      data: {
        sorteo: {
          name: sorteo.name,
          winningNumber: sorteo.winningNumber,
          isReventado: !!sorteo.extraOutcomeCode
        },
        loteria: {
          name: sorteo.loteria.name
        },
        vendedor: {
          name: vendedorName
        },
        printDateTime: new Date().toISOString(),
        tickets: ticketsData,
        totals: {
          count: tickets.length,
          totalAmount: totalAmountVal,
          totalPayout: totalPayoutVal,
          totalPayoutByNumber,
          totalPayoutByReventado
        }
      }
    };
  },

  /**
   * Detalle desglosado de un número (Drill-down)
   * GET /api/v1/reports/tickets/numbers-analysis/detail
   */
  async getNumbersAnalysisDetail(filters: {
    number: string;
    loteriaId: string;
    ventanaId?: string;
    vendedorId?: string;
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    betType?: 'NUMERO' | 'REVENTADO' | 'all';
    bancaId?: string;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // 1. Obtener información de la lotería
    const loteria = await prisma.loteria.findUnique({
      where: { id: filters.loteriaId },
      select: { id: true, name: true },
    });

    if (!loteria) {
      throw new AppError('Lotería no encontrada', 404);
    }

    // 2. Query optimizada para el desglose
    const detailQuery = Prisma.sql`
      WITH filtered_jugadas AS (
        SELECT
          t."sorteoId",
          s.name as sorteo_name,
          t."vendedorId",
          u.name as vendedor_name,
          j.amount,
          j."ticketId"
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        INNER JOIN "User" u ON t."vendedorId" = u.id
        WHERE t."loteriaId" = CAST(${filters.loteriaId} AS uuid)
          AND j.number = ${filters.number}
          AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
          AND t."status"::text IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
          ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
          ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
      ),
      sorteo_agg AS (
        SELECT
          "sorteoId",
          sorteo_name,
          SUM(amount) as total_amount,
          COUNT(DISTINCT "ticketId") as tickets_count,
          COUNT(*) as jugadas_count
        FROM filtered_jugadas
        GROUP BY "sorteoId", sorteo_name
      ),
      vendedor_agg AS (
        SELECT
          "sorteoId",
          "vendedorId",
          vendedor_name,
          SUM(amount) as total_amount,
          COUNT(DISTINCT "ticketId") as tickets_count
        FROM filtered_jugadas
        GROUP BY "sorteoId", "vendedorId", vendedor_name
      )
      SELECT
        sa.*,
        COALESCE(
          json_agg(
            json_build_object(
              'vendedorId', va."vendedorId",
              'vendedorName', va.vendedor_name,
              'totalAmount', va.total_amount,
              'ticketsCount', va.tickets_count
            ) ORDER BY va.total_amount DESC
          ) FILTER (WHERE va."vendedorId" IS NOT NULL),
          '[]'::json
        ) as by_vendedor
      FROM sorteo_agg sa
      LEFT JOIN vendedor_agg va ON sa."sorteoId" = va."sorteoId"
      GROUP BY sa."sorteoId", sa.sorteo_name, sa.total_amount, sa.tickets_count, sa.jugadas_count
      ORDER BY sa.total_amount DESC
    `;

    const rawResults = await prisma.$queryRaw<any[]>(detailQuery);

    // 3. Formatear resultados
    let totalAmount = 0;
    let totalTicketsCount = 0;
    let totalJugadasCount = 0;

    const bySorteo = rawResults.map(row => {
      const sorteoAmount = Number(row.total_amount);
      const sorteoTickets = Number(row.tickets_count);
      const sorteoJugadas = Number(row.jugadas_count);

      totalAmount += sorteoAmount;
      totalTicketsCount += sorteoTickets;
      totalJugadasCount += sorteoJugadas;

      return {
        sorteoId: row.sorteoId,
        sorteoName: row.sorteo_name,
        totalAmount: sorteoAmount,
        ticketsCount: sorteoTickets,
        jugadasCount: sorteoJugadas,
        byVendedor: (row.by_vendedor || []).map((v: any) => ({
          vendedorId: v.vendedorId,
          vendedorName: v.vendedorName,
          totalAmount: Number(v.totalAmount),
          ticketsCount: Number(v.ticketsCount),
        })),
      };
    });

    return {
      data: {
        number: filters.number,
        loteriaId: loteria.id,
        loteriaName: loteria.name,
        summary: {
          totalAmount,
          ticketsCount: totalTicketsCount,
          jugadasCount: totalJugadasCount,
        },
        bySorteo,
      },
      meta: {
        dateRange: {
          from: formatDateOnly(dateRange.from),
          to: formatDateOnly(dateRange.to),
        },
      },
    };
  },
};

