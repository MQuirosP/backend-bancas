/**
 * Servicio de reportes de vendedores
 */

import { Prisma } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { AppError } from '../../../../core/errors';
import { resolveDateRange, normalizePagination, calculateChangePercent, calculatePercentage } from '../../utils/reports.utils';
import { DateToken, SortByVendedores, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';

export const VendedoresReportService = {
  /**
   * Análisis de comisiones de vendedores (con gráfico)
   * REQUERIDO: ventanaId (sin valor por defecto)
   */
  async getCommissionsChart(filters: {
    ventanaId: string; // REQUERIDO
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Obtener ventana
    const ventana = await prisma.ventana.findUnique({
      where: { id: filters.ventanaId },
      select: { id: true, name: true, code: true },
    });

    if (!ventana) {
      throw new AppError('Ventana no encontrada', 404);
    }

    // Query optimizada para comisiones por vendedor
    const chartQuery = Prisma.sql`
      SELECT 
        u.id as vendedor_id,
        u.name as vendedor_name,
        u.code as vendedor_code,
        COALESCE(SUM(j."commissionAmount"), 0) as commissions_total,
        COUNT(DISTINCT t.id) as tickets_count,
        COALESCE(SUM(t."totalAmount"), 0) as ventas_total
      FROM "User" u
      LEFT JOIN "Ticket" t ON t."vendedorId" = u.id 
        AND t."createdAt" BETWEEN ${dateRange.from} AND ${dateRange.to}
        AND t.status = 'ACTIVE'
        AND t."deletedAt" IS NULL
      LEFT JOIN "Jugada" j ON j."ticketId" = t.id 
        AND j."deletedAt" IS NULL
        AND j."commissionOrigin" = 'USER'
      WHERE u.role = 'VENDEDOR'
        AND u."ventanaId" = ${filters.ventanaId}::uuid
        AND u."isActive" = true
      GROUP BY u.id, u.name, u.code
      ORDER BY u.name ASC
    `;

    const chartData = await prisma.$queryRaw<Array<{
      vendedor_id: string;
      vendedor_name: string;
      vendedor_code: string | null;
      commissions_total: number;
      tickets_count: number;
      ventas_total: number;
    }>>(chartQuery);

    const chartDataFormatted = chartData.map(v => ({
      vendedorId: v.vendedor_id,
      vendedorName: v.vendedor_name,
      vendedorCode: v.vendedor_code,
      commissionsTotal: parseFloat(v.commissions_total.toString()),
      commissionsEarned: parseFloat(v.commissions_total.toString()), // Mismo valor por ahora
      commissionsPaid: 0, // TODO: Calcular desde tabla de pagos de comisiones
      commissionsPending: parseFloat(v.commissions_total.toString()),
      ticketsCount: parseInt(v.tickets_count.toString()),
      ventasTotal: parseFloat(v.ventas_total.toString()),
    }));

    const totalCommissions = chartDataFormatted.reduce((sum, v) => sum + v.commissionsTotal, 0);
    const totalPaid = chartDataFormatted.reduce((sum, v) => sum + v.commissionsPaid, 0);
    const totalPending = chartDataFormatted.reduce((sum, v) => sum + v.commissionsPending, 0);
    const averageCommission = chartDataFormatted.length > 0
      ? totalCommissions / chartDataFormatted.length
      : 0;

    return {
      data: {
        ventana: {
          id: ventana.id,
          name: ventana.name,
          code: ventana.code || '',
        },
        chartData: chartDataFormatted,
        summary: {
          totalCommissions,
          totalPaid,
          totalPending,
          vendedoresCount: chartDataFormatted.length,
          averageCommission: parseFloat(averageCommission.toFixed(2)),
        },
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
      },
    };
  },
};

