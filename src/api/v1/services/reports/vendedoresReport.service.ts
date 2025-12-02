/**
 * Servicio de reportes de vendedores
 */

import { Prisma, TicketStatus } from '@prisma/client';
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
    ticketStatus?: string; // Ej: "ACTIVE,EVALUATED,RESTORED"
    excludeTicketStatus?: string; // Ej: "CANCELLED"
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

    // Construir filtro de status de tickets
    let ticketStatusFilter: Prisma.Sql = Prisma.empty;
    
    if (filters.ticketStatus) {
      // Parsear string como "ACTIVE,EVALUATED,RESTORED"
      const statuses = filters.ticketStatus.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        const validStatuses = statuses.filter(s => Object.values(TicketStatus).includes(s as TicketStatus));
        if (validStatuses.length > 0) {
          ticketStatusFilter = Prisma.sql`AND t.status IN (${Prisma.join(validStatuses.map(s => Prisma.sql`${s}::"TicketStatus"`), ', ')})`;
        }
      }
    } else if (filters.excludeTicketStatus) {
      // Parsear string como "CANCELLED"
      const excludedStatuses = filters.excludeTicketStatus.split(',').map(s => s.trim()).filter(Boolean);
      if (excludedStatuses.length > 0) {
        const validExcludedStatuses = excludedStatuses.filter(s => Object.values(TicketStatus).includes(s as TicketStatus));
        if (validExcludedStatuses.length > 0) {
          ticketStatusFilter = Prisma.sql`AND t.status NOT IN (${Prisma.join(validExcludedStatuses.map(s => Prisma.sql`${s}::"TicketStatus"`), ', ')})`;
        }
      }
    } else {
      // Por defecto: solo ACTIVE, EVALUATED, PAID, y PAGADO (excluir CANCELLED y EXCLUDED)
      ticketStatusFilter = Prisma.sql`AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`;
    }

    // Convertir fechas a strings en formato CR para comparación con businessDate
    const fromDateStr = dateRange.fromString; // YYYY-MM-DD
    const toDateStr = dateRange.toString; // YYYY-MM-DD

    // Query optimizada para comisiones por vendedor
    // Usa businessDate (o createdAt convertido a CR) para filtrar por fecha de negocio
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
        AND (
          COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))
        ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
        AND t."deletedAt" IS NULL
        AND t."isActive" = true
        ${ticketStatusFilter}
      LEFT JOIN "Jugada" j ON j."ticketId" = t.id 
        AND j."deletedAt" IS NULL
        AND j."isActive" = true
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

