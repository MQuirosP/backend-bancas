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
import { bancaFilterLogger } from "../../../utils/bancaFilterLogger";

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
    bancaFilterLogger.log('🔍 Controller - bancaContext recibido', req.bancaContext);
    
    if (req.bancaContext?.bancaId) {
      bancaId = req.bancaContext.bancaId;
      
      bancaFilterLogger.log('✅ Controller - Usando bancaId', { bancaId });
      
      // Log para debugging
      req.logger?.info({
        layer: 'controller',
        action: 'DASHBOARD_RBAC_BANCA_FILTER',
        userId: req.user!.id,
        payload: {
          bancaId,
          bancaContext: req.bancaContext,
          header: req.headers['x-active-banca-id'],
        },
      });
    } else {
      // Sin filtro - ver todas las bancas
      bancaFilterLogger.log('⚠️  Controller - NO hay bancaId, mostrando TODAS las bancas', {
        bancaContext: req.bancaContext,
      });
      
      req.logger?.info({
        layer: 'controller',
        action: 'DASHBOARD_RBAC_NO_FILTER',
        userId: req.user!.id,
        payload: {
          bancaContext: req.bancaContext,
          header: req.headers['x-active-banca-id'],
          message: 'No banca filter - showing all bancas',
        },
      });
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

    // Resolver rango de fechas (usa el mismo patrón que Venta)
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    // Aplicar RBAC
    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    // Log para debugging
    bancaFilterLogger.log('📊 Dashboard - Filtros aplicados', {
      ventanaId: ventanaId || 'NINGUNA',
      bancaId: bancaId || 'NINGUNA (ver todas)',
      userRole: req.user?.role,
      userId: req.user?.id,
    });

    const result = await DashboardService.getFullDashboard({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateGanancia({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateCxC({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    const result = await DashboardService.calculateCxP({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
    const dateRange = resolveDateRange(date, query.fromDate, query.toDate);

    const { ventanaId, bancaId } = await applyDashboardRbac(req, query);

    // Mapear granularity a interval (frontend compatibility)
    const interval = query.interval || query.granularity || 'day';

    const result = await DashboardService.getTimeSeries({
      fromDate: dateRange.fromAt,
      toDate: dateRange.toAt,
      ventanaId,
      bancaId,
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
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
    // Si se envía fromDate y toDate, usar automáticamente 'range'
    const date = query.fromDate && query.toDate ? 'range' : (query.date || 'today');
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
    });

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

  /**
   * GET /api/v1/admin/dashboard/debug-banca
   * Endpoint de debugging para ver el estado del filtro de banca
   */
  async debugBanca(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    if (req.user.role !== Role.ADMIN) {
      throw new AppError("Solo ADMIN puede usar este endpoint", 403);
    }

    const headerLower = req.headers['x-active-banca-id'] as string | undefined;
    const headerUpper = req.headers['X-Active-Banca-Id'] as string | undefined;
    const requestedBancaId = headerLower || headerUpper || undefined;

    // Obtener información de la banca si existe
    let bancaInfo = null;
    if (requestedBancaId) {
      try {
        const banca = await prisma.banca.findUnique({
          where: { id: requestedBancaId },
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        });
        bancaInfo = banca;
      } catch (error) {
        // Ignorar errores
      }
    }

    // Aplicar RBAC para ver qué filtros se aplicarían
    const { ventanaId, bancaId } = await applyDashboardRbac(req, req.query as any);

    return success(res, {
      debug: {
        headers: {
          'x-active-banca-id': headerLower,
          'X-Active-Banca-Id': headerUpper,
          requestedBancaId,
        },
        middleware: {
          bancaContext: req.bancaContext,
        },
        controller: {
          ventanaId,
          bancaId,
        },
        bancaInfo,
        user: {
          id: req.user.id,
          role: req.user.role,
        },
        message: bancaId 
          ? `Filtro activo: Solo se mostrarán datos de la banca ${bancaId}` 
          : 'Sin filtro: Se mostrarán datos de todas las bancas',
      },
    });
  },
};

export default DashboardController;
