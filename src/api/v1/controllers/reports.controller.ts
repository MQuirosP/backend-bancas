/**
 * Controladores para el módulo de reportes
 */

import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../../core/types';
import { applyRbacFilters, AuthContext } from '../../../utils/rbac';
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

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getWinnersPayments({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
      loteriaId: query.loteriaId,
      paymentStatus: query.paymentStatus || 'all',
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
      // Nuevos filtros
      expiredOnly: query.expiredOnly === 'true' || query.expiredOnly === true,
      minPayout: query.minPayout ? Number(query.minPayout) : undefined,
      maxPayout: query.maxPayout ? Number(query.maxPayout) : undefined,
      betType: query.betType || 'all',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/numbers-analysis
   * Análisis de números más jugados
   */
  async getNumbersAnalysis(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Construir contexto de autenticación para RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.bancaContext?.bancaId,
    };

    // Aplicar RBAC a los filtros del cliente
    const effectiveFilters = await applyRbacFilters(context, {
      ventanaId: query.ventanaId,
      vendedorId: query.vendedorId,
    });

    const result = await TicketsReportService.getNumbersAnalysis({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      loteriaId: query.loteriaId,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
      betType: query.betType || 'all',
      top: query.top ? Number(query.top) : undefined,
      includeComparison: query.includeComparison === 'true' || query.includeComparison === true,
      includeWinners: query.includeWinners === 'true' || query.includeWinners === true,
      includeExposure: query.includeExposure === 'true' || query.includeExposure === true,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/numbers-analysis/detail
   * Detalle desglosado de un número (Drill-down)
   */
  async getNumbersAnalysisDetail(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.bancaContext?.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getNumbersAnalysisDetail({
      number: query.number,
      loteriaId: query.loteriaId,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      betType: query.betType || 'all',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/cancelled
   * Reporte de tickets cancelados
   */
  async getCancelledTickets(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;
    
    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.bancaContext?.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getCancelledTickets({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
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
    
    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await LoteriasReportService.getPerformance({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      loteriaId: query.loteriaId,
      bancaId: effectiveFilters.bancaId,
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
    
    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await VentanasReportService.getRanking({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      bancaId: effectiveFilters.bancaId,
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

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    if (!effectiveFilters.ventanaId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VENTANA_ID_REQUIRED',
          message: 'ventanaId es requerido para este endpoint',
        },
      });
    }

    const result = await VendedoresReportService.getCommissionsChart({
      ventanaId: effectiveFilters.ventanaId,
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ticketStatus: query.ticketStatus,
      excludeTicketStatus: query.excludeTicketStatus,
      bancaId: effectiveFilters.bancaId,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/vendedores/ranking
   * Ranking de productividad de vendedores
   */
  async getVendedoresRanking(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await VendedoresReportService.getRanking({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      bancaId: effectiveFilters.bancaId,
      top: query.top ? Number(query.top) : undefined,
      sortBy: query.sortBy || 'ventas',
      includeInactive: query.includeInactive === 'true' || query.includeInactive === true,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/exposure
   * Análisis de exposición y riesgo por número
   * REQUERIDO: sorteoId
   */
  async getExposure(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getExposure({
      sorteoId: query.sorteoId,
      loteriaId: query.loteriaId,
      bancaId: effectiveFilters.bancaId,
      top: query.top ? Number(query.top) : undefined,
      minExposure: query.minExposure ? Number(query.minExposure) : undefined,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/profitability
   * Análisis de rentabilidad y márgenes
   */
  async getProfitability(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getProfitability({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
      loteriaId: query.loteriaId,
      includeComparison: query.includeComparison === 'true' || query.includeComparison === true,
      groupBy: query.groupBy,
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/tickets/time-analysis
   * Análisis de ventas por hora y día de semana
   */
  async getTimeAnalysis(req: AuthenticatedRequest, res: Response) {
    const query = req.query as any;

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId,
      bancaId: req.user!.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, query);

    const result = await TicketsReportService.getTimeAnalysis({
      date: query.date || 'today',
      fromDate: query.fromDate,
      toDate: query.toDate,
      ventanaId: effectiveFilters.ventanaId || undefined,
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId,
      loteriaId: query.loteriaId,
      metric: query.metric || 'ventas',
    });

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/reports/winners-list/:sorteoId
   * Lista consolidada de tickets ganadores para un sorteo
   */
  async getWinnersList(req: AuthenticatedRequest, res: Response) {
    const { sorteoId } = req.params;
    let { vendedorId } = req.query as any;

    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
      bancaId: req.user.bancaId,
    };
    const effectiveFilters = await applyRbacFilters(context, { vendedorId });

    const result = await TicketsReportService.getWinnersList(sorteoId, { 
      vendedorId: effectiveFilters.vendedorId,
      bancaId: effectiveFilters.bancaId
    });

    return success(res, result.data);
  },
};

