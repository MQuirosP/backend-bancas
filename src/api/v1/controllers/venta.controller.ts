// src/api/v1/controllers/venta.controller.ts
import { Response } from "express";
import { VentasService } from "../services/venta.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { AppError } from "../../../core/errors";
import { resolveDateRange, validateTimeseriesRange } from "../../../utils/dateRange";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";

export const VentaController = {
  /**
   * 1) Listado transaccional (detalle)
   * GET /ventas?date=today|yesterday|range&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&page=1&pageSize=20
   */
  async list(req: AuthenticatedRequest, res: Response) {
    const {
      page = 1,
      pageSize = 20,
      date = "today",
      fromDate,
      toDate,
      ...rest
    } = req.query as any;

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? toDate[0] : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Aplicar RBAC primero para obtener effectiveFilters (incluye sorteoId)
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Si hay sorteoId y no se especifican fechas explícitamente, ignorar el filtro de fecha
    // Esto permite obtener todos los tickets del sorteo sin importar la fecha de creación
    const hasSorteoId = effectiveFilters.sorteoId;
    const hasExplicitDateRange = fromDateStr || toDateStr;

    let dateRange: { fromAt: Date; toAt: Date; tz: string } | null = null;
    
    if (hasSorteoId && !hasExplicitDateRange) {
      // No aplicar filtro de fecha cuando hay sorteoId y no hay fechas explícitas
      dateRange = null;
    } else {
      // Resolver rango de fechas (CR → UTC) normalmente
      dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);
    }

    // Construir filtros finales para el servicio
    const filters: any = {
      ...effectiveFilters,
    };

    // Solo agregar filtros de fecha si dateRange fue resuelto
    if (dateRange) {
      filters.dateFrom = dateRange.fromAt;
      filters.dateTo = dateRange.toAt;
    }

    const result = await VentasService.list(Number(page), Number(pageSize), filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_LIST",
      payload: {
        page,
        pageSize,
        effectiveFilters,
        dateRange: dateRange ? {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        } : null,
        skippedDateFilter: hasSorteoId && !hasExplicitDateRange
      },
    });

    return success(res, result.data, {
      ...result.meta,
      ...(dateRange ? {
        range: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        }
      } : {}),
      effectiveFilters
    });
  },

  /**
   * 2) Resumen ejecutivo (KPI)
   * GET /ventas/summary?date=today|yesterday|range&fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
   */
  async summary(req: AuthenticatedRequest, res: Response) {
    const {
      date = "today",
      fromDate,
      toDate,
      ...rest
    } = req.query as any;

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? toDate[0] : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Resolver rango de fechas (CR → UTC)
    const dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros finales para el servicio
    const filters: any = {
      ...effectiveFilters,
      dateFrom: dateRange.fromAt,
      dateTo: dateRange.toAt
    };

    // Determinar si es scope='mine' para VENDEDOR
    // Cuando el usuario es VENDEDOR, applyRbacFilters automáticamente filtra por vendedorId = userId
    // Esto es equivalente a scope='mine'
    const scope = req.user!.role === 'VENDEDOR' ? 'mine' : rest.scope || 'all';

    const result = await VentasService.summary(filters, {
      userId: req.user!.id,
      role: req.user!.role,
      scope,
    });

    req.logger?.info({
      layer: "controller",
      action: "VENTA_SUMMARY",
      payload: {
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        }
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz
      },
      effectiveFilters
    });
  },

  /**
   * 3) Desglose por dimensión (Top-N)
   * GET /ventas/breakdown?dimension=vendedor|ventana|loteria|sorteo|numero&top=10&date=today
   */
  async breakdown(req: AuthenticatedRequest, res: Response) {
    const {
      dimension,
      top = 10,
      date = "today",
      fromDate,
      toDate,
      ...rest
    } = req.query as any;

    // Validar dimensión
    if (!dimension) {
      throw new AppError("dimension is required", 400, {
        code: "SLS_2002",
        details: [
          {
            field: "dimension",
            reason: "Must be one of: vendedor, ventana, loteria, sorteo, numero"
          }
        ]
      });
    }

    const validDimensions = ["vendedor", "ventana", "loteria", "sorteo", "numero"];
    const dimensionStr = Array.isArray(dimension) ? dimension[0] : dimension;
    if (!validDimensions.includes(dimensionStr)) {
      throw new AppError("Invalid dimension", 400, {
        code: "SLS_2002",
        details: [
          {
            field: "dimension",
            reason: "Must be one of: vendedor, ventana, loteria, sorteo, numero"
          }
        ]
      });
    }

    // Validar top
    if (Number(top) > 50) {
      throw new AppError("top cannot exceed 50", 400, {
        code: "SLS_2001",
        details: [
          {
            field: "top",
            reason: "Maximum value is 50"
          }
        ]
      });
    }

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? toDate[0] : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Resolver rango de fechas (CR → UTC)
    const dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId
    };

    // DEBUG: Log context and filters BEFORE RBAC
    req.logger?.info({
      layer: "controller",
      action: "BREAKDOWN_RBAC_DEBUG",
      payload: {
        context,
        requestFilters: rest,
        dimension: dimensionStr,
        message: "BEFORE applyRbacFilters"
      }
    });

    const effectiveFilters = await applyRbacFilters(context, rest);

    // DEBUG: Log AFTER RBAC
    req.logger?.info({
      layer: "controller",
      action: "BREAKDOWN_RBAC_APPLIED",
      payload: {
        effectiveFilters,
        message: "AFTER applyRbacFilters - these are the filters that will be used"
      }
    });

    // Construir filtros finales para el servicio
    const filters: any = {
      ...effectiveFilters,
      dateFrom: dateRange.fromAt,
      dateTo: dateRange.toAt
    };

    const result = await VentasService.breakdown(dimensionStr, Number(top), filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_BREAKDOWN",
      payload: {
        dimension: dimensionStr,
        top,
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        }
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz
      },
      dimension,
      topCount: Number(top),
      effectiveFilters
    });
  },

  /**
   * 4) Serie de tiempo (timeseries)
   * GET /ventas/timeseries?granularity=hour|day|week&date=today
   */
  async timeseries(req: AuthenticatedRequest, res: Response) {
    const {
      granularity = "day",
      date = "today",
      fromDate,
      toDate,
      ...rest
    } = req.query as any;

    // Asegurar que granularidad sea string, no array
    const granularityStr = Array.isArray(granularity) ? granularity[0] : granularity;

    // Validar granularidad
    const validGranularities = ["hour", "day", "week"];
    if (!validGranularities.includes(granularityStr)) {
      throw new AppError("Invalid granularity", 400, {
        code: "SLS_2001",
        details: [
          {
            field: "granularity",
            reason: "Must be one of: hour, day, week"
          }
        ]
      });
    }

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? toDate[0] : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Resolver rango de fechas (CR → UTC)
    const dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);

    // Validar límites según granularidad
    validateTimeseriesRange(dateRange.fromAt, dateRange.toAt, granularityStr as any);

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros finales para el servicio
    const filters: any = {
      ...effectiveFilters,
      dateFrom: dateRange.fromAt,
      dateTo: dateRange.toAt
    };

    const result = await VentasService.timeseries(granularityStr, filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_TIMESERIES",
      payload: {
        granularity,
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        }
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz
      },
      granularity,
      effectiveFilters
    });
  },

  /**
   * 5) Facets - Valores válidos para filtros dinámicos
   * GET /ventas/facets?date=today
   */
  async facets(req: AuthenticatedRequest, res: Response) {
    const {
      date = "today",
      fromDate,
      toDate,
      ...rest
    } = req.query as any;

    // Asegurar que las fechas sean strings, no arrays
    const fromDateStr = Array.isArray(fromDate) ? fromDate[0] : fromDate;
    const toDateStr = Array.isArray(toDate) ? toDate[0] : toDate;
    const dateStr = Array.isArray(date) ? date[0] : date;

    // Resolver rango de fechas (CR → UTC)
    const dateRange = resolveDateRange(dateStr, fromDateStr, toDateStr);

    // Aplicar RBAC
    const context: AuthContext = {
      userId: req.user!.id,
      role: req.user!.role,
      ventanaId: req.user!.ventanaId
    };
    const effectiveFilters = await applyRbacFilters(context, rest);

    // Construir filtros finales para el servicio
    const filters: any = {
      ...effectiveFilters,
      dateFrom: dateRange.fromAt,
      dateTo: dateRange.toAt
    };

    const result = await VentasService.facets(filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_FACETS",
      payload: {
        effectiveFilters,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz
        }
      },
    });

    return success(res, result, {
      range: {
        fromAt: dateRange.fromAt.toISOString(),
        toAt: dateRange.toAt.toISOString(),
        tz: dateRange.tz
      },
      effectiveFilters
    });
  },
};

export default VentaController;
