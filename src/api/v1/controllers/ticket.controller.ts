// src/modules/tickets/controllers/ticket.controller.ts
import { Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d: Date) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

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
    const { page = 1, pageSize = 10, scope = "mine", date = "today", from, to, ...rest } = req.query as any;

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

    // date → rango de fechas sobre createdAt (igual que antes)
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
        return res.status(400).json({ success: false, message: "Para date=range debes enviar from y to (ISO)" });
      }
      const df = new Date(from);
      const dt = new Date(to);
      if (isNaN(df.getTime()) || isNaN(dt.getTime())) {
        return res.status(400).json({ success: false, message: "from/to inválidos" });
      }
      filters.dateFrom = df;
      filters.dateTo = dt;
    }

    const result = await TicketService.list(Number(page), Number(pageSize), filters);
    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST_RESOLVED_FILTERS",
      payload: { filters, page, pageSize, scope, date, from, to }
    })
    console.log(result)
    return success(res, result);
  },

  async cancel(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.cancel(req.params.id, userId, req.requestId);
    return success(res, result);
  },
};
