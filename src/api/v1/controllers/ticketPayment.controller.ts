import { Request, Response } from "express";
import { AppError } from "../../../core/errors";
import { success, created } from "../../../utils/responses";
import { AuthenticatedRequest } from "../../../core/types";
import ActivityService from "../../../core/activity.service";
import TicketPaymentService from "../services/ticketPayment.service";
import {
  CreatePaymentSchema,
  UpdatePaymentSchema,
  ListPaymentsQuerySchema,
} from "../validators/ticketPayment.validator";

export const TicketPaymentController = {
  /**
   * POST /api/v1/ticket-payments
   * Registrar un pago de tiquete (total o parcial)
   * Si idempotencyKey ya existe, devuelve el pago existente con indicador cached=true
   */
  async create(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    // Validar request body
    const validatedData = CreatePaymentSchema.parse(req.body);

    const result = await TicketPaymentService.create(validatedData, {
      id: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    });

    // Verificar si es una respuesta cacheada (pago duplicado con idempotencyKey)
    const isCached = (result as any).cached === true;
    const statusCode = isCached ? 200 : 201;

    // Log en controller
    await ActivityService.log({
      userId: req.user.id,
      action: "TICKET_PAY" as any,
      targetType: "TICKET_PAYMENT",
      targetId: result.id,
      details: { created: !isCached, cached: isCached },
      layer: "controller",
    });

    // Limpiar propiedad temporal antes de enviar respuesta
    const responseData = { ...result };
    delete (responseData as any).cached;

    // Enviar respuesta con status code apropiado y meta indicando si es cacheado
    return res.status(statusCode).json({
      success: true,
      data: responseData,
      ...(isCached ? { meta: { cached: true } } : {}),
    });
  },

  /**
   * GET /api/v1/ticket-payments
   * Listar pagos con filtros y paginación
   */
  async list(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);

    // Validar query params
    const validatedQuery = ListPaymentsQuerySchema.parse(req.query);

    // Convertir fechas si existen
    const filters: any = {
      ventanaId: validatedQuery.ventanaId,
      vendedorId: validatedQuery.vendedorId,
      ticketId: validatedQuery.ticketId,
      status: validatedQuery.status,
      sortBy: validatedQuery.sortBy,
      sortOrder: validatedQuery.sortOrder,
    };

    if (validatedQuery.fromDate) {
      filters.fromDate = new Date(validatedQuery.fromDate);
    }
    if (validatedQuery.toDate) {
      filters.toDate = new Date(validatedQuery.toDate + "T23:59:59Z");
    }

    const result = await TicketPaymentService.list(
      validatedQuery.page,
      validatedQuery.pageSize,
      filters,
      {
        id: req.user.id,
        role: req.user.role,
        ventanaId: req.user.ventanaId,
      }
    );

    return success(res, result);
  },

  /**
   * GET /api/v1/ticket-payments/:id
   * Obtener detalles de un pago específico
   */
  async getById(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const { id } = req.params;

    const result = await TicketPaymentService.getById(id, {
      id: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    });

    return success(res, result);
  },

  /**
   * PATCH /api/v1/ticket-payments/:id
   * Actualizar un pago (marcar como final, agregar notas)
   */
  async update(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const { id } = req.params;

    // Validar request body
    const validatedData = UpdatePaymentSchema.parse(req.body);

    const result = await TicketPaymentService.update(
      id,
      validatedData,
      req.user.id,
      {
        id: req.user.id,
        role: req.user.role,
        ventanaId: req.user.ventanaId,
      }
    );

    return success(res, result);
  },

  /**
   * POST /api/v1/ticket-payments/:id/reverse
   * Revertir un pago
   */
  async reverse(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const { id } = req.params;

    const result = await TicketPaymentService.reverse(id, req.user.id, {
      id: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    });

    await ActivityService.log({
      userId: req.user.id,
      action: "TICKET_PAYMENT_REVERSE" as any,
      targetType: "TICKET_PAYMENT",
      targetId: id,
      details: { reversed: true },
      layer: "controller",
    });

    return success(res, result);
  },

  /**
   * GET /api/v1/tickets/:ticketId/payment-history
   * Obtener historial de pagos de un tiquete
   */
  async getPaymentHistory(req: AuthenticatedRequest, res: Response) {
    if (!req.user) throw new AppError("Unauthorized", 401);
    const { ticketId } = req.params;

    const result = await TicketPaymentService.getPaymentHistory(ticketId, {
      id: req.user.id,
      role: req.user.role,
      ventanaId: req.user.ventanaId,
    });

    return success(res, result);
  },
};

export default TicketPaymentController;
