/**
 * Servicio de Exposición y Riesgo del Dashboard
 */

import { DashboardFilters } from "../dashboard.types";
import { crDateService } from "../../../utils/crDateService";
import { CacheService } from "../../../core/cache.service";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { getBusinessDateRangeStrings, buildTicketBaseFilters } from "./dashboard-helpers";
import { DashboardRepository } from "../../../repositories/dashboard.repository";

export class DashboardExposureService {
  /**
   * Calcula exposición y riesgo de números y sorteos
   */
  static async calculateExposure(filters: DashboardFilters) {
    const topLimit = filters.top || 10;
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = toDateStr >= todayCRStr;
    const ttl = isToday ? 15 : 300;

    const cacheKey = `dashboard:exposure:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${fromDateStr}:${toDateStr}:${topLimit}:${filters.betType || 'all'}:${filters.status || 'all'}:${filters.loteriaId || 'all'}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        const skipExclusion = await isExclusionListEmpty();
        const baseFilters = buildTicketBaseFilters("t", filters, fromDateStr, toDateStr, skipExclusion, true);

        // 1 sola consulta SQL agrupada delegada a DashboardRepository
        const rows = await DashboardRepository.getExposureRows(
          baseFilters,
          filters.betType,
          filters.status
        );

        if (!rows || rows.length === 0) {
          return {
            topNumbers: [],
            heatmap: [],
            byLoteria: [],
            bySorteo: [],
          };
        }

        // 1. Top Numbers: Agrupado por número y tipo de apuesta
        const topMap = new Map<string, { number: string; betType: string; sales: number; potentialPayout: number; ticketCount: number }>();
        for (const row of rows) {
          const key = `${row.number}_${row.bet_type}`;
          const current = topMap.get(key) || {
            number: row.number,
            betType: row.bet_type,
            sales: 0,
            potentialPayout: 0,
            ticketCount: 0,
          };
          current.sales += Number(row.sales) || 0;
          current.potentialPayout += Number(row.potential_payout) || 0;
          current.ticketCount += Number(row.ticket_count) || 0;
          topMap.set(key, current);
        }
        const topNumbers = Array.from(topMap.values())
          .sort((a, b) => b.sales - a.sales)
          .slice(0, topLimit)
          .map(item => ({
            number: item.number,
            betType: item.betType,
            sales: item.sales,
            potentialPayout: item.potentialPayout,
            ratio: item.sales > 0 ? parseFloat((item.potentialPayout / item.sales).toFixed(2)) : 0,
            ticketCount: item.ticketCount,
          }));

        // 2. Heatmap: Ventas acumuladas de números de sorteos OPEN
        const heatmapMap = new Map<string, number>();
        for (const row of rows) {
          const current = heatmapMap.get(row.number) || 0;
          heatmapMap.set(row.number, current + (Number(row.sales) || 0));
        }
        const heatmap = Array.from(heatmapMap.entries())
          .map(([number, sales]) => ({ number, sales }))
          .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));

        // 3. Estructurar detalle por sorteo (para BySorteo y ByLoteria)
        type SorteoData = {
          sorteoId: string;
          sorteoName: string;
          loteriaId: string;
          loteriaName: string;
          drawTime: Date;
          status: string;
          totalSales: number;
          numbersMap: Map<string, { sales: number; payout: number }>;
        };
        const sorteosMap = new Map<string, SorteoData>();

        for (const row of rows) {
          let sData = sorteosMap.get(row.sorteoId);
          if (!sData) {
            sData = {
              sorteoId: row.sorteoId,
              sorteoName: row.sorteo_name,
              loteriaId: row.loteriaId,
              loteriaName: row.loteria_name,
              drawTime: row.draw_time,
              status: row.sorteo_status,
              totalSales: 0,
              numbersMap: new Map(),
            };
            sorteosMap.set(row.sorteoId, sData);
          }
          const sales = Number(row.sales) || 0;
          const payout = Number(row.potential_payout) || 0;
          sData.totalSales += sales;

          const nData = sData.numbersMap.get(row.number) || { sales: 0, payout: 0 };
          nData.sales += sales;
          nData.payout += payout;
          sData.numbersMap.set(row.number, nData);
        }

        // 4. By Sorteo
        const bySorteo = Array.from(sorteosMap.values())
          .filter(s => s.totalSales > 0)
          .map(s => {
            let maxPayout = 0;
            let criticalNumber: string | null = null;
            const numberEntries = Array.from(s.numbersMap.entries()).map(([num, data]) => ({
              number: num,
              sales: data.sales,
              payout: data.payout,
            }));

            for (const item of numberEntries) {
              if (item.payout > maxPayout) {
                maxPayout = item.payout;
                criticalNumber = item.number;
              }
            }

            const top5 = numberEntries
              .sort((a, b) => b.sales - a.sales)
              .slice(0, 5);

            return {
              sorteoId: s.sorteoId,
              sorteoName: s.sorteoName,
              loteriaName: s.loteriaName,
              drawTime: s.drawTime,
              status: s.status,
              sales: s.totalSales,
              potentialPayout: maxPayout,
              ratio: s.totalSales > 0 ? parseFloat((maxPayout / s.totalSales).toFixed(2)) : 0,
              criticalNumber,
              topNumbers: top5,
            };
          })
          .sort((a, b) => b.ratio - a.ratio);

        // 5. By Loteria: Agregado por lotería
        type LoteriaSummary = {
          loteriaId: string;
          loteriaName: string;
          totalSales: number;
          potentialPayout: number;
          criticalNumber: string | null;
          maxSorteoRisk: number;
        };
        const loteriasMap = new Map<string, LoteriaSummary>();

        for (const s of bySorteo) {
          const sRaw = sorteosMap.get(s.sorteoId)!;
          let lData = loteriasMap.get(sRaw.loteriaId);
          if (!lData) {
            lData = {
              loteriaId: sRaw.loteriaId,
              loteriaName: sRaw.loteriaName,
              totalSales: 0,
              potentialPayout: 0,
              criticalNumber: null,
              maxSorteoRisk: -1,
            };
            loteriasMap.set(sRaw.loteriaId, lData);
          }
          lData.totalSales += s.sales;
          lData.potentialPayout += s.potentialPayout;
          if (s.potentialPayout > lData.maxSorteoRisk) {
            lData.maxSorteoRisk = s.potentialPayout;
            lData.criticalNumber = s.criticalNumber;
          }
        }

        const byLoteria = Array.from(loteriasMap.values())
          .filter(l => l.totalSales > 0)
          .map(l => ({
            loteriaId: l.loteriaId,
            loteriaName: l.loteriaName,
            sales: l.totalSales,
            potentialPayout: l.potentialPayout,
            ratio: l.totalSales > 0 ? parseFloat((l.potentialPayout / l.totalSales).toFixed(2)) : 0,
            status: 'ABIERTO',
            criticalNumber: l.criticalNumber,
          }))
          .sort((a, b) => b.sales - a.sales);

        return {
          topNumbers,
          heatmap,
          byLoteria,
          bySorteo,
        };
      },
      ttl,
      ['dashboard']
    );
  }
}
