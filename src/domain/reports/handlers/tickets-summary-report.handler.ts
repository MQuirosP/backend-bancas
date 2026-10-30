/**
 * Handler de reportes para Resumen Operativo Agregado de Tickets
 */

import { Prisma, TicketStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { resolveDateRange } from '../../../api/v1/utils/reports.utils';
import { DateToken } from '../../../api/v1/types/reports.types';

export interface TicketsSummaryFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  vendedorId?: string;
  bancaId?: string;
  loteriaId?: string;
}

export const TicketsSummaryReportHandler = {
  /**
   * Resumen Operativo Agregado
   */
  async getTicketsSummary(filters: TicketsSummaryFilters) {
    const dateRange = resolveDateRange(filters.date || 'today', filters.fromDate, filters.toDate);

    const ticketFilters = [
      Prisma.sql`t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date`,
      Prisma.sql`(t."deletedAt" IS NULL OR t.status::text = ${TicketStatus.CANCELLED})`
    ];

    if (filters.ventanaId) ticketFilters.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
    if (filters.vendedorId) ticketFilters.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
    if (filters.bancaId) ticketFilters.push(Prisma.sql`t."bancaId" = CAST(${filters.bancaId} AS uuid)`);
    if (filters.loteriaId) ticketFilters.push(Prisma.sql`t."loteriaId" = CAST(${filters.loteriaId} AS uuid)`);

    const whereTicketSQL = Prisma.join(ticketFilters, ' AND ');

    // Consolidación de todas las promesas en una sola consulta SQL utilizando CTEs (Common Table Expressions)
    // Esto evita múltiples Full Table Scans sobre la tabla Ticket y previene el bloqueo del Event Loop
    const summaryQuery = Prisma.sql`
      WITH filtered_tickets AS MATERIALIZED (
        SELECT t.id, t.status, t."totalAmount", t."totalPayout", t."createdAt", t."loteriaId", t."sorteoId"
        FROM "Ticket" t
        WHERE ${whereTicketSQL}
      ),
      kpis AS (
        SELECT
          COALESCE(SUM(CASE WHEN t.status::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO}) THEN t."totalAmount" ELSE 0 END), 0)::float as brutas,
          COALESCE(SUM(CASE WHEN t.status::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO}) THEN t."totalPayout" ELSE 0 END), 0)::float as premios,
          COALESCE(SUM(CASE WHEN t.status::text = ${TicketStatus.CANCELLED} THEN t."totalAmount" ELSE 0 END), 0)::float as anulaciones_monto,
          COALESCE(SUM(CASE WHEN t.status::text = ${TicketStatus.CANCELLED} THEN 1 ELSE 0 END), 0)::int as anulaciones_cantidad,
          COALESCE(SUM(CASE WHEN t.status::text IN (${TicketStatus.PAID}, ${TicketStatus.PAGADO}) THEN t."totalPayout" ELSE 0 END), 0)::float as pagos_pagado,
          COALESCE(SUM(CASE WHEN t.status::text = ${TicketStatus.EVALUATED} THEN t."totalPayout" ELSE 0 END), 0)::float as pagos_pendiente,
          COUNT(t.id)::int as total_tickets
        FROM filtered_tickets t
      ),
      hourly AS (
        SELECT
          EXTRACT(HOUR FROM t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') as hour,
          SUM(t."totalAmount") as amount
        FROM filtered_tickets t
        WHERE t.status::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
        GROUP BY hour
      ),
      activity AS (
        SELECT hour, amount
        FROM hourly
        ORDER BY amount DESC
      ),
      loterias AS (
        SELECT
          l.id as "loteriaId",
          l.name as "loteriaName",
          COALESCE(SUM(t."totalAmount"), 0)::float as "totalVentas",
          COALESCE(SUM(t."totalPayout"), 0)::float as "premios",
          COALESCE(SUM(t."totalAmount") - SUM(t."totalPayout"), 0)::float as "margen"
        FROM filtered_tickets t
        INNER JOIN "Loteria" l ON t."loteriaId" = l.id
        WHERE t.status::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
        GROUP BY l.id, l.name
        ORDER BY "totalVentas" DESC
      ),
      sorteos AS (
        SELECT
          s.id as "sorteoId",
          s.name as "sorteoName",
          COALESCE(SUM(t."totalAmount"), 0)::float as "totalVentas",
          COALESCE(SUM(t."totalPayout"), 0)::float as "premios",
          COALESCE(SUM(t."totalAmount") - SUM(t."totalPayout"), 0)::float as "margen"
        FROM filtered_tickets t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE t.status::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
          ${filters.loteriaId ? Prisma.empty : Prisma.sql`AND 1 = 0`}
        GROUP BY s.id, s.name
        ORDER BY "totalVentas" DESC
      ),
      number_stats AS (
        SELECT number, SUM(amount) as total_amount
        FROM (
          SELECT db.number, db."totalAmount" as amount
          FROM "DailyNumberSales" db
          WHERE db."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            ${filters.ventanaId ? Prisma.sql`AND db."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND db."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
            ${filters.bancaId ? Prisma.sql`AND db."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND db."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
          
          UNION ALL

          SELECT j.number, j.amount
          FROM "Jugada" j
          INNER JOIN filtered_tickets t ON j."ticketId" = t.id
          WHERE j."deletedAt" IS NULL AND j."isExcluded" = false
            AND t.status::text = ${TicketStatus.ACTIVE}
        ) combined_stats
        GROUP BY number
      ),
      numeros AS (
        SELECT 
          COALESCE((SELECT COUNT(*) FROM number_stats), 0)::int as numeros_unicos,
          (SELECT number FROM number_stats ORDER BY total_amount DESC LIMIT 1) as mas_jugado
      )
      SELECT
        (SELECT row_to_json(k) FROM kpis k) as kpis,
        (SELECT COALESCE(json_agg(a), '[]'::json) FROM activity a) as activity,
        (SELECT COALESCE(json_agg(l), '[]'::json) FROM loterias l) as loterias,
        (SELECT COALESCE(json_agg(s), '[]'::json) FROM sorteos s) as sorteos,
        (SELECT row_to_json(n) FROM numeros n) as numeros
    `;

    const summaryResultRaw = await prisma.$queryRaw<any[]>(summaryQuery);
    const summaryResult = summaryResultRaw[0] || {};

    const kpis = summaryResult.kpis || {};
    const brutas = kpis.brutas || 0;
    const premios = kpis.premios || 0;
    const margenNeto = brutas - premios;
    const porcentajeMargen = brutas > 0 ? (margenNeto / brutas) * 100 : 0;
    const anulacionesMonto = kpis.anulaciones_monto || 0;
    const tasaAnulacion = (brutas + anulacionesMonto) > 0 ? (anulacionesMonto / (brutas + anulacionesMonto)) * 100 : 0;

    const activityRes = summaryResult.activity || [];
    let horaPico = null;
    let promedioPorHora = 0;
    if (activityRes.length > 0) {
      horaPico = parseInt(activityRes[0].hour);
      const totalAmount = activityRes.reduce((acc: any, r: any) => acc + parseFloat(r.amount), 0);
      promedioPorHora = totalAmount / activityRes.length;
    }

    const numeros = summaryResult.numeros || {};

    return {
      ventas: {
        brutas,
        premiosGanados: premios,
        margenNeto,
        porcentajeMargen: parseFloat(porcentajeMargen.toFixed(2))
      },
      anulaciones: {
        monto: anulacionesMonto,
        cantidad: kpis.anulaciones_cantidad || 0,
        tasa: parseFloat(tasaAnulacion.toFixed(2))
      },
      pagos: {
        totalPagado: kpis.pagos_pagado || 0,
        totalPendiente: kpis.pagos_pendiente || 0
      },
      numeros: {
        masJugado: numeros.mas_jugado || '--',
        numerosUnicos: numeros.numeros_unicos || 0
      },
      actividad: {
        horaPico,
        promedioPorHora: parseFloat(promedioPorHora.toFixed(2))
      },
      desempeno: {
        byLoteria: summaryResult.loterias || [],
        bySorteo: summaryResult.sorteos || []
      }
    };
  },
};
