import { Response } from "express";
import { SorteoService } from "../services/sorteo.service";
import { AuthenticatedRequest } from "../../../core/types";

export const SorteoController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: s });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.update(req.params.id, req.body, req.user!.id);
    res.json({ success: true, data: s });
  },

  async open(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.open(req.params.id, req.user!.id);
    res.json({ success: true, data: s });
  },

  async close(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.close(req.params.id, req.user!.id);
    res.json({ success: true, data: s });
  },

  async evaluate(req: AuthenticatedRequest, res: Response) {
    // Body ya validado por validateEvaluateSorteo
    const s = await SorteoService.evaluate(
      req.params.id,
      req.body,
      req.user!.id
    );
    res.json({ success: true, data: s });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.remove(
      req.params.id,
      req.user!.id,
      req.body?.reason
    );
    res.json({ success: true, data: s });
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const loteriaId = req.query.loteriaId
      ? String(req.query.loteriaId)
      : undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize
      ? Number(req.query.pageSize)
      : undefined;
    const status =
      typeof req.query.status === "string"
        ? (req.query.status as any)
        : undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;
    const isActive = typeof req.query.isActive !== "undefined" ? req.query.isActive === "true" || req.query.isActive === "1" : undefined;
    const date = typeof req.query.date === "string" ? req.query.date : undefined;
    const fromDate = typeof req.query.fromDate === "string" ? req.query.fromDate : undefined;
    const toDate = typeof req.query.toDate === "string" ? req.query.toDate : undefined;

    // DEBUG: Log parámetros recibidos
    req.logger?.info({
      layer: "controller",
      action: "SORTEO_LIST_DEBUG",
      payload: {
        date,
        fromDate,
        toDate,
        message: "Parámetros de fecha recibidos del FE"
      }
    });

    // Resolver rango de fechas
    // Para sorteos permitimos fechas futuras (a diferencia de tickets/ventas)
    // Si no se envía parámetro de fecha, no aplicar filtro (undefined = sin restricción)
    let dateFromResolved: Date | undefined;
    let dateToResolved: Date | undefined;

    if (date || fromDate || toDate) {
      const { resolveDateRangeAllowFuture } = await import("../../../utils/dateRange");
      const dateRange = resolveDateRangeAllowFuture(date || "range", fromDate, toDate);
      dateFromResolved = dateRange.fromAt;
      dateToResolved = dateRange.toAt;

      req.logger?.info({
        layer: "controller",
        action: "SORTEO_LIST_DATE_RESOLVED",
        payload: {
          dateRange: {
            fromAt: dateFromResolved?.toISOString(),
            toAt: dateToResolved?.toISOString(),
          },
          message: "Rango de fechas resuelto (permite futuro)"
        }
      });
    }

    const groupBy = typeof req.query.groupBy === "string" 
      ? (req.query.groupBy as "hour" | "loteria-hour" | undefined)
      : undefined;

    const result = await SorteoService.list({
      loteriaId,
      page,
      pageSize,
      status,
      search,
      isActive,
      dateFrom: dateFromResolved,
      dateTo: dateToResolved,
      groupBy,
    });

    req.logger?.info({
      layer: "controller",
      action: "SORTEO_LIST_RESULT",
      payload: {
        total: result.meta.total,
        page: result.meta.page,
        totalPages: result.meta.totalPages,
        message: "Resultado de lista"
      }
    });

    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.findById(req.params.id);
    res.json({ success: true, data: s });
  },

  async revertEvaluation(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.revertEvaluation(
      req.params.id,
      req.user!.id,
      req.body?.reason
    );
    res.json({ success: true, data: s });
  },

  async evaluatedSummary(req: AuthenticatedRequest, res: Response) {
    const { date, fromDate, toDate, scope, loteriaId } = req.query as any;
    
    // Validar scope (solo 'mine' permitido)
    if (scope && scope !== 'mine') {
      return res.status(400).json({
        success: false,
        error: "scope debe ser 'mine'",
      });
    }

    // Obtener vendedorId del usuario autenticado
    const vendedorId = req.user!.id;

    const result = await SorteoService.evaluatedSummary(
      {
        date,
        fromDate,
        toDate,
        scope: scope || 'mine',
        loteriaId,
      },
      vendedorId
    );

    res.json({ success: true, ...result });
  },

};
