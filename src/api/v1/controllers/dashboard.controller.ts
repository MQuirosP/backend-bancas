import { Response } from "express";
import { AppError } from "../../../core/errors";
import { success } from "../../../utils/responses";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "@prisma/client";
import DashboardService from "../services/dashboard.service";
import { DashboardExportService } from "../services/dashboard-export.service";
import { resolveDateRange } from "../../../utils/dateRange";
import { validateVentanaUser } from "../../../utils/rbac";
import prisma from "../../../core/prismaClient";
import { crDateService } from "../../../utils/crDateService";

// Nota: Usa el mismo patrón que Venta/Sales módulo
// date: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range'
// Si range: requiere fromDate y toDate en YYYY-MM-DD

/**
 * Helper para aplicar RBAC y obtener filtros de banca/ventana
 */
async function applyDashboardRbac(req: AuthenticatedRequest, query: any) {
  let ventanaId = query.ventanaId;
  let bancaId: string | undefined = undefined;
  
  if (req.user!.role === Role.VENTANA) {
    // VENTANA solo ve su dashboard
    const validatedVentanaId = await validateVentanaUser(req.user!.role, req.user!.ventanaId, req.user!.id);
    ventanaId = validatedVentanaId!;
  } else if (req.user!.role === Role.ADMIN) {
    // ADMIN: filtrar por banca activa si está disponible
    // IMPORTANTE: Solo usar bancaId si tiene valor (no null)
    if (req.bancaContext?.bancaId) {
      bancaId = req.bancaContext.bancaId;
    }
  }
  
  return { ventanaId, bancaId };
}

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

    // Resolver rango de fechas
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    // Aplicar RBAC
    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      interval: query.interval,
      scope: query.scope || 'all',
      dimension: query.dimension, // 'ventana' | 'loteria' | 'vendedor'
    }, req.user!.role); // Pasar el rol del usuario para calcular correctamente la ganancia neta
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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateGanancia({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      dimension: query.dimension, // 'ventana' | 'loteria' | 'vendedor'
    }, req.user!.role); // Pasar el rol del usuario para calcular correctamente la ganancia neta

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
   * GET /api/v1/admin/dashboard/ganancia/month-to-date
   * Ganancia global acumulada del mes actual (desde día 1 hasta hoy)
   * ️ IMPORTANTE: Calcula automáticamente el periodo del mes actual en hora de Costa Rica
   */
  async getGananciaMonthToDate(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    const query = req.query as any;

    //  Validar que dimension sea 'ventana'
    if (query.dimension !== 'ventana') {
      throw new AppError("El parámetro 'dimension' debe ser 'ventana'", 400);
    }

    //  Usar resolveDateRange existente para calcular correctamente el mes actual en CR timezone
    // Para "month-to-date", necesitamos desde el primer día del mes hasta HOY (no hasta el último día)
    const monthRange = resolveDateRange('month'); // Primer día del mes
    const todayRange = resolveDateRange('today'); // Hoy

    //  Aplicar RBAC para obtener ventanaId y bancaId según el usuario
    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    //  Llamar al servicio existente con el rango calculado (desde primer día del mes hasta hoy)
    const result = await DashboardService.calculateGanancia({
      fromDate: monthRange.fromAt, // Primer día del mes en CR (06:00:00 UTC)
      toDate: todayRange.toAt, // Fin del día de hoy en CR
      ventanaId,
      bancaId,
      dimension: 'ventana',
    }, req.user!.role);

    //  Obtener nombre del mes en español desde la fecha actual en CR
    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const [year, month] = nowCRStr.split('-').map(Number);
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const monthName = monthNames[month - 1];

    //  Mapear resultado a estructura esperada por el frontend
    return success(res, {
      dimension: 'ventana',
      items: [],
      global: {
        sales: parseFloat(result.totalSales.toFixed(2)),
        payout: parseFloat(result.totalPayouts.toFixed(2)),
        commissions: parseFloat(result.totalAmount.toFixed(2)),
        commissionUser: parseFloat(result.commissionUserTotal.toFixed(2)),
        commissionVentana: parseFloat(result.commissionVentanaTotal.toFixed(2)),
        netProfit: parseFloat(result.totalNet.toFixed(2)),
        margin: parseFloat(result.margin.toFixed(2)),
      },
      meta: {
        fromDate: monthRange.fromAt.toISOString(),
        toDate: todayRange.toAt.toISOString(),
        timezone: monthRange.tz,
        monthName: monthName,
        description: `Month-to-date (${monthRange.description.split('(')[1]?.split(' to')[0]} to today)`,
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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateCxC({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      cxcDimension: query.dimension === 'vendedor' ? 'vendedor' : 'ventana', //  NUEVO: Soporte para dimension=vendedor
    }, req.user!.role); //  CRÍTICO: Pasar rol del usuario para calcular balance correctamente
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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateCxP({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      cxcDimension: query.dimension === 'vendedor' ? 'vendedor' : 'ventana', //  NUEVO: Soporte para dimension=vendedor
    }, req.user!.role); //  CRÍTICO: Pasar rol del usuario para calcular balance correctamente

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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    // Mapear granularity a interval (frontend compatibility)
    const interval = query.interval || query.granularity || 'day';
    const compare = query.compare === true || query.compare === 'true';

    const result = await DashboardService.getTimeSeries({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      interval,
      compare,
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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateExposure({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // ️ CRÍTICO: date debe ser 'range' explícitamente cuando hay fromDate/toDate
    // resolveDateRange() ahora rechazará si hay fromDate/toDate sin date=range
    const date = query.date || 'today';
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.getVendedores({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      top: query.top ? parseInt(query.top) : undefined,
      orderBy: query.orderBy || 'sales',
      order: query.order || 'desc',
      page: query.page ? parseInt(query.page) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize) : 20,
    });

    return success(res, {
      data: result.byVendedor,
      pagination: result.pagination,
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
   * POST /api/v1/admin/dashboard/accumulated-balances
   * Obtiene saldos acumulados en lote (Saldo a Hoy)
   */
  async getAccumulatedBalances(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role === Role.VENDEDOR) {
      throw new AppError("No autorizado", 403);
    }

    // Intentar obtener de body o query (fallback para flexibilidad)
    const dimension = req.body.dimension || req.query.dimension;
    let entityIds = req.body.entityIds || req.query.entityIds;

    // Si viene como string separado por comas en el query
    if (typeof entityIds === 'string') {
      entityIds = entityIds.split(',');
    }

    if (!dimension || !Array.isArray(entityIds)) {
      throw new AppError("Parámetros 'dimension' y 'entityIds' son requeridos", 400);
    }

    const { bancaId } = await applyDashboardRbac(req, req.query);

    const result = await DashboardService.getAccumulatedBalancesBatch(
      dimension as "ventana" | "vendedor",
      entityIds,
      bancaId
    );

    return success(res, result);
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

    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const dashboard = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
      loteriaId: query.loteriaId,
      betType: query.betType,
      scope: query.scope || 'all',
      dimension: query.dimension, // 'ventana' | 'loteria' | 'vendedor'
    }, req.user!.role); // Pasar el rol del usuario para calcular correctamente la ganancia neta

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `dashboard-${timestamp}.${format}`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      const csv = DashboardExportService.generateCSV(dashboard as any);
      // Agregar BOM para UTF-8 en Excel
      return res.send('\ufeff' + csv);
    } else if (format === 'xlsx') {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const workbook = await DashboardExportService.generateWorkbook(dashboard as any);
      await workbook.xlsx.write(res);
      return res.end();
    } else if (format === 'pdf') {
      // Configurar headers antes de generar el PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      const pdfDoc = DashboardExportService.generatePDF(dashboard as any);
      
      // getBuffer callback: (buffer) => void
      // Nota: pdfmake getBuffer solo pasa el buffer, no un error como segundo parámetro
      pdfDoc.getBuffer((buffer: Buffer) => {
        try {
          if (!buffer || buffer.length === 0) {
            req.logger?.error({
              layer: 'controller',
              action: 'DASHBOARD_EXPORT_PDF_ERROR',
              userId: req.user?.id,
              requestId: req.requestId,
              meta: { error: 'Buffer vacío o undefined' }
            });
            if (!res.headersSent) {
              return res.status(500).json({ error: 'Error generando PDF: buffer vacío' });
            }
            return;
          }
          
          // Verificar que los headers no se hayan enviado
          if (res.headersSent) {
            req.logger?.warn({
              layer: 'controller',
              action: 'DASHBOARD_EXPORT_PDF_HEADERS_SENT',
              userId: req.user?.id,
              requestId: req.requestId,
            });
            return;
          }
          
          // Enviar el buffer del PDF como binary
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': buffer.length,
          });
          res.end(buffer);
        } catch (error: any) {
          req.logger?.error({
            layer: 'controller',
            action: 'DASHBOARD_EXPORT_PDF_ERROR',
            userId: req.user?.id,
            requestId: req.requestId,
            meta: { error: error.message, stack: error.stack }
          });
          if (!res.headersSent) {
            res.status(500).json({ error: 'Error generando PDF', message: error.message });
          }
        }
      });
      
      return;
    }

    // Fallback: retornar JSON si el formato no es reconocido (no debería llegar aquí)
    return success(res, dashboard);
  },

};

export default DashboardController;
