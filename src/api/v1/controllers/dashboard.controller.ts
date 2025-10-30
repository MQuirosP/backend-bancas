import { Response } from "express";
import { AppError } from "../../../core/errors";
import { success } from "../../../utils/responses";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "@prisma/client";
import DashboardService from "../services/dashboard.service";
import { resolveDateRange } from "../../../utils/dateRange";
import { validateVentanaUser } from "../../../utils/rbac";

// Nota: Usa el mismo patrón que Venta/Sales módulo
// date: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range'
// Si range: requiere fromDate y toDate en YYYY-MM-DD

export const DashboardController = {
  /**
   * GET /api/v1/admin/dashboard
   * Dashboard principal con todas las métricas
   */
  async getMainDashboard(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    // Validar acceso: solo ADMIN y VENTANA
    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado para ver dashboard", 403);
    }

    const query = req.query as any;

    // Resolver rango de fechas (usa el mismo patrón que Venta)
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    // Aplicar RBAC
    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      // VENTANA solo ve su dashboard
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    } else if (req.user.role !== Role.ADMIN) {
      throw new AppError("No autorizado", 403);
    }

    const result = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      interval: query.interval,
      scope: query.scope || 'all',
    });

    return success(res, result);
  },

  /**
   * GET /api/v1/admin/dashboard/ganancia
   * Desglose detallado de ganancia
   */
  async getGanancia(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const result = await DashboardService.calculateGanancia({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/cxc
   * Desglose detallado de Cuentas por Cobrar
   */
  async getCxC(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const result = await DashboardService.calculateCxC({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/cxp
   * Desglose detallado de Cuentas por Pagar
   */
  async getCxP(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const result = await DashboardService.calculateCxP({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/timeseries
   * Serie temporal para gráficos
   */
  async getTimeSeries(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    // Mapear granularity a interval (frontend compatibility)
    const interval = query.interval || query.granularity || 'day';

    const result = await DashboardService.getTimeSeries({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      interval,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/exposure
   * Análisis de exposición financiera
   */
  async getExposure(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const result = await DashboardService.calculateExposure({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      top: query.top ? parseInt(query.top) : 10,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/vendedores
   * Ranking por vendedor
   */
  async getVendedores(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const result = await DashboardService.getVendedores({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      top: query.top ? parseInt(query.top) : undefined,
      orderBy: query.orderBy || 'sales',
      order: query.order || 'desc',
      page: query.page ? parseInt(query.page) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize) : 20,
    });

    return success(res, {
      data: result,
      meta: {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  },

  /**
   * GET /api/v1/admin/dashboard/export
   * Exportar dashboard en CSV/XLSX/PDF
   */
  async exportDashboard(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;
    const format = query.format || 'csv';

    if (!['csv', 'xlsx', 'pdf'].includes(format)) {
      throw new AppError("Formato inválido. Use: csv, xlsx, pdf", 422);
    }

    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    let ventanaId = query.ventanaId;
    if (req.user.role === Role.VENTANA) {
      validateVentanaUser(req.user.role, req.user.ventanaId);
      ventanaId = req.user.ventanaId!;
    }

    const dashboard = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      scope: query.scope || 'all',
    });

    // Por ahora, retornar JSON hasta implementar export real
    // TODO: Implementar exportación a CSV/XLSX/PDF
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `dashboard-${timestamp}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      // TODO: Convertir a CSV
      return res.send('CSV export not implemented yet');
    } else if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      // TODO: Convertir a XLSX
      return res.send('XLSX export not implemented yet');
    } else if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      // TODO: Convertir a PDF
      return res.send('PDF export not implemented yet');
    }

    return success(res, dashboard);
  },
};

export default DashboardController;
