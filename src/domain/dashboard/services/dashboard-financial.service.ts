/**
 * Servicio Financiero y de Métricas del Dashboard
 */

import { Prisma, Role } from "../../../generated/prisma/client";
import { crDateService } from "../../../utils/crDateService";
import { resolveDateRange } from "../../../utils/dateRange";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { getPreviousMonthFinalBalancesBatch } from "../../accounts/accounts.balances";
import { getMonthlyRemainingBalancesBatch } from "../../accounts/accounts.service";
import { ReportCache } from "../../../utils/reportCache";
import { PerformanceMonitor, measureAsync } from "../../../utils/performanceMonitor";
import logger from "../../../core/logger";
import { DashboardRepository } from "../../../repositories/dashboard.repository";
import { DashboardTimeSeriesService } from "./dashboard-timeseries.service";
import { DashboardExposureService } from "./dashboard-exposure.service";
import { DashboardAlertsService } from "./dashboard-alerts.service";
import {
  DashboardFilters,
  GananciaResult,
  CxCResult,
  CxPResult,
  DashboardSummary,
} from "../dashboard.types";
import {
  getBusinessDateRangeStrings,
  parseDateStartDbDate,
  parseDateEndDbDate,
} from "./dashboard-helpers";

export class DashboardFinancialService {
  /**
   * Calcula ganancia: Sum de comisiones + premium retenido
   * Incluye desglose completo por ventana y lotería
   */
  static async calculateGanancia(filters: DashboardFilters, role?: Role): Promise<GananciaResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);

    let byVentanaResult: Array<{
      ventana_id: string;
      ventana_name: string;
      is_active: boolean;
      total_sales: number;
      total_payouts: number;
      total_tickets: number;
      winning_tickets: number;
      commission_user: number;
      commission_ventana: number;
    }> = [];

    // Siempre consultar desde AccountStatement
    const statements = await DashboardRepository.getVentanaStatements(
      fromDateStr,
      toDateStr,
      { bancaId: filters.bancaId, ventanaId: filters.ventanaId }
    );

    // Contar ganadores con SQL crudo para forzar uso del índice parcial
    const winnerCountRows = await DashboardRepository.getWinnerCountRows(
      fromDateStr,
      toDateStr,
      { bancaId: filters.bancaId, ventanaId: filters.ventanaId, vendedorId: filters.vendedorId }
    );

    const winnersMap = new Map<string, number>();
    for (const w of winnerCountRows) {
      if (w.ventana_id) {
        winnersMap.set(w.ventana_id, Number(w.count) || 0);
      }
    }

    byVentanaResult = statements.map(st => ({
      ventana_id: st.ventana_id,
      ventana_name: st.ventana_name,
      is_active: st.is_active,
      total_sales: Number(st.total_sales) || 0,
      total_payouts: Number(st.total_payouts) || 0,
      total_tickets: Number(st.total_tickets) || 0,
      winning_tickets: winnersMap.get(st.ventana_id) || 0,
      commission_user: Number(st.commission_user) || 0,
      commission_ventana: Number(st.commission_ventana) || 0
    }));

    const byLoteriaResult = await DashboardRepository.getByLoteriaStats(
      fromDateStr,
      toDateStr,
      { bancaId: filters.bancaId, ventanaId: filters.ventanaId, vendedorId: filters.vendedorId }
    );

    // Obtener pagos y cobros del periodo para calcular periodBalance
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const paymentsWhere: Prisma.AccountPaymentWhereInput = {
      date: {
        gte: rangeStart,
        lte: rangeEnd,
      },
      isReversed: false,
      ventanaId: { not: null },
      ...(filters.ventanaId && { ventanaId: filters.ventanaId }),
      ...(filters.bancaId && { ventana: { bancaId: filters.bancaId } }),
    };

    const payments = await DashboardRepository.getAccountPayments(paymentsWhere);

    // Agrupar pagos y cobros por ventana
    const paymentsByVentana = new Map<string, { paid: number; collected: number }>();
    for (const payment of payments) {
      if (!payment.ventanaId) continue;

      const existing = paymentsByVentana.get(payment.ventanaId) || { paid: 0, collected: 0 };
      if (payment.type === 'payment') {
        existing.paid += payment.amount;
      } else if (payment.type === 'collection') {
        existing.collected += payment.amount;
      }
      paymentsByVentana.set(payment.ventanaId, existing);
    }

    // Totales de comisiones
    const commissionUserTotal = byVentanaResult.reduce((sum, v) => sum + v.commission_user, 0);
    const commissionVentanaTotal = byVentanaResult.reduce((sum, v) => sum + v.commission_ventana, 0);

    // Mapear desglose por ventana
    const byVentana = byVentanaResult.map(v => {
      const sales = v.total_sales;
      const payout = v.total_payouts;
      const commissionUser = v.commission_user;
      const commissionVentana = v.commission_ventana;
      const totalCommissions = commissionUser + commissionVentana;
      const net = role === Role.ADMIN
        ? sales - payout - commissionVentana
        : sales - payout - commissionUser;
      const margin = sales > 0 ? (net / sales) * 100 : 0;
      const winRate = v.total_tickets > 0 ? (v.winning_tickets / v.total_tickets) * 100 : 0;

      const paymentData = paymentsByVentana.get(v.ventana_id) || { paid: 0, collected: 0 };
      const periodBalance = (sales - payout - commissionVentana) - paymentData.collected + paymentData.paid;

      return {
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        sales,
        amount: totalCommissions,
        commissions: totalCommissions,
        commissionUser,
        commissionVentana,
        payout,
        net,
        margin: parseFloat(margin.toFixed(2)),
        tickets: v.total_tickets,
        winners: v.winning_tickets,
        winRate: parseFloat(winRate.toFixed(2)),
        isActive: v.is_active,
        periodBalance: parseFloat(periodBalance.toFixed(2)),
      };
    });

    // Mapear desglose por lotería
    const byLoteria = byLoteriaResult.map(l => {
      const sales = Number(l.total_sales) || 0;
      const payout = Number(l.total_payouts) || 0;
      const commissionUser = Number(l.commission_user) || 0;
      const commissionVentana = Number(l.commission_ventana) || 0;
      const totalCommissions = commissionUser + commissionVentana;
      const net = role === Role.ADMIN
        ? sales - payout - commissionVentana
        : sales - payout - commissionUser;
      const margin = sales > 0 ? (net / sales) * 100 : 0;

      return {
        loteriaId: l.loteria_id,
        loteriaName: l.loteria_name,
        sales,
        amount: totalCommissions,
        commissions: totalCommissions,
        commissionUser,
        commissionVentana,
        payout,
        net,
        margin: parseFloat(margin.toFixed(2)),
        tickets: Number(l.total_tickets) || 0,
        winners: Number(l.winning_tickets) || 0,
        isActive: l.is_active,
      };
    });

    const totalSales = byVentana.reduce((sum, v) => sum + v.sales, 0);
    const totalPayouts = byVentana.reduce((sum, v) => sum + v.payout, 0);
    const totalNet = byVentana.reduce((sum, v) => sum + v.net, 0);
    const totalAmount = commissionUserTotal + commissionVentanaTotal;
    const margin = totalSales > 0 ? (totalNet / totalSales) * 100 : 0;

    return {
      totalAmount,
      totalSales,
      totalPayouts,
      totalNet,
      margin: parseFloat(margin.toFixed(2)),
      commissionUserTotal,
      commissionVentanaTotal,
      byVentana,
      byLoteria,
    };
  }

  /**
   * Calcula CxC: Monto que ventana debe al banco por premios no pagados
   */
  static async calculateCxC(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    const dimension = filters.cxcDimension || 'ventana';

    if (dimension === 'vendedor') {
      return this.calculateCxCByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const ventanaData = await DashboardRepository.getCxCVentanaData(rangeStart, rangeEnd, {
      ventanaId: filters.ventanaId,
      bancaId: filters.bancaId,
    });

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVentanaIds = ventanaData.map(v => v.ventana_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "ventana", allVentanaIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIds,
        filters.bancaId
      )
    ]);

    const byVentana = ventanaData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.ventana_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      const accumulatedBalance = accumulatedBalances.get(v.ventana_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        amount: accumulatedBalance > 0 ? accumulatedBalance : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVentana.reduce((sum, v) => sum + v.amount, 0), 
      byVentana 
    };
  }

  /**
   * Calcula CxC agrupado por vendedor
   */
  static async calculateCxCByVendedor(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const vendedorData = await DashboardRepository.getCxCVendedorData(rangeStart, rangeEnd, {
      ventanaId: filters.ventanaId,
      bancaId: filters.bancaId,
    });

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVendedorIds = vendedorData.map(v => v.vendedor_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "vendedor", allVendedorIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIds,
        filters.bancaId
      )
    ]);

    const byVendedor = vendedorData.map((v) => {
      const totalVendedorCommission = Number(v.commission_user) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalVendedorCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.vendedor_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      const accumulatedBalance = accumulatedBalances.get(v.vendedor_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        vendedorId: v.vendedor_id,
        vendedorName: v.vendedor_name,
        vendedorCode: v.vendedor_code || undefined,
        ventanaId: v.ventana_id || undefined,
        ventanaName: v.ventana_name || undefined,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0,
        vendedorCommission: totalVendedorCommission,
        totalListeroCommission: Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0,
        totalVendedorCommission,
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        amount: accumulatedBalance > 0 ? accumulatedBalance : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVendedor.reduce((sum, v) => sum + v.amount, 0), 
      byVendedor 
    };
  }

  /**
   * Calcula CxP: Monto que el banco debe a la ventana por comisiones o saldos a favor
   */
  static async calculateCxP(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const dimension = filters.cxcDimension || 'ventana';

    if (dimension === 'vendedor') {
      return this.calculateCxPByVendedor(filters, role);
    }

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const ventanaData = await DashboardRepository.getCxCVentanaData(rangeStart, rangeEnd, {
      ventanaId: filters.ventanaId,
      bancaId: filters.bancaId,
    });

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVentanaIds = ventanaData.map(v => v.ventana_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "ventana", allVentanaIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "ventana",
        allVentanaIds,
        filters.bancaId
      )
    ]);

    const byVentana = ventanaData.map((v) => {
      const totalListeroCommission = Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalListeroCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.ventana_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      const accumulatedBalance = accumulatedBalances.get(v.ventana_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        ventanaId: v.ventana_id,
        ventanaName: v.ventana_name,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: totalListeroCommission,
        vendedorCommission: Number(v.commission_user),
        totalListeroCommission,
        totalVendedorCommission: Number(v.commission_user),
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        totalPaidToVentana: 0,
        amount: accumulatedBalance < 0 ? Math.abs(accumulatedBalance) : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVentana.reduce((sum, v) => sum + v.amount, 0), 
      byVentana 
    };
  }

  /**
   * Calcula CxP agrupado por vendedor
   */
  static async calculateCxPByVendedor(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const rangeStart = parseDateStartDbDate(fromDateStr);
    const rangeEnd = parseDateEndDbDate(toDateStr);

    const vendedorData = await DashboardRepository.getCxCVendedorData(rangeStart, rangeEnd, {
      ventanaId: filters.ventanaId,
      bancaId: filters.bancaId,
    });

    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);
    const monthRangeCheck = resolveDateRange('month');
    const todayRangeCheck = resolveDateRange('today');
    const { startDateCRStr: monthStartCheckStr } = crDateService.dateRangeUTCToCRStrings(monthRangeCheck.fromAt, todayRangeCheck.toAt);
    const isMonthComplete = fromDateStr === monthStartCheckStr && toDateStr === nowCRStr;

    const allVendedorIds = vendedorData.map(v => v.vendedor_id);

    const [periodPreviousMonthBalances, accumulatedBalances] = await Promise.all([
      (async () => {
        const firstDayOfMonth = new Date(Date.UTC(getCRLocalComponents(filters.fromDate).year, getCRLocalComponents(filters.fromDate).month - 1, 1));
        if (filters.fromDate.getTime() <= firstDayOfMonth.getTime() && filters.toDate.getTime() >= firstDayOfMonth.getTime()) {
          return getPreviousMonthFinalBalancesBatch(effectiveMonth, "vendedor", allVendedorIds, filters.bancaId);
        }
        return new Map<string, number>();
      })(),
      getMonthlyRemainingBalancesBatch(
        effectiveMonth,
        "vendedor",
        allVendedorIds,
        filters.bancaId
      )
    ]);

    const byVendedor = vendedorData.map((v) => {
      const totalVendedorCommission = Number(v.commission_user) || 0;
      const baseBalance = Number(v.total_sales) - Number(v.total_payouts) - totalVendedorCommission;
      const previousMonthBalance = periodPreviousMonthBalances.get(v.vendedor_id) || 0;
      const periodRemainingBalance = previousMonthBalance + baseBalance - Number(v.total_collected) + Number(v.total_paid);
      
      const accumulatedBalance = accumulatedBalances.get(v.vendedor_id) || 0;
      const recalculatedRemainingBalance = isMonthComplete ? 0 : periodRemainingBalance;

      return {
        vendedorId: v.vendedor_id,
        vendedorName: v.vendedor_name,
        vendedorCode: v.vendedor_code || undefined,
        ventanaId: v.ventana_id || undefined,
        ventanaName: v.ventana_name || undefined,
        totalSales: Number(v.total_sales),
        totalPayouts: Number(v.total_payouts),
        listeroCommission: Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0,
        vendedorCommission: totalVendedorCommission,
        totalListeroCommission: Number(v.listero_commission_snapshot) || Number(v.commission_ventana_raw) || 0,
        totalVendedorCommission,
        totalPaid: Number(v.total_paid),
        totalPaidOut: Number(v.total_paid),
        totalCollected: Number(v.total_collected),
        totalPaidToCustomer: Number(v.total_paid_to_customer),
        totalPaidToVentana: 0,
        amount: accumulatedBalance < 0 ? Math.abs(accumulatedBalance) : 0,
        remainingBalance: recalculatedRemainingBalance,
        monthlyAccumulated: { remainingBalance: accumulatedBalance },
        isActive: v.is_active,
      };
    }).sort((a, b) => b.amount - a.amount);

    return { 
      totalAmount: byVendedor.reduce((sum, v) => sum + v.amount, 0), 
      byVendedor 
    };
  }

  /**
   * Obtiene saldos acumulados mensuales en lote
   */
  static async getAccumulatedBalancesBatch(
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string
  ): Promise<Record<string, number>> {
    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const effectiveMonth = nowCRStr.substring(0, 7);

    const balancesMap = await getMonthlyRemainingBalancesBatch(
      effectiveMonth,
      dimension,
      entityIds,
      bancaId
    );

    const result: Record<string, number> = {};
    balancesMap.forEach((balance, id) => {
      result[id] = balance;
    });

    return result;
  }

  /**
   * Resumen general: totales de ventas, pagos, comisiones
   */
  static async getSummary(filters: DashboardFilters, role?: Role): Promise<DashboardSummary> {
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = toDateStr >= todayCRStr;
    const ttlSeconds = isToday ? 15 : 3600;
    const cacheKey = `dashboard:summary:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${fromDateStr}:${toDateStr}:${role || 'all'}`;

    return ReportCache.getOrCompute(cacheKey, ttlSeconds, async () => {
      const statementSummaryRows = await DashboardRepository.getStatementSummaryRows(
        fromDateStr,
        toDateStr,
        {
          bancaId: filters.bancaId,
          ventanaId: filters.ventanaId,
          vendedorId: filters.vendedorId,
        }
      );

      const winningCountRows = await DashboardRepository.getWinnerCountRows(
        fromDateStr,
        toDateStr,
        {
          bancaId: filters.bancaId,
          ventanaId: filters.ventanaId,
          vendedorId: filters.vendedorId,
        }
      );
      const winningCount = winningCountRows.reduce((sum, r) => sum + Number(r.count), 0);

      const row = statementSummaryRows[0] || {
        total_sales: 0,
        total_payouts: 0,
        total_tickets: 0,
        commission_user: 0,
        commission_ventana: 0,
      };

      const totalSales = Number(row.total_sales) || 0;
      const totalPayouts = Number(row.total_payouts) || 0;
      const totalTickets = Number(row.total_tickets) || 0;
      const winningTickets = winningCount;
      const commissionUser = Number(row.commission_user) || 0;
      const commissionVentana = Number(row.commission_ventana) || 0;
      const totalCommissions = commissionUser + commissionVentana;
      const net = role === Role.ADMIN
        ? totalSales - totalPayouts - commissionVentana
        : totalSales - totalPayouts - commissionUser;
      const margin = totalSales > 0 ? (net / totalSales) * 100 : 0;
      const winRate = totalTickets > 0 ? (winningTickets / totalTickets) * 100 : 0;

      const gananciaListeros = commissionVentana - commissionUser;
      const gananciaBanca = net;

      return {
        totalSales,
        totalPayouts,
        totalCommissions,
        commissionUser,
        commissionVentana,
        commissionVentanaTotal: commissionVentana,
        gananciaListeros,
        gananciaBanca,
        totalTickets,
        winningTickets,
        net,
        margin: parseFloat(margin.toFixed(2)),
        winRate: parseFloat(winRate.toFixed(2)),
      };
    });
  }

  /**
   * Obtiene ranking y datos paginados de vendedores
   */
  static async getVendedores(filters: DashboardFilters) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const offset = (page - 1) * pageSize;
    const orderBy = filters.orderBy || 'sales';
    const order = filters.order || 'desc';

    const orderClause = {
      sales: Prisma.sql`total_sales`,
      commissions: Prisma.sql`total_commissions`,
      tickets: Prisma.sql`total_tickets`,
      winners: Prisma.sql`winning_tickets`,
      avgTicket: Prisma.sql`avg_ticket`,
      payout: Prisma.sql`total_payout`,
      net: Prisma.sql`net`,
      margin: Prisma.sql`margin`,
    }[orderBy] || Prisma.sql`total_sales`;

    const orderDirection = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(filters);

    const [result, total] = await Promise.all([
      DashboardRepository.getVendedoresStats(
        fromDateStr,
        toDateStr,
        {
          bancaId: filters.bancaId,
          ventanaId: filters.ventanaId,
          vendedorId: filters.vendedorId,
        },
        orderClause,
        orderDirection,
        pageSize,
        offset
      ),
      DashboardRepository.getVendedoresCount(
        fromDateStr,
        toDateStr,
        {
          bancaId: filters.bancaId,
          ventanaId: filters.ventanaId,
          vendedorId: filters.vendedorId,
        }
      )
    ]);

    const byVendedor = result.map((row) => {
      const sales = Number(row.total_sales) || 0;
      const payout = Number(row.total_payout) || 0;
      const commissionUser = Number(row.commission_user) || 0;
      const commissionVentana = Number(row.commission_ventana) || 0;
      // net = sales - payout - commissionUser (comisión del vendedor)
      const net = sales - payout - commissionUser;
      const margin = sales > 0 ? (net / sales) * 100 : 0;
      const tickets = Number(row.total_tickets) || 0;
      const winners = Number(row.winning_tickets) || 0;
      const winRate = tickets > 0 ? (winners / tickets) * 100 : 0;

      return {
        vendedorId: row.vendedor_id,
        vendedorName: row.vendedor_name,
        vendedorCode: row.vendedor_code || undefined,
        ventanaId: row.ventana_id || undefined,
        ventanaName: row.ventana_name || undefined,
        sales,
        payout,
        commissionUser,
        commissionVentana,
        net,
        margin: parseFloat(margin.toFixed(2)),
        tickets,
        winners,
        avgTicket: Number(row.avg_ticket) || 0,
        winRate: parseFloat(winRate.toFixed(2)),
        isActive: row.is_active,
      };
    });

    const pagination = {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };

    return {
      byVendedor,
      vendedores: byVendedor,
      pagination,
      meta: pagination,
    };
  }

  /**
   * Calcula el período anterior para comparación
   */
  static async calculatePreviousPeriod(filters: DashboardFilters, role?: Role) {
    const diffMs = filters.toDate.getTime() - filters.fromDate.getTime();
    const previousFromDate = new Date(filters.fromDate.getTime() - diffMs);
    const previousToDate = new Date(filters.fromDate.getTime() - 1);

    const previousFilters: DashboardFilters = {
      ...filters,
      fromDate: previousFromDate,
      toDate: previousToDate,
    };

    const { fromDateStr, toDateStr } = getBusinessDateRangeStrings(previousFilters);

    let row = {
      total_sales: 0,
      total_payouts: 0,
      total_tickets: 0,
      winning_tickets: 0,
      commission_user: 0,
      commission_ventana: 0,
    };

    const stats = await DashboardRepository.getStatementSummaryRows(
      fromDateStr,
      toDateStr,
      {
        bancaId: previousFilters.bancaId,
        ventanaId: previousFilters.ventanaId,
        vendedorId: previousFilters.vendedorId,
      }
    );

    const winningTicketsCountRows = await DashboardRepository.getWinnerCountRows(
      fromDateStr,
      toDateStr,
      {
        bancaId: previousFilters.bancaId,
        ventanaId: previousFilters.ventanaId,
        vendedorId: previousFilters.vendedorId,
      }
    );
    const winningTicketsCount = winningTicketsCountRows.reduce((sum, r) => sum + Number(r.count), 0);

    if (stats && stats[0]) {
      row = {
        total_sales: Number(stats[0].total_sales) || 0,
        total_payouts: Number(stats[0].total_payouts) || 0,
        total_tickets: Number(stats[0].total_tickets) || 0,
        winning_tickets: winningTicketsCount,
        commission_user: Number(stats[0].commission_user) || 0,
        commission_ventana: Number(stats[0].commission_ventana) || 0,
      };
    }

    const sales = Number(row.total_sales) || 0;
    const payouts = Number(row.total_payouts) || 0;
    const commissionUser = Number(row.commission_user) || 0;
    const commissionVentana = Number(row.commission_ventana) || 0;
    const totalCommissions = commissionUser + commissionVentana;

    const net = role === Role.ADMIN
      ? sales - payouts - commissionVentana
      : sales - payouts - commissionUser;
    const margin = sales > 0 ? (net / sales) * 100 : 0;

    return {
      sales,
      payouts,
      net,
      margin: parseFloat(margin.toFixed(2)),
      tickets: Number(row.total_tickets) || 0,
      winners: Number(row.winning_tickets) || 0,
      commissions: totalCommissions,
      commissionUser,
      commissionVentana,
      commissionVentanaTotal: commissionVentana,
      range: {
        fromAt: previousFromDate.toISOString(),
        toAt: previousToDate.toISOString(),
      },
    };
  }

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   */
  static async getFullDashboard(filters: DashboardFilters, role?: Role) {
    const fromDateStr = crDateService.dateUTCToCRString(filters.fromDate);
    const toDateStr = crDateService.dateUTCToCRString(filters.toDate);
    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = toDateStr >= todayCRStr;
    const ttl = isToday ? 15 : 300;
    const cacheKey = `dashboard:full:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${filters.loteriaId || 'all'}:${filters.scope || 'all'}:${filters.dimension || 'all'}:${filters.interval || 'day'}:${fromDateStr}:${toDateStr}:${role || 'all'}`;

    return ReportCache.getOrCompute(
      cacheKey,
      ttl,
      async () => {
        const monitor = new PerformanceMonitor('dashboard.getFullDashboard');
        monitor.start('INIT');

        const startTime = Date.now();
        let queryCount = 0;

        monitor.checkpoint('BEFORE_PARALLEL_QUERIES');

        const rangeMs = filters.toDate.getTime() - filters.fromDate.getTime();
        const LARGE_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
        const isLargeRange = rangeMs > LARGE_RANGE_MS;
        let exposureTrimmed = false;
        let exposureFilters: DashboardFilters = filters;
        if (isLargeRange) {
          const todayRange = resolveDateRange('today');
          exposureFilters = {
            ...filters,
            fromDate: todayRange.fromAt,
            toDate: todayRange.toAt,
          };
          exposureTrimmed = true;
        }

        const mGanancia = await measureAsync('calculateGanancia', () => this.calculateGanancia(filters, role).then((r) => {
          queryCount += 2;
          return r;
        }));

        const mSummary = await measureAsync('getSummary', () => this.getSummary(filters, role).then((r) => {
          queryCount += 1;
          return r;
        }));
        const measuredPhase1 = [mGanancia, mSummary];

        const mTimeSeries = await measureAsync('getTimeSeries', () => DashboardTimeSeriesService.getTimeSeries({ ...filters, interval: filters.interval || 'day' }).then((r) => {
          queryCount += 1;
          return r;
        }));

        const mExposure = await measureAsync('calculateExposure', () => DashboardExposureService.calculateExposure(exposureFilters).then((r) => {
          queryCount += 3;
          return r;
        }));

        const mPreviousPeriod = await measureAsync('calculatePreviousPeriod', () => this.calculatePreviousPeriod(filters, role).then((r) => {
          queryCount += 1;
          return r;
        }));
        const measuredPhase2 = [mTimeSeries, mExposure, mPreviousPeriod];

        const measured = [...measuredPhase1, ...measuredPhase2];

        const ganancia = mGanancia.result;
        const summary = mSummary.result;
        
        const cxc = { totalAmount: 0, byVentana: [] };
        const cxp = { totalAmount: 0, byVentana: [] };

        const timeSeries = mTimeSeries.result;
        const exposure = mExposure.result;
        const previousPeriod = mPreviousPeriod.result;

        monitor.checkpoint('AFTER_PARALLEL_QUERIES');

        logger.info({
          layer: 'performance',
          action: 'DASHBOARD_OPERATIONS_BREAKDOWN',
          meta: {
            operations: measured.map(({ durationMs, memoryDeltaMB }, idx) => ({
              name: ['ganancia', 'summary', 'timeSeries', 'exposure', 'previousPeriod'][idx],
              durationMs,
              memoryDeltaMB: parseFloat(memoryDeltaMB.toFixed(2)),
            })),
          },
        });

        const alerts = DashboardAlertsService.generateAlerts({ ganancia, cxc, cxp, summary, exposure });

        monitor.checkpoint('BEFORE_RESPONSE_BUILD');

        const response = {
          ganancia,
          cxc,
          cxp,
          summary,
          timeSeries: (timeSeries as any).timeSeries,
          exposure,
          previousPeriod,
          alerts,
          meta: {
            range: {
              fromAt: filters.fromDate.toISOString(),
              toAt: filters.toDate.toISOString(),
              tz: 'America/Costa_Rica',
            },
            exposureTrimmedToToday: exposureTrimmed,
            scope: filters.scope || 'all',
            generatedAt: new Date().toISOString(),
            queryExecutionTime: Date.now() - startTime,
            totalQueries: queryCount,
          },
        };

        const performanceSummary = monitor.end('RESPONSE_READY');

        if (process.env.NODE_ENV !== 'production') {
          (response.meta as any).performance = {
            totalTimeMs: performanceSummary.totalTimeMs,
            peakHeapUsedMB: parseFloat(performanceSummary.peakHeapUsedMB.toFixed(2)),
            heapGrowthMB: parseFloat(performanceSummary.heapGrowthMB.toFixed(2)),
          };
        }

        return response;
      }
    );
  }
}
