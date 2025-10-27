// src/modules/tickets/controllers/ticket.controller.ts
import { Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { resolveDateRange } from "../../../utils/dateRange";

export const TicketController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.create(req.body, userId, req.requestId);
    return success(res, result);
  },

  async getById(req: AuthenticatedRequest, res: Response) {
    const result = await TicketService.getById(req.params.id);
    return success(res, result);
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const { page = 1, pageSize = 10, scope = "mine", date = "today", fromDate, toDate, ...rest } = req.query as any;

    const filters: any = { ...rest };

    // scope → filtrar según el rol del usuario autenticado
    if (scope === "mine") {
      const me = req.user!;
      if (me.role === Role.VENDEDOR) {
        filters.userId = me.id;             // tickets del vendedor
      } else if (me.role === Role.VENTANA) {
        filters.ventanaId = me.ventanaId;   // tickets de la ventana (todos sus vendedores)
      } else if (me.role === Role.ADMIN) {
        // admin con scope=mine -> si quieres, podrías filtrar por algo; por ahora, sin filtro
      }
    }

    // Resolver rango de fechas (mismo patrón que Venta/Dashboard)
    const dateRange = resolveDateRange(date, fromDate, toDate);
    filters.dateFrom = dateRange.fromAt;
    filters.dateTo = dateRange.toAt;

    const result = await TicketService.list(Number(page), Number(pageSize), filters);
    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST",
      payload: {
        page,
        pageSize,
        scope,
        dateRange: {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz,
          description: dateRange.description,
        }
      }
    })
    return success(res, result);
  },

  async cancel(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.cancel(req.params.id, userId, req.requestId);
    return success(res, result);
  },
};
