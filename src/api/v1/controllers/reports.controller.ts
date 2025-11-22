/**
 * Controladores para el módulo de reportes
 */

import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../../core/types';
import { success } from '../../../utils/responses';
import { TicketsReportService } from '../services/reports/ticketsReport.service';
import { LoteriasReportService } from '../services/reports/loteriasReport.service';
import { VentanasReportService } from '../services/reports/ventanasReport.service';
import { VendedoresReportService } from '../services/reports/vendedoresReport.service';

export const ReportsController = {
  /**
   * GET /api/v1/reports/tickets/winners-payments
   * Reporte de tickets ganadores y pagos pendientes
   */
  async getWinnersPayments(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    const result = await TicketsReportService.getWinnersPayments({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: query.ventanaId,
      vendedorId: query.vendedorId,
      loteriaId: query.loteriaId,
      paymentStatus: query.paymentStatus || 'all',
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/numbers-analysis
   * Análisis de números más jugados
   */
  async getNumbersAnalysis(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    const result = await TicketsReportService.getNumbersAnalysis({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      loteriaId: query.loteriaId,
      betType: query.betType || 'all',
      top: query.top ? Number(query.top) : undefined,
      includeComparison: query.includeComparison === 'true',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/cancelled
   * Reporte de tickets cancelados
   */
  async getCancelledTickets(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    const result = await TicketsReportService.getCancelledTickets({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: query.ventanaId,
      vendedorId: query.vendedorId,
      loteriaId: query.loteriaId,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/loterias/performance
   * Rendimiento y rentabilidad por lotería
   */
  async getLoteriasPerformance(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    const result = await LoteriasReportService.getPerformance({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      loteriaId: query.loteriaId,
      includeComparison: query.includeComparison === 'true',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/ventanas/ranking
   * Ranking y comparativa de listeros
   */
  async getVentanasRanking(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    const result = await VentanasReportService.getRanking({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: query.ventanaId,
      top: query.top ? Number(query.top) : undefined,
      sortBy: query.sortBy || 'ventas',
      includeComparison: query.includeComparison === 'true',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/vendedores/commissions-chart
   * Análisis de comisiones de vendedores (con gráfico)
   * REQUERIDO: ventanaId
   */
  async getVendedoresCommissionsChart(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    if (!query.ventanaId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VENTANA_ID_REQUIRED',
          message: 'ventanaId es requerido para este endpoint',
        },
      });
    }
    
    const result = await VendedoresReportService.getCommissionsChart({
      ventanaId: query.ventanaId,
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ticketStatus: query.ticketStatus,
      excludeTicketStatus: query.excludeTicketStatus,
    });

    return success(res, result.data, result.meta);
  },
};

