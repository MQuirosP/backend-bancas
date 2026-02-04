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

    //  FIX: Query optimizada con CTEs para evitar multiplicación de filas
    // Problema anterior: LEFT JOIN con Jugada multiplicaba t."totalAmount" por número de jugadas
    // Solución: Separar agregación de tickets y jugadas en CTEs independientes
    const chartQuery = Prisma.sql`
      WITH tickets_in_range AS (
        SELECT
          t.id,
          t."vendedorId",
          t."totalAmount"
        FROM "Ticket" t
        WHERE (
            COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))
          ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          AND t."deletedAt" IS NULL
          AND t."isActive" = true
          ${ticketStatusFilter}
      ),
      ventas_por_vendedor AS (
        SELECT
          t."vendedorId",
          COUNT(DISTINCT t.id) as tickets_count,
          COALESCE(SUM(t."totalAmount"), 0) as ventas_total
        FROM tickets_in_range t
        GROUP BY t."vendedorId"
      ),
      comisiones_por_vendedor AS (
        SELECT
          t."vendedorId",
          COALESCE(SUM(j."commissionAmount"), 0) as commissions_total
        FROM tickets_in_range t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."commissionOrigin" = 'USER'
        GROUP BY t."vendedorId"
      )
      SELECT
        u.id as vendedor_id,
        u.name as vendedor_name,
        u.code as vendedor_code,
        COALESCE(c.commissions_total, 0) as commissions_total,
        COALESCE(v.tickets_count, 0) as tickets_count,
        COALESCE(v.ventas_total, 0) as ventas_total
      FROM "User" u
      LEFT JOIN ventas_por_vendedor v ON v."vendedorId" = u.id
      LEFT JOIN comisiones_por_vendedor c ON c."vendedorId" = u.id
      WHERE u.role = 'VENDEDOR'
        AND u."ventanaId" = ${filters.ventanaId}::uuid
        AND u."isActive" = true
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

  /**
   * Ranking de productividad de vendedores
   */
  async getRanking(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    ventanaId?: string;
    top?: number;
    sortBy?: 'ventas' | 'tickets' | 'comisiones' | 'margen';
    includeInactive?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const top = filters.top || 20;
    const sortBy = filters.sortBy || 'ventas';
    const fromDateStr = dateRange.fromString;
    const toDateStr = dateRange.toString;

    // Query principal para ranking de vendedores
    const rankingQuery = Prisma.sql`
      WITH tickets_in_range AS (
        SELECT
          t.id,
          t."vendedorId",
          t."ventanaId",
          t."totalAmount",
          t."totalPayout",
          t."isWinner",
          t."createdAt"
        FROM "Ticket" t
        WHERE (
            COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))
          ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ),
      ventas_por_vendedor AS (
        SELECT
          t."vendedorId",
          COUNT(DISTINCT t.id) as tickets_count,
          COALESCE(SUM(t."totalAmount"), 0) as ventas,
          COALESCE(SUM(CASE WHEN t."isWinner" = true THEN 1 ELSE 0 END), 0) as ganadores,
          COALESCE(SUM(t."totalPayout"), 0) as premios_pagados,
          MIN(t."createdAt") as first_sale_at,
          MAX(t."createdAt") as last_sale_at,
          COUNT(DISTINCT DATE(t."createdAt")) as days_active
        FROM tickets_in_range t
        GROUP BY t."vendedorId"
      ),
      comisiones_por_vendedor AS (
        SELECT
          t."vendedorId",
          COALESCE(SUM(j."commissionAmount"), 0) as comisiones
        FROM tickets_in_range t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
        GROUP BY t."vendedorId"
      )
      SELECT
        u.id as vendedor_id,
        u.name as vendedor_name,
        u."ventanaId" as ventana_id,
        vn.name as ventana_name,
        COALESCE(v.ventas, 0) as ventas,
        COALESCE(v.tickets_count, 0) as tickets_count,
        COALESCE(c.comisiones, 0) as comisiones,
        COALESCE(v.ganadores, 0) as ganadores,
        COALESCE(v.premios_pagados, 0) as premios_pagados,
        v.first_sale_at,
        v.last_sale_at,
        COALESCE(v.days_active, 0) as days_active
      FROM "User" u
      INNER JOIN "Ventana" vn ON u."ventanaId" = vn.id
      LEFT JOIN ventas_por_vendedor v ON v."vendedorId" = u.id
      LEFT JOIN comisiones_por_vendedor c ON c."vendedorId" = u.id
      WHERE u.role = 'VENDEDOR'
        AND u."isActive" = true
        ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
        ${!filters.includeInactive ? Prisma.sql`AND v.ventas IS NOT NULL AND v.ventas > 0` : Prisma.empty}
    `;

    const vendedoresRaw = await prisma.$queryRaw<Array<{
      vendedor_id: string;
      vendedor_name: string;
      ventana_id: string;
      ventana_name: string;
      ventas: number;
      tickets_count: bigint;
      comisiones: number;
      ganadores: bigint;
      premios_pagados: number;
      first_sale_at: Date | null;
      last_sale_at: Date | null;
      days_active: bigint;
    }>>(rankingQuery);

    // Procesar y calcular margen
    let vendedoresData = vendedoresRaw.map(v => {
      const ventas = parseFloat(v.ventas?.toString() || '0');
      const premiosPagados = parseFloat(v.premios_pagados?.toString() || '0');
      const comisiones = parseFloat(v.comisiones?.toString() || '0');
      const ticketsCount = parseInt(v.tickets_count?.toString() || '0');
      const ganadores = parseInt(v.ganadores?.toString() || '0');
      const margen = ventas - premiosPagados - comisiones;
      const avgTicketAmount = ticketsCount > 0 ? ventas / ticketsCount : 0;

      return {
        vendedorId: v.vendedor_id,
        vendedorName: v.vendedor_name,
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        ventas,
        ticketsCount,
        avgTicketAmount: parseFloat(avgTicketAmount.toFixed(2)),
        comisiones,
        ganadores,
        premiosPagados,
        margen,
        daysActive: parseInt(v.days_active?.toString() || '0'),
        firstSaleAt: v.first_sale_at ? formatIsoLocal(v.first_sale_at) : null,
        lastSaleAt: v.last_sale_at ? formatIsoLocal(v.last_sale_at) : null,
        rank: 0, // Se calcula después
        previousRank: null as number | null,
      };
    });

    // Ordenar según sortBy
    const sortKey = sortBy === 'comisiones' ? 'comisiones' : sortBy;
    vendedoresData.sort((a, b) => {
      const valA = a[sortKey as keyof typeof a] as number;
      const valB = b[sortKey as keyof typeof b] as number;
      return valB - valA;
    });

    // Asignar rank
    vendedoresData.forEach((v, index) => {
      v.rank = index + 1;
    });

    // Separar activos e inactivos
    const activeVendedores = vendedoresData.filter(v => v.ventas > 0);
    const inactiveVendedores = vendedoresData.filter(v => v.ventas <= 0);

    // Limitar al top solicitado
    const topVendedores = activeVendedores.slice(0, top);

    // Calcular resumen
    const totalVendedores = vendedoresData.length;
    const totalActiveVendedores = activeVendedores.length;
    const totalInactiveVendedores = inactiveVendedores.length;
    const totalVentas = activeVendedores.reduce((sum, v) => sum + v.ventas, 0);
    const totalTickets = activeVendedores.reduce((sum, v) => sum + v.ticketsCount, 0);
    const averagePerVendedor = totalActiveVendedores > 0 ? totalVentas / totalActiveVendedores : 0;
    const averageTicketsPerVendedor = totalActiveVendedores > 0 ? totalTickets / totalActiveVendedores : 0;

    const summary = {
      totalVendedores,
      activeVendedores: totalActiveVendedores,
      inactiveVendedores: totalInactiveVendedores,
      totalVentas,
      totalTickets,
      averagePerVendedor: parseFloat(averagePerVendedor.toFixed(2)),
      averageTicketsPerVendedor: parseFloat(averageTicketsPerVendedor.toFixed(2)),
    };

    // Inactivos con días desde última venta
    const inactiveData = filters.includeInactive ? inactiveVendedores.map(v => ({
      vendedorId: v.vendedorId,
      vendedorName: v.vendedorName,
      ventanaName: v.ventanaName,
      daysSinceLastSale: v.lastSaleAt ? Math.floor((Date.now() - new Date(v.lastSaleAt).getTime()) / (1000 * 60 * 60 * 24)) : null,
      lastSaleAt: v.lastSaleAt,
    })) : [];

    return {
      data: {
        summary,
        vendedores: topVendedores,
        ...(filters.includeInactive && inactiveData.length > 0 && { inactive: inactiveData }),
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        sortBy,
      },
    };
  },
};

