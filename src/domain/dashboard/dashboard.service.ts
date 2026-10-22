/**
 * Dashboard Service (Facade)
 * 
 * Actúa como fachada liviana preservando el 100% del contrato público,
 * delegando la ejecución a servicios especializados y al repositorio formal:
 * - DashboardRepository: Única capa autorizada para SQL crudo y consultas Prisma
 * - DashboardFinancialService: Ganancia, CxC, CxP, resumen y ranking de vendedores
 * - DashboardTimeSeriesService: Series temporales y comparativas históricas
 * - DashboardExposureService: Análisis de riesgo y exposición por número
 * - DashboardAlertsService: Motor de reglas de alertas de negocio
 * - DashboardSummaryEntitiesService: KPIs y entidades por vendedor
 */

import { Role } from "../../generated/prisma/client";
import {
  DashboardFilters,
  GananciaResult,
  CxCResult,
  CxPResult,
  DashboardSummary,
} from "./dashboard.types";
import { DashboardFinancialService } from "./services/dashboard-financial.service";
import { DashboardTimeSeriesService } from "./services/dashboard-timeseries.service";
import { DashboardExposureService } from "./services/dashboard-exposure.service";
import { DashboardAlertsService } from "./services/dashboard-alerts.service";
import { DashboardSummaryEntitiesService } from "./services/dashboard-summary-entities.service";
import { buildTicketBaseFilters } from "./services/dashboard-helpers";

// Re-exportar tipos y utilidades para compatibilidad 100% con scripts y controladores
export type {
  DashboardFilters,
  GananciaResult,
  CxCResult,
  CxPResult,
  DashboardSummary,
};
export { buildTicketBaseFilters };

export const DashboardService = {
  /**
   * Calcula ganancia: Sum de comisiones + premium retenido
   * Incluye desglose completo por ventana y lotería
   */
  async calculateGanancia(filters: DashboardFilters, role?: Role): Promise<GananciaResult> {
    return DashboardFinancialService.calculateGanancia(filters, role);
  },

  /**
   * Calcula CxC: Monto que ventana debe al banco por premios no pagados
   */
  async calculateCxC(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    return DashboardFinancialService.calculateCxC(filters, role);
  },

  /**
   * Calcula CxC agrupado por vendedor
   */
  async calculateCxCByVendedor(filters: DashboardFilters, role?: Role): Promise<CxCResult> {
    return DashboardFinancialService.calculateCxCByVendedor(filters, role);
  },

  /**
   * Calcula CxP: Monto que el banco debe a la ventana por comisiones o saldos a favor
   */
  async calculateCxP(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    return DashboardFinancialService.calculateCxP(filters, role);
  },

  /**
   * Calcula CxP agrupado por vendedor
   */
  async calculateCxPByVendedor(filters: DashboardFilters, role?: Role): Promise<CxPResult> {
    return DashboardFinancialService.calculateCxPByVendedor(filters, role);
  },

  /**
   * Obtiene saldos acumulados mensuales en lote
   */
  async getAccumulatedBalancesBatch(
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string
  ): Promise<Record<string, number>> {
    return DashboardFinancialService.getAccumulatedBalancesBatch(dimension, entityIds, bancaId);
  },

  /**
   * Resumen general: totales de ventas, pagos, comisiones
   */
  async getSummary(filters: DashboardFilters, role?: Role): Promise<DashboardSummary> {
    return DashboardFinancialService.getSummary(filters, role);
  },

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   */
  async getFullDashboard(filters: DashboardFilters, role?: Role) {
    return DashboardFinancialService.getFullDashboard(filters, role);
  },

  /**
   * Serie temporal: datos agrupados por día u hora para gráficos
   */
  async getTimeSeries(filters: DashboardFilters) {
    return DashboardTimeSeriesService.getTimeSeries(filters);
  },

  /**
   * Exposición: análisis de riesgo por número y lotería
   */
  async calculateExposure(filters: DashboardFilters) {
    return DashboardExposureService.calculateExposure(filters);
  },

  /**
   * Obtiene ranking y datos paginados de vendedores
   */
  async getVendedores(filters: DashboardFilters) {
    return DashboardFinancialService.getVendedores(filters);
  },

  /**
   * Calcula el período anterior para comparación
   */
  async calculatePreviousPeriod(filters: DashboardFilters, role?: Role) {
    return DashboardFinancialService.calculatePreviousPeriod(filters, role);
  },

  /**
   * Genera alertas automáticas basadas en umbrales de negocio
   */
  generateAlerts(data: any) {
    return DashboardAlertsService.generateAlerts(data);
  },

  /**
   * GET /admin/dashboard/summary
   * KPIs del período + monthToDate + byVentana con balances.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  async calculateDashboardSummary(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    return DashboardSummaryEntitiesService.calculateDashboardSummary(filters);
  },

  /**
   * GET /admin/dashboard/entities
   * Desglose por vendedor con balances acumulados.
   * Fuente: AccountStatement (sin tocar Jugada).
   */
  async calculateDashboardEntities(filters: {
    fromDate: Date;
    toDate: Date;
    ventanaId?: string;
    bancaId?: string;
  }) {
    return DashboardSummaryEntitiesService.calculateDashboardEntities(filters);
  },
};

export default DashboardService;
