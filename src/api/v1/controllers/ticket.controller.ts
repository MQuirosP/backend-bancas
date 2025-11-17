// src/modules/tickets/controllers/ticket.controller.ts
import { Response } from "express";
import { TicketService } from "../services/ticket.service";
import { AuthenticatedRequest } from "../../../core/types";
import { success } from "../../../utils/responses";
import { Role } from "@prisma/client";
import { resolveDateRange } from "../../../utils/dateRange";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";

export const TicketController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const userId = req.user!.id;
    const result = await TicketService.create(
      req.body,
      userId,
      req.requestId,
      req.user!.role
    );
    return success(res, result);
  },

  async getById(req: AuthenticatedRequest, res: Response) {
    const result = await TicketService.getById(req.params.id);
    return success(res, result);
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const { page = 1, pageSize = 10, scope = "mine", date = "today", fromDate, toDate, ...rest } = req.query as any;

    const me = req.user!;

    // Build auth context
    const context: AuthContext = {
      userId: me.id,
      role: me.role,
      ventanaId: me.ventanaId,
      bancaId: req.bancaContext?.bancaId || null,
    };

    // DEBUG: Log context and filters BEFORE RBAC
    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST_RBAC_DEBUG",
      payload: {
        context,
        requestFilters: rest,
        scope,
        message: "BEFORE applyRbacFilters"
      }
    });

    // Apply RBAC filters (fetches ventanaId from DB if missing in JWT)
    const effectiveFilters = await applyRbacFilters(context, { ...rest, scope });

    // DEBUG: Log AFTER RBAC
    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST_RBAC_APPLIED",
      payload: {
        effectiveFilters,
        message: "AFTER applyRbacFilters - these are the filters that will be used"
      }
    });

    // Resolver rango de fechas (mismo patrón que Venta/Dashboard)
    // Regla especial: cuando hay sorteoId y no hay fechas explícitas, NO aplicar filtros de fecha
    const hasSorteoId = effectiveFilters.sorteoId;
    const hasExplicitDateRange = fromDate || toDate;

    let dateRange: { fromAt: Date; toAt: Date; tz: string; description?: string } | null = null;
    
    if (hasSorteoId && !hasExplicitDateRange) {
      // NO aplicar filtro de fecha cuando hay sorteoId y no hay fechas explícitas
      dateRange = null;
    } else {
      // Resolver rango de fechas normalmente
      dateRange = resolveDateRange(date, fromDate, toDate);
    }

    // Build final filters for service
    // IMPORTANT: Map vendedorId → userId for backward compatibility with repository
    const filters: any = {
      ...effectiveFilters,
      ...(dateRange ? {
        dateFrom: dateRange.fromAt,
        dateTo: dateRange.toAt
      } : {})
    };

    // Repository expects 'userId' but RBAC returns 'vendedorId'
    if (effectiveFilters.vendedorId) {
      filters.userId = effectiveFilters.vendedorId;
      delete filters.vendedorId;

      req.logger?.info({
        layer: "controller",
        action: "TICKET_LIST_VENDEDOR_MAPPING",
        payload: {
          vendedorId: filters.userId,
          message: "Mapped vendedorId → userId for repository compatibility"
        }
      });
    }

    const result = await TicketService.list(Number(page), Number(pageSize), filters);

    req.logger?.info({
      layer: "controller",
      action: "TICKET_LIST",
      payload: {
        page,
        pageSize,
        scope,
        role: me.role,
        effectiveFilters,
        dateRange: dateRange ? {
          fromAt: dateRange.fromAt.toISOString(),
          toAt: dateRange.toAt.toISOString(),
          tz: dateRange.tz,
          description: dateRange.description,
        } : null,
        skippedDateFilter: hasSorteoId && !hasExplicitDateRange,
      }
    });

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

  async numbersSummary(req: AuthenticatedRequest, res: Response) {
    const { date, fromDate, toDate, scope, loteriaId, sorteoId } = req.query as any;
    
    // Validar scope (solo 'mine' permitido)
    if (scope && scope !== 'mine') {
      return res.status(400).json({
        success: false,
        error: "scope debe ser 'mine'",
      });
    }

    // Obtener vendedorId del usuario autenticado
    const vendedorId = req.user!.id;

    const result = await TicketService.numbersSummary(
      {
        date,
        fromDate,
        toDate,
        scope: scope || 'mine',
        loteriaId,
        sorteoId,
      },
      vendedorId
    );

    return success(res, result.data, result.meta);
  },

  /**
   * GET /api/v1/tickets/by-number/:ticketNumber
   * Obtiene las jugadas de un ticket existente mediante su número
   * Endpoint público/inter-vendedor (no filtra por vendedor)
   */
  async getByTicketNumber(req: AuthenticatedRequest, res: Response) {
    const { ticketNumber } = req.params;

    try {
      const result = await TicketService.getByTicketNumber(ticketNumber);
      return success(res, result);
    } catch (err: any) {
      // Manejar errores de AppError
      if (err.statusCode && err.message) {
        return res.status(err.statusCode).json({
          success: false,
          error: err.errorCode || "ERROR",
          message: err.message,
        });
      }

      // Error genérico
      return res.status(500).json({
        success: false,
        error: "INTERNAL_ERROR",
        message: "Error al obtener el ticket",
      });
    }
  },
};
