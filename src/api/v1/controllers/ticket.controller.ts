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
    const me = req.user!;

    // RBAC: Applica automáticamente según el rol, ignorando scope si es insuficiente
    // VENDEDOR: Solo ve sus tickets (scope se ignora)
    // VENTANA: Solo ve tickets de su ventana (scope se ignora)
    // ADMIN: Respeta scope (mine = sin filtro, all = todos)
    if (me.role === Role.VENDEDOR) {
      // VENDEDOR always sees only own tickets (scope parameter ignored)
      filters.userId = me.id;
    } else if (me.role === Role.VENTANA) {
      // VENTANA always sees only own window's tickets (scope parameter ignored)
      filters.ventanaId = me.ventanaId;
    } else if (me.role === Role.ADMIN) {
      // ADMIN respects scope parameter
      if (scope === "mine") {
        // admin scope=mine: no filters (sees all, but can be scoped if needed)
      }
      // scope=all (or anything else): no filters, sees all
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
        role: me.role,
        rbacApplied: me.role === Role.VENDEDOR ? "userId" : (me.role === Role.VENTANA ? "ventanaId" : "none"),
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

  // ==================== PAYMENT ENDPOINTS ====================

  /**
   * POST /api/v1/tickets/:id/pay
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  async registerPayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const result = await TicketService.registerPayment(
      ticketId,
      req.body,
      userId,
      req.requestId
    );
    return success(res, result);
  },

  /**
   * POST /api/v1/tickets/:id/reverse-payment
   * Revertir el último pago de un ticket
   */
  async reversePayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const { reason } = req.body;
    const result = await TicketService.reversePayment(
      ticketId,
      userId,
      reason,
      req.requestId
    );
    return success(res, result);
  },

  /**
   * POST /api/v1/tickets/:id/finalize-payment
   * Marcar el pago parcial como final (acepta deuda restante)
   */
  async finalizePayment(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const ticketId = req.params.id;
    const { notes } = req.body;
    const result = await TicketService.finalizePayment(
      ticketId,
      userId,
      notes,
      req.requestId
    );
    return success(res, result);
  },
};
