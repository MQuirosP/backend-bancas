/**
 * Servicio de reportes de ventanas (listeros)
 */

import { Prisma } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { resolveDateRange, normalizePagination, calculatePreviousPeriod, calculateChangePercent } from '../../utils/reports.utils';
import { DateToken, SortByVentanas, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';

export const VentanasReportService = {
  /**
   * Ranking y comparativa de listeros
   */
  async getRanking(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    ventanaId?: string;
    top?: number;
    sortBy?: SortByVentanas;
    includeComparison?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const top = Math.min(50, Math.max(1, filters.top || 10));
    const sortBy = filters.sortBy || 'ventas';

    // Construir ORDER BY dinámico
    let orderByClause: Prisma.Sql;
    switch (sortBy) {
      case 'neto':
        orderByClause = Prisma.sql`(vs.ventas_total - vs.payout_total) DESC`;
        break;
      case 'margin':
        orderByClause = Prisma.sql`margin DESC`;
        break;
      case 'tickets':
        orderByClause = Prisma.sql`vs.tickets_count DESC`;
        break;
      case 'ventas':
      default:
        orderByClause = Prisma.sql`vs.ventas_total DESC`;
        break;
    }

    // Query optimizada con CTEs
    const ventanasQuery = Prisma.sql`
      WITH ventana_stats AS (
        SELECT 
          t."ventanaId",
          COUNT(DISTINCT t.id) as tickets_count,
          COUNT(DISTINCT t."vendedorId") as active_vendedores_count,
          COUNT(DISTINCT DATE(t."createdAt")) as activity_days,
          SUM(t."totalAmount") as ventas_total,
          AVG(t."totalAmount") as avg_ticket_amount,
          COUNT(DISTINCT CASE WHEN t."isWinner" THEN t.id END) as winning_tickets_count,
          SUM(COALESCE(t."totalPayout", 0)) as payout_total
        FROM "Ticket" t
        WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
          AND t.status = 'ACTIVE'
          AND t."deletedAt" IS NULL
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        GROUP BY t."ventanaId"
      )
      SELECT 
        vs.*,
        v.id as ventana_id,
        v.name as ventana_name,
        v.code as ventana_code,
        v."isActive" as is_active,
        (vs.ventas_total - vs.payout_total) as neto,
        CASE 
          WHEN vs.ventas_total > 0 
          THEN ((vs.ventas_total - vs.payout_total) / vs.ventas_total) * 100 
          ELSE 0 
        END as margin
      FROM ventana_stats vs
      INNER JOIN "Ventana" v ON vs."ventanaId" = v.id
      ORDER BY ${orderByClause}
      LIMIT ${top}
    `;

    const ventanas = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_id: string;
      ventana_name: string;
      ventana_code: string | null;
      is_active: boolean;
      tickets_count: number;
      active_vendedores_count: number;
      activity_days: number;
      ventas_total: number;
      avg_ticket_amount: number;
      winning_tickets_count: number;
      payout_total: number;
      neto: number;
      margin: number;
    }>>(ventanasQuery);

    // Obtener total de vendedores por ventana
    const ventanaIds = ventanas.map(v => v.ventanaId);
    const vendedoresCount = await prisma.user.groupBy({
      by: ['ventanaId'],
      where: {
        ventanaId: { in: ventanaIds },
        role: 'VENDEDOR',
        isActive: true,
      },
      _count: { id: true },
    });

    const vendedoresMap = new Map(
      vendedoresCount.map(v => [v.ventanaId, v._count.id])
    );

    const ventanasData = ventanas.map((v, index) => ({
      ventanaId: v.ventanaId,
      ventanaName: v.ventana_name,
      ventanaCode: v.ventana_code || '',
      isActive: v.is_active,
      ventasTotal: parseFloat(v.ventas_total.toString()),
      ticketsCount: parseInt(v.tickets_count.toString()),
      avgTicketAmount: parseFloat(v.avg_ticket_amount.toString()),
      payoutTotal: parseFloat(v.payout_total.toString()),
      winningTicketsCount: parseInt(v.winning_tickets_count.toString()),
      neto: parseFloat(v.neto.toString()),
      margin: parseFloat(v.margin.toString()),
      activeVendedoresCount: parseInt(v.active_vendedores_count.toString()),
      totalVendedoresCount: vendedoresMap.get(v.ventanaId) || 0,
      activityDays: parseInt(v.activity_days.toString()),
      commissionsPaid: 0, // TODO: Calcular desde comisiones
      commissionsEarned: 0, // TODO: Calcular desde comisiones
      rank: index + 1,
    }));

    // Calcular resumen
    const totalVentas = ventanasData.reduce((sum, v) => sum + v.ventasTotal, 0);
    const totalNeto = ventanasData.reduce((sum, v) => sum + v.neto, 0);
    const averageMargin = ventanasData.length > 0
      ? ventanasData.reduce((sum, v) => sum + v.margin, 0) / ventanasData.length
      : 0;

    return {
      data: {
        ventanas: ventanasData,
        summary: {
          totalVentas,
          totalNeto,
          activeVentanas: ventanasData.filter(v => v.isActive).length,
          averageMargin: parseFloat(averageMargin.toFixed(2)),
        },
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        sortBy,
        comparisonEnabled: filters.includeComparison || false,
      },
    };
  },
};

