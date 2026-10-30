/**
 * Handler de reportes para Tickets Ganadores y Pagos Pendientes
 */

import { Prisma, TicketStatus, SorteoStatus, BetType } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { resolveDateRange, normalizePagination } from '../../../api/v1/utils/reports.utils';
import { DateToken, PaymentStatus, ReportMeta } from '../../../api/v1/types/reports.types';
import { formatIsoLocal } from '../../../utils/datetime';

export interface WinnersPaymentsFilters {
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
  betType?: BetType | 'all';
}

export interface WinnersPaymentsResult {
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

export const WinnersReportHandler = {
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

    // Mapear pagos de los tickets procesados
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
        WHERE ${summaryBaseWhere}
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
        COUNT(*) FILTER (WHERE "remainingAmount" > 0 AND sorteo_status = ${SorteoStatus.EVALUATED} AND sorteo_updated_at < ${expiredThreshold})::int AS expired_count,
        SUM(COALESCE("remainingAmount", 0)) FILTER (WHERE "remainingAmount" > 0 AND sorteo_status = ${SorteoStatus.EVALUATED} AND sorteo_updated_at < ${expiredThreshold})::float AS expired_amount,
        AVG(EXTRACT(EPOCH FROM ("lastPaymentAt" - sorteo_updated_at)) / 3600) FILTER (WHERE "lastPaymentAt" IS NOT NULL AND sorteo_status = ${SorteoStatus.EVALUATED} AND "lastPaymentAt" > sorteo_updated_at)::float AS avg_payment_time
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
    const breakdownsQuery = Prisma.sql`
      WITH filtered_tickets AS MATERIALIZED (
        SELECT t.id, t."sorteoId", t."loteriaId", t."ventanaId", t."vendedorId", t."totalPayout", t."totalPaid", t."remainingAmount"
        FROM "Ticket" t
        WHERE ${summaryBaseWhere}
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
      if (row.type === BetType.NUMERO) {
        byBetType.NUMERO.count = row.count;
        byBetType.NUMERO.amount = row.amount || 0;
      } else if (row.type === BetType.REVENTADO) {
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
        if (j.type === BetType.NUMERO) {
          totalPayoutByNumber += j.payout || 0;
        } else if (j.type === BetType.REVENTADO) {
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
};
