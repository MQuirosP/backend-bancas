/**
 * Handler de reportes para Análisis por Hora y Día de Semana (Time Analysis)
 */

import { Prisma, TicketStatus, SorteoStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { resolveDateRange } from '../../../api/v1/utils/reports.utils';
import { DateToken } from '../../../api/v1/types/reports.types';
import { resolveBreakdowns } from './reports-common.helper';

export interface TimeAnalysisFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  metric?: 'ventas' | 'tickets' | 'cancelaciones';
  bancaId?: string;
}

export const TimeAnalysisReportHandler = {
  /**
   * Reporte de análisis por hora y día de semana
   */
  async getTimeAnalysis(filters: TimeAnalysisFilters): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const metric = filters.metric || 'ventas';
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    // Filtro base para tickets válidos (mismas condiciones que accounts)
    const validTicketFilter = Prisma.sql`
      AND t."deletedAt" IS NULL
      AND t."isActive" = true
      AND t."status"::text IN (${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
      AND s.status::text = ${SorteoStatus.EVALUATED}
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

    // DESGLOSES (breakdowns) según filtros aplicados
    const tbk = resolveBreakdowns(filters);

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
};
