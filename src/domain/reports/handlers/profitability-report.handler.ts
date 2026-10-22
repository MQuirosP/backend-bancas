/**
 * Handler de reportes para Rentabilidad y Márgenes
 */

import { Prisma, TicketStatus, SorteoStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { resolveDateRange } from '../../../api/v1/utils/reports.utils';
import { DateToken } from '../../../api/v1/types/reports.types';
import { formatDateOnly, resolveBreakdowns } from './reports-common.helper';

export interface ProfitabilityFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  includeComparison?: boolean;
  groupBy?: 'day' | 'week' | 'month';
  bancaId?: string;
}

export const ProfitabilityReportHandler = {
  /**
   * Reporte de rentabilidad y márgenes
   */
  async getProfitability(filters: ProfitabilityFilters): Promise<any> {
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
      WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date
                                  AND ${dateRange.toString}::date
        AND t."status"::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
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
      SELECT SUM(t."totalListeroCommission") as total_comisiones
      FROM "Ticket" t
      WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date
                                  AND ${dateRange.toString}::date
        AND t."status"::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
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
          AND t."status"::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND s.status::text = ${SorteoStatus.EVALUATED}
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
      AND t."status"::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
      AND t."isActive" = true
      AND t."deletedAt" IS NULL
      AND s.status::text = ${SorteoStatus.EVALUATED}
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
};
