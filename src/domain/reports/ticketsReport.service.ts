/**
 * Servicio Facade de reportes de tickets
 * 
 * Centraliza y delega las operaciones de reportería a sus respectivos handlers especializados:
 * - WinnersReportHandler: Ganadores y pagos pendientes
 * - TicketsSummaryReportHandler: Resumen operativo agregado
 * - NumbersAnalysisReportHandler: Frecuencia de números y drill-down
 * - CancelledTicketsReportHandler: Auditoría de cancelaciones
 * - ExposureReportHandler: Exposición de riesgo financiero
 * - ProfitabilityReportHandler: Rentabilidad y márgenes
 * - TimeAnalysisReportHandler: Patrones temporales por hora y día
 */

import {
  WinnersReportHandler,
  WinnersPaymentsFilters,
  WinnersPaymentsResult,
} from './handlers/winners-report.handler';
import {
  TicketsSummaryReportHandler,
  TicketsSummaryFilters,
} from './handlers/tickets-summary-report.handler';
import {
  NumbersAnalysisReportHandler,
  NumbersAnalysisFilters,
  NumbersAnalysisDetailFilters,
} from './handlers/numbers-analysis-report.handler';
import {
  CancelledTicketsReportHandler,
  CancelledTicketsFilters,
} from './handlers/cancelled-tickets-report.handler';
import {
  ExposureReportHandler,
  ExposureFilters,
} from './handlers/exposure-report.handler';
import {
  ProfitabilityReportHandler,
  ProfitabilityFilters,
} from './handlers/profitability-report.handler';
import {
  TimeAnalysisReportHandler,
  TimeAnalysisFilters,
} from './handlers/time-analysis-report.handler';

// Re-exportar tipos para mantener 100% de compatibilidad con clientes existentes
export type {
  WinnersPaymentsFilters,
  WinnersPaymentsResult,
  TicketsSummaryFilters,
  NumbersAnalysisFilters,
  NumbersAnalysisDetailFilters,
  CancelledTicketsFilters,
  ExposureFilters,
  ProfitabilityFilters,
  TimeAnalysisFilters,
};

export const TicketsReportService = {
  /**
   * Reporte de tickets ganadores y pagos pendientes
   */
  async getWinnersPayments(filters: WinnersPaymentsFilters) {
    return WinnersReportHandler.getWinnersPayments(filters);
  },

  /**
   * Resumen Operativo Agregado
   */
  async getTicketsSummary(filters: TicketsSummaryFilters) {
    return TicketsSummaryReportHandler.getTicketsSummary(filters);
  },

  /**
   * Reporte de números más jugados
   */
  async getNumbersAnalysis(filters: NumbersAnalysisFilters) {
    return NumbersAnalysisReportHandler.getNumbersAnalysis(filters);
  },

  /**
   * Detalle desglosado de un número (Drill-down)
   */
  async getNumbersAnalysisDetail(filters: NumbersAnalysisDetailFilters) {
    return NumbersAnalysisReportHandler.getNumbersAnalysisDetail(filters);
  },

  /**
   * Reporte de tickets cancelados
   */
  async getCancelledTickets(filters: CancelledTicketsFilters) {
    return CancelledTicketsReportHandler.getCancelledTickets(filters);
  },

  /**
   * Reporte de exposición y riesgo por número
   */
  async getExposure(filters: ExposureFilters) {
    return ExposureReportHandler.getExposure(filters);
  },

  /**
   * Reporte de rentabilidad y márgenes
   */
  async getProfitability(filters: ProfitabilityFilters) {
    return ProfitabilityReportHandler.getProfitability(filters);
  },

  /**
   * Reporte de análisis por hora y día de semana
   */
  async getTimeAnalysis(filters: TimeAnalysisFilters) {
    return TimeAnalysisReportHandler.getTimeAnalysis(filters);
  },

  /**
   * Obtiene la lista de ganadores de un sorteo específico, optimizada para reportes
   */
  async getWinnersList(sorteoId: string, filters: { vendedorId?: string; bancaId?: string }) {
    return WinnersReportHandler.getWinnersList(sorteoId, filters);
  },
};
