// src/api/v1/controllers/venta.controller.ts
import { Response } from "express";
import { VentasService } from "../services/venta.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { AppError } from "../../../core/errors";

// Helpers para manejo de fechas (reutilizados de ticket.controller)
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * Aplica scope por rol a los filtros
 * Reutiliza la misma lógica que ticket.controller
 */
function applyScopeFilters(scope: string, user: any, filters: any) {
  if (scope === "mine") {
    if (user.role === Role.VENDEDOR) {
      filters.vendedorId = user.id; // Solo tickets del vendedor
    } else if (user.role === Role.VENTANA) {
      filters.ventanaId = user.ventanaId; // Solo tickets de la ventana
    } else if (user.role === Role.ADMIN) {
      // Admin con scope=mine: sin filtro adicional (puede ver todo)
    }
  }
  // Si scope === "all", no se aplica filtro de scope (solo admin debería poder)
}

/**
 * Aplica filtros de fecha al objeto filters
 */
function applyDateFilters(date: string, from: any, to: any, filters: any) {
  if (date === "today") {
    const now = new Date();
    filters.dateFrom = startOfDay(now);
    filters.dateTo = endOfDay(now);
  } else if (date === "yesterday") {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    filters.dateFrom = startOfDay(y);
    filters.dateTo = endOfDay(y);
  } else if (date === "range") {
    if (!from || !to) {
      throw new AppError("Para date=range debes enviar from y to (ISO)", 400, {
        code: "SLS_2001",
        details: [{ field: "from/to", message: "Requeridos para date=range" }],
      });
    }
    const df = new Date(from);
    const dt = new Date(to);
    if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
      throw new AppError("from/to inválidos", 400, {
        code: "SLS_2001",
        details: [{ field: "from/to", message: "Formato ISO inválido" }],
      });
    }
    filters.dateFrom = df;
    filters.dateTo = dt;
  }
}

/**
 * Valida límites de rango para timeseries según granularidad
 */
function validateTimeseriesRange(granularity: string, dateFrom?: Date, dateTo?: Date) {
  if (!dateFrom || !dateTo) return;

  const diffMs = dateTo.getTime() - dateFrom.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (granularity === "hour" && diffDays > 30) {
    throw new AppError("Para granularidad 'hour', el rango máximo es 30 días", 400, {
      code: "SLS_2001",
      details: [{ field: "granularity", message: "Rango excede 30 días para granularity=hour" }],
    });
  }

  if (granularity === "day" && diffDays > 90) {
    throw new AppError("Para granularidad 'day', el rango máximo es 90 días", 400, {
      code: "SLS_2001",
      details: [{ field: "granularity", message: "Rango excede 90 días para granularity=day" }],
    });
  }
}

export const VentaController = {
  /**
   * 1) Listado transaccional (detalle)
   * GET /ventas
   */
  async list(req: AuthenticatedRequest, res: Response) {
    const { page = 1, pageSize = 10, scope = "mine", date = "today", from, to, ...rest } = req.query as any;

    const filters: any = { ...rest };

    // Aplicar scope por rol
    applyScopeFilters(scope, req.user!, filters);

    // Aplicar filtros de fecha
    applyDateFilters(date, from, to, filters);

    const result = await VentasService.list(Number(page), Number(pageSize), filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_LIST",
      payload: { filters, page, pageSize, scope, date, from, to },
    });

    return success(res, result.data, result.meta);
  },

  /**
   * 2) Resumen ejecutivo (KPI)
   * GET /ventas/summary
   */
  async summary(req: AuthenticatedRequest, res: Response) {
    const { scope = "mine", date = "today", from, to, ...rest } = req.query as any;

    const filters: any = { ...rest };

    // Aplicar scope por rol
    applyScopeFilters(scope, req.user!, filters);

    // Aplicar filtros de fecha
    applyDateFilters(date, from, to, filters);

    const result = await VentasService.summary(filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_SUMMARY",
      payload: { filters, scope, date, from, to },
    });

    return success(res, result);
  },

  /**
   * 3) Desglose por dimensión (Top-N)
   * GET /ventas/breakdown?dimension=ventana|vendedor|loteria|sorteo|numero&top=10
   */
  async breakdown(req: AuthenticatedRequest, res: Response) {
    const { dimension, top = 10, scope = "mine", date = "today", from, to, ...rest } = req.query as any;

    if (!dimension) {
      throw new AppError("dimension es requerido", 400, {
        code: "SLS_2002",
        details: [{ field: "dimension", message: "Debe especificar: ventana|vendedor|loteria|sorteo|numero" }],
      });
    }

    const filters: any = { ...rest };

    // Aplicar scope por rol
    applyScopeFilters(scope, req.user!, filters);

    // Aplicar filtros de fecha
    applyDateFilters(date, from, to, filters);

    const result = await VentasService.breakdown(dimension, Number(top), filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_BREAKDOWN",
      payload: { dimension, top, filters, scope, date, from, to },
    });

    return success(res, result);
  },

  /**
   * 4) Serie de tiempo (timeseries)
   * GET /ventas/timeseries?granularity=hour|day|week
   */
  async timeseries(req: AuthenticatedRequest, res: Response) {
    const { granularity = "day", scope = "mine", date = "today", from, to, ...rest } = req.query as any;

    const filters: any = { ...rest };

    // Aplicar scope por rol
    applyScopeFilters(scope, req.user!, filters);

    // Aplicar filtros de fecha
    applyDateFilters(date, from, to, filters);

    // Validar límites de rango según granularidad
    validateTimeseriesRange(granularity, filters.dateFrom, filters.dateTo);

    const result = await VentasService.timeseries(granularity, filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_TIMESERIES",
      payload: { granularity, filters, scope, date, from, to },
    });

    return success(res, result);
  },

  /**
   * 5) Facets - Valores válidos para filtros dinámicos
   * GET /ventas/facets
   */
  async facets(req: AuthenticatedRequest, res: Response) {
    const { scope = "mine", date = "today", from, to, ...rest } = req.query as any;

    const filters: any = { ...rest };

    // Aplicar scope por rol
    applyScopeFilters(scope, req.user!, filters);

    // Aplicar filtros de fecha
    applyDateFilters(date, from, to, filters);

    const result = await VentasService.facets(filters);

    req.logger?.info({
      layer: "controller",
      action: "VENTA_FACETS",
      payload: { filters, scope, date, from, to },
    });

    return success(res, result);
  },
};

export default VentaController;
