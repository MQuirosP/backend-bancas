/**
 * Servicio de reportes de loterías
 */

import { Prisma, SorteoStatus } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { resolveDateRange, calculatePreviousPeriod, calculateChangePercent, calculatePercentage } from '../../utils/reports.utils';
import { DateToken, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';

export const LoteriasReportService = {
  /**
   * Reporte de rendimiento y rentabilidad por lotería
   */
  async getPerformance(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    loteriaId?: string;
    includeComparison?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Query optimizada usando CTEs
    const loteriasQuery = Prisma.sql`
      WITH loteria_stats AS (
        SELECT 
          t."loteriaId",
          COUNT(DISTINCT t.id) as tickets_count,
          COUNT(DISTINCT j.id) as jugadas_count,
          SUM(t."totalAmount") as ventas_total,
          AVG(t."totalAmount") as avg_ticket_amount,
          COUNT(DISTINCT CASE WHEN t."isWinner" THEN t.id END) as winning_tickets_count,
          SUM(COALESCE(t."totalPayout", 0)) as payout_total
        FROM "Ticket" t
        LEFT JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
        WHERE t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
          AND t.status = 'ACTIVE'
          AND t."deletedAt" IS NULL
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
        GROUP BY t."loteriaId"
      )
      SELECT 
        ls.*,
        l.id as loteria_id,
        l.name as loteria_name,
        l."isActive" as is_active,
        (ls.ventas_total - ls.payout_total) as neto,
        CASE 
          WHEN ls.ventas_total > 0 
          THEN ((ls.ventas_total - ls.payout_total) / ls.ventas_total) * 100 
          ELSE 0 
        END as margin,
        CASE 
          WHEN ls.ventas_total > 0 
          THEN (ls.payout_total / ls.ventas_total) * 100 
          ELSE 0 
        END as payout_ratio
      FROM loteria_stats ls
      INNER JOIN "Loteria" l ON ls."loteriaId" = l.id
      WHERE l."isActive" = true
      ORDER BY ls.ventas_total DESC
    `;

    const loterias = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteria_id: string;
      loteria_name: string;
      is_active: boolean;
      tickets_count: number;
      jugadas_count: number;
      ventas_total: number;
      avg_ticket_amount: number;
      winning_tickets_count: number;
      payout_total: number;
      neto: number;
      margin: number;
      payout_ratio: number;
    }>>(loteriasQuery);

    // Calcular resumen total
    const totalVentas = loterias.reduce((sum, l) => sum + parseFloat(l.ventas_total.toString()), 0);
    const totalPayout = loterias.reduce((sum, l) => sum + parseFloat(l.payout_total.toString()), 0);
    const totalNeto = totalVentas - totalPayout;
    const overallMargin = totalVentas > 0 ? (totalNeto / totalVentas) * 100 : 0;
    const activeLoterias = loterias.filter(l => l.is_active).length;

    const loteriasData: Array<{
      loteriaId: string;
      loteriaName: string;
      loteriaCode: string;
      isActive: boolean;
      ventasTotal: number;
      ticketsCount: number;
      jugadasCount: number;
      avgTicketAmount: number;
      payoutTotal: number;
      winningTicketsCount: number;
      neto: number;
      margin: number;
      payoutRatio: number;
      sorteos?: Array<{
        sorteoId: string;
        sorteoName: string;
        scheduledAt: string;
        status: string;
        ventasTotal: number;
        ticketsCount: number;
        payoutTotal: number;
      }>;
    }> = loterias.map(l => ({
      loteriaId: l.loteriaId,
      loteriaName: l.loteria_name,
      loteriaCode: '', // No hay código en el schema actual
      isActive: l.is_active,
      ventasTotal: parseFloat(l.ventas_total.toString()),
      ticketsCount: parseInt(l.tickets_count.toString()),
      jugadasCount: parseInt(l.jugadas_count.toString()),
      avgTicketAmount: parseFloat(l.avg_ticket_amount.toString()),
      payoutTotal: parseFloat(l.payout_total.toString()),
      winningTicketsCount: parseInt(l.winning_tickets_count.toString()),
      neto: parseFloat(l.neto.toString()),
      margin: parseFloat(l.margin.toString()),
      payoutRatio: parseFloat(l.payout_ratio.toString()),
    }));

    // Si se especifica loteriaId, agregar detalle por sorteos
    if (filters.loteriaId && loteriasData.length > 0) {
      const sorteos = await prisma.sorteo.findMany({
        where: {
          loteriaId: filters.loteriaId,
          scheduledAt: {
            gte: dateRange.from,
            lte: dateRange.to,
          },
        },
        include: {
          tickets: {
            where: {
              status: 'ACTIVE',
              deletedAt: null,
            },
            select: {
              id: true,
              totalAmount: true,
              totalPayout: true,
            },
          },
        },
      });

      const sorteosData = sorteos.map(s => {
        const ventasTotal = s.tickets.reduce((sum, t) => sum + t.totalAmount, 0);
        const payoutTotal = s.tickets.reduce((sum, t) => sum + (t.totalPayout || 0), 0);
        return {
          sorteoId: s.id,
          sorteoName: s.name,
          scheduledAt: formatIsoLocal(s.scheduledAt),
          status: s.status,
          ventasTotal,
          ticketsCount: s.tickets.length,
          payoutTotal,
        };
      });

      loteriasData[0].sorteos = sorteosData;
    }

    return {
      data: {
        loterias: loteriasData,
        summary: {
          totalVentas,
          totalPayout,
          totalNeto,
          overallMargin: parseFloat(overallMargin.toFixed(2)),
          activeLoterias,
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
};

