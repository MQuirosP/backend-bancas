/**
 * Servicio de Resumen y Entidades del Dashboard
 * 
 * KPIs del período + monthToDate y desgloses por vendedor basados en AccountStatement.
 */

import { Prisma } from "../../../generated/prisma/client";
import { crDateService } from "../../../utils/crDateService";
import { CacheService } from "../../../core/cache.service";
import { DashboardRepository } from "../../../repositories/dashboard.repository";

export class DashboardSummaryEntitiesService {
  /**
   * GET /admin/dashboard/summary
   * KPIs del período + monthToDate + byVentana con balances.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  static async calculateDashboardSummary(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    const fromDateStr = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr   = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr  = crDateService.dateUTCToCRString(new Date());
    const isToday     = toDateStr >= todayCRStr;
    const ttl         = isToday ? 30 : 300;
    const cacheKey    = `dashboard:summary:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${fromDateStr}:${toDateStr}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        const nowCRStr    = crDateService.dateUTCToCRString(new Date());
        const currentMonth = nowCRStr.substring(0, 7); // YYYY-MM

        const bancaFilter   = filters.bancaId
          ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)`
          : Prisma.empty;
        const ventanaFilter = filters.ventanaId
          ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)`
          : Prisma.empty;

        const [byVentanaRaw, mtdRaw] = await DashboardRepository.getDashboardSummaryData(
          fromDateStr,
          toDateStr,
          currentMonth,
          bancaFilter,
          ventanaFilter
        );

        // Mapear byVentana y calcular derivados
        const byVentana = byVentanaRaw.map((r) => {
          const totalSales        = Number(r.total_sales);
          const totalPayouts      = Number(r.total_payouts);
          const listeroCommission = Number(r.listero_commission);
          const vendedorCommission= Number(r.vendedor_commission);
          const remainingBalance  = Number(r.remaining_balance);
          const vendedoresRemainingBalance = Number(r.vendedores_remaining_balance);
          const net    = totalSales - totalPayouts - listeroCommission;
          const margin = totalSales > 0 ? parseFloat(((net / totalSales) * 100).toFixed(2)) : 0;
          return {
            ventanaId:          r.ventana_id,
            ventanaName:        r.ventana_name,
            isActive:           r.is_active,
            totalSales:         parseFloat(totalSales.toFixed(2)),
            totalPayouts:       parseFloat(totalPayouts.toFixed(2)),
            listeroCommission:  parseFloat(listeroCommission.toFixed(2)),
            vendedorCommission: parseFloat(vendedorCommission.toFixed(2)),
            net:                parseFloat(net.toFixed(2)),
            margin,
            ticketCount:        Number(r.ticket_count),
            remainingBalance:   parseFloat(remainingBalance.toFixed(2)),
            vendedoresRemainingBalance: parseFloat(vendedoresRemainingBalance.toFixed(2)),
            cxcAmount:          parseFloat(Math.max(remainingBalance, 0).toFixed(2)),
            cxpAmount:          parseFloat(Math.max(-remainingBalance, 0).toFixed(2)),
          };
        });

        // KPIs globales — suma de byVentana (ya filtrado por RBAC)
        const totSales   = byVentana.reduce((s, v) => s + v.totalSales, 0);
        const totPayouts = byVentana.reduce((s, v) => s + v.totalPayouts, 0);
        const totListero = byVentana.reduce((s, v) => s + v.listeroCommission, 0);
        const totVend    = byVentana.reduce((s, v) => s + v.vendedorCommission, 0);
        const totTickets = byVentana.reduce((s, v) => s + v.ticketCount, 0);
        const totNet     = totSales - totPayouts - totListero;
        const totMargin  = totSales > 0 ? parseFloat(((totNet / totSales) * 100).toFixed(2)) : 0;

        const kpis = {
          totalSales:         parseFloat(totSales.toFixed(2)),
          totalPayouts:       parseFloat(totPayouts.toFixed(2)),
          listeroCommission:  parseFloat(totListero.toFixed(2)),
          vendedorCommission: parseFloat(totVend.toFixed(2)),
          totalNet:           parseFloat(totNet.toFixed(2)),
          margin:             totMargin,
          ticketCount:        totTickets,
        };

        // monthToDate
        const mtd = mtdRaw[0] ?? { total_sales: '0', total_payouts: '0', listero_commission: '0', vendedor_commission: '0' };
        const mtdSales   = Number(mtd.total_sales);
        const mtdPayouts = Number(mtd.total_payouts);
        const mtdListero = Number(mtd.listero_commission);
        const mtdVend    = Number(mtd.vendedor_commission);
        const mtdNet     = mtdSales - mtdPayouts - mtdListero;
        const monthToDate = {
          totalSales:         parseFloat(mtdSales.toFixed(2)),
          totalPayouts:       parseFloat(mtdPayouts.toFixed(2)),
          listeroCommission:  parseFloat(mtdListero.toFixed(2)),
          vendedorCommission: parseFloat(mtdVend.toFixed(2)),
          totalNet:           parseFloat(mtdNet.toFixed(2)),
          margin:             mtdSales > 0 ? parseFloat(((mtdNet / mtdSales) * 100).toFixed(2)) : 0,
        };

        return {
          kpis,
          monthToDate,
          byVentana,
          meta: {
            fromAt:       filters.fromDate.toISOString(),
            toAt:         filters.toDate.toISOString(),
            currentMonth,
            generatedAt:  new Date().toISOString(),
          },
        };
      },
      ttl,
      ['dashboard'],
      false
    );
  }

  /**
   * GET /admin/dashboard/entities
   * Desglose por vendedor con balances acumulados.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  static async calculateDashboardEntities(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    const fromDateStr  = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr    = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr   = crDateService.dateUTCToCRString(new Date());
    const isToday      = toDateStr >= todayCRStr;
    const ttl          = isToday ? 30 : 300;
    const cacheKey     = `dashboard:entities:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${fromDateStr}:${toDateStr}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        const nowCRStr     = crDateService.dateUTCToCRString(new Date());
        const currentMonth = nowCRStr.substring(0, 7);

        const bancaFilter   = filters.bancaId
          ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)`
          : Prisma.empty;
        const ventanaFilter = filters.ventanaId
          ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)`
          : Prisma.empty;

        const rows = await DashboardRepository.getDashboardEntitiesRows(
          fromDateStr,
          toDateStr,
          currentMonth,
          bancaFilter,
          ventanaFilter
        );

        const vendedores = rows.map((r) => {
          const totalSales         = Number(r.total_sales);
          const totalPayouts       = Number(r.total_payouts);
          const listeroCommission  = Number(r.listero_commission);
          const vendedorCommission = Number(r.vendedor_commission);
          const remainingBalance   = Number(r.remaining_balance);
          const net    = totalSales - totalPayouts - vendedorCommission;
          const margin = totalSales > 0 ? parseFloat(((net / totalSales) * 100).toFixed(2)) : 0;
          return {
            vendedorId:          r.vendedor_id,
            vendedorName:        r.vendedor_name,
            vendedorCode:        r.vendedor_code ?? null,
            isActive:            r.is_active,
            ventanaId:           r.ventana_id,
            ventanaName:         r.ventana_name,
            totalSales:          parseFloat(totalSales.toFixed(2)),
            totalPayouts:        parseFloat(totalPayouts.toFixed(2)),
            listeroCommission:   parseFloat(listeroCommission.toFixed(2)),
            vendedorCommission:  parseFloat(vendedorCommission.toFixed(2)),
            net:                 parseFloat(net.toFixed(2)),
            margin,
            ticketCount:         Number(r.ticket_count),
            remainingBalance:    parseFloat(remainingBalance.toFixed(2)),
            cxcAmount:           parseFloat(Math.max(remainingBalance, 0).toFixed(2)),
            cxpAmount:           parseFloat(Math.max(-remainingBalance, 0).toFixed(2)),
          };
        });

        return {
          vendedores,
          meta: {
            fromAt:       filters.fromDate.toISOString(),
            toAt:         filters.toDate.toISOString(),
            currentMonth,
            generatedAt:  new Date().toISOString(),
          },
        };
      },
      ttl,
      ['dashboard'],
      false
    );
  }
}
