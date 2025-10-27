import { Response } from "express";
import { AppError } from "../../../core/errors";
import { success } from "../../../utils/responses";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "@prisma/client";
import DashboardService from "../services/dashboard.service";
import { resolveDateRange } from "../../../utils/dateRange";

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
      ventanaId = req.user.ventanaId!;
    } else if (req.user.role !== Role.ADMIN) {
      throw new AppError("No autorizado", 403);
    }

    const result = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
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
};

export default DashboardController;
