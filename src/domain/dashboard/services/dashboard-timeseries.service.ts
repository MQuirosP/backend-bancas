/**
 * Servicio de Series Temporales del Dashboard
 */

import { Prisma } from "../../../generated/prisma/client";
import { AppError } from "../../../core/errors";
import { crDateService } from "../../../utils/crDateService";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { DashboardFilters } from "../dashboard.types";
import {
  getBusinessDateRangeStrings,
  buildTicketBaseFilters,
  formatCostaRicaISO,
  formatCostaRicaDate,
  formatTimeSeriesLabel,
  calculatePreviousPeriodDates,
} from "./dashboard-helpers";
import { DashboardRepository } from "../../../repositories/dashboard.repository";

export class DashboardTimeSeriesService {
  /**
   * Serie temporal: datos agrupados por día u hora para gráficos
   */
  static async getTimeSeries(filters: DashboardFilters) {
    const interval = filters.interval || 'day';
    const granularity = interval;

    // Validación: interval=hour solo si rango <= 7 días
    if (interval === 'hour') {
      const diffDays = Math.ceil((filters.toDate.getTime() - filters.fromDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) {
        throw new AppError('interval=hour solo permitido para rangos <= 7 días', 422);
      }
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isHistorical = toDateStr < todayCRStr && interval !== 'hour';
    const skipExclusion = await isExclusionListEmpty();

    let result: Array<{
      date_bucket: Date;
      total_sales: number;
      total_commissions: number;
      total_tickets: number;
      total_payout: number;
      total_winners: number;
    }> = [];

    if (isHistorical) {
      // Consultar desde AccountStatement para rangos pasados
      let selectClause = Prisma.sql`a.date`;
      let groupByClause = Prisma.sql`a.date`;
      if (interval === 'week') {
        selectClause = Prisma.sql`DATE_TRUNC('week', a.date)`;
        groupByClause = selectClause;
      } else if (interval === 'month') {
        selectClause = Prisma.sql`DATE_TRUNC('month', a.date)`;
        groupByClause = selectClause;
      }

      result = await DashboardRepository.getHistoricalTimeSeries(
        selectClause,
        groupByClause,
        fromDateStr,
        toDateStr,
        {
          bancaId: filters.bancaId,
          ventanaId: filters.ventanaId,
          vendedorId: filters.vendedorId,
        }
      );
    } else {
      // Consulta en tiempo real (involucra hoy o es por hora)
      const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion);
      const dateFormat =
        interval === 'day' || interval === 'week' || interval === 'month'
          ? Prisma.sql`COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )`
          : Prisma.sql`DATE_TRUNC(
              'hour',
              (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
            )`;

      let groupByClause = Prisma.sql`date_bucket`;
      let selectClause = dateFormat;
      if (interval === 'week') {
        selectClause = Prisma.sql`
          DATE_TRUNC('week', 
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )
          )
        `;
        groupByClause = selectClause;
      } else if (interval === 'month') {
        selectClause = Prisma.sql`
          DATE_TRUNC('month', 
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )
          )
        `;
        groupByClause = selectClause;
      }

      result = await DashboardRepository.getRealTimeTimeSeries(
        selectClause,
        groupByClause,
        baseFilters
      );
    }

    // Calcular período anterior si compare=true
    let comparisonData: Array<{
      date: string;
      timestamp: string;
      label: string;
      sales: number;
      commissions: number;
      tickets: number;
      payout: number;
      winners: number;
    }> = [];

    if (filters.compare) {
      const previousPeriod = calculatePreviousPeriodDates(filters.fromDate, filters.toDate);
      const previousFilters: DashboardFilters = {
        ...filters,
        fromDate: previousPeriod.fromDate,
        toDate: previousPeriod.toDate,
        compare: false,
      };
      const { fromDateStr: prevFromDateStr, toDateStr: prevToDateStr } = getBusinessDateRangeStrings(previousFilters);
      const isPrevHistorical = prevToDateStr < todayCRStr && interval !== 'hour';

      let prevResult: Array<{
        date_bucket: Date;
        total_sales: number;
        total_commissions: number;
        total_tickets: number;
        total_payout: number;
        total_winners: number;
      }> = [];

      if (isPrevHistorical) {
        let selectClause = Prisma.sql`a.date`;
        let groupByClause = Prisma.sql`a.date`;
        if (interval === 'week') {
          selectClause = Prisma.sql`DATE_TRUNC('week', a.date)`;
          groupByClause = selectClause;
        } else if (interval === 'month') {
          selectClause = Prisma.sql`DATE_TRUNC('month', a.date)`;
          groupByClause = selectClause;
        }

        prevResult = await DashboardRepository.getHistoricalTimeSeries(
          selectClause,
          groupByClause,
          prevFromDateStr,
          prevToDateStr,
          {
            bancaId: previousFilters.bancaId,
            ventanaId: previousFilters.ventanaId,
            vendedorId: previousFilters.vendedorId,
          }
        );
      } else {
        const prevBaseFilters = buildTicketBaseFilters("t", previousFilters, prevFromDateStr, prevToDateStr, skipExclusion);
        let groupByClause = Prisma.sql`date_bucket`;
        let selectClause = interval === 'day' || interval === 'week' || interval === 'month'
          ? Prisma.sql`COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            )`
          : Prisma.sql`DATE_TRUNC(
              'hour',
              (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')
            )`;

        if (interval === 'week') {
          selectClause = Prisma.sql`
            DATE_TRUNC('week', 
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              )
            )
          `;
          groupByClause = selectClause;
        } else if (interval === 'month') {
          selectClause = Prisma.sql`
            DATE_TRUNC('month', 
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              )
            )
          `;
          groupByClause = selectClause;
        }

        prevResult = await DashboardRepository.getRealTimeTimeSeries(
          selectClause,
          groupByClause,
          prevBaseFilters
        );
      }

      comparisonData = prevResult.map(row => {
        const timestamp = formatCostaRicaISO(row.date_bucket);
        const date = formatCostaRicaDate(row.date_bucket);
        const label = formatTimeSeriesLabel(row.date_bucket, granularity);

        return {
          date,
          timestamp,
          label,
          sales: Number(row.total_sales) || 0,
          commissions: Number(row.total_commissions) || 0,
          tickets: Number(row.total_tickets) || 0,
          payout: Number(row.total_payout) || 0,
          winners: Number(row.total_winners) || 0,
        };
      });
    }

    return {
      timeSeries: result.map(row => {
        const timestamp = formatCostaRicaISO(row.date_bucket);
        const date = formatCostaRicaDate(row.date_bucket);
        const label = formatTimeSeriesLabel(row.date_bucket, granularity);

        return {
          date,
          timestamp,
          label,
          sales: Number(row.total_sales) || 0,
          commissions: Number(row.total_commissions) || 0,
          tickets: Number(row.total_tickets) || 0,
          payout: Number(row.total_payout) || 0,
          winners: Number(row.total_winners) || 0,
        };
      }),
      comparison: filters.compare ? comparisonData : undefined,
      meta: {
        interval,
        granularity,
        timezone: 'America/Costa_Rica',
        dataPoints: result.length,
        comparisonDataPoints: filters.compare ? comparisonData.length : 0,
      },
    };
  }
}
