import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import { TicketPaymentController } from "../controllers/ticketPayment.controller";
import {
  CreatePaymentSchema,
  UpdatePaymentSchema,
  ListPaymentsQuerySchema,
  TicketPaymentIdParamSchema,
} from "../validators/ticketPayment.validator";

const router = Router();

router.use(protect);

/**
 * Ticket Payment endpoints
 */

// Crear pago
router.post(
  "/",
  validateBody(CreatePaymentSchema),
  TicketPaymentController.create
);

// Listar pagos con filtros
router.get(
  "/",
  validateQuery(ListPaymentsQuerySchema),
  TicketPaymentController.list
);

// Obtener detalles de un pago
router.get(
  "/:id",
  validateParams(TicketPaymentIdParamSchema),
  TicketPaymentController.getById
);

// Actualizar pago (marcar como final, agregar notas)
router.patch(
  "/:id",
  validateParams(TicketPaymentIdParamSchema),
  validateBody(UpdatePaymentSchema),
  TicketPaymentController.update
);

// Revertir pago
router.post(
  "/:id/reverse",
  validateParams(TicketPaymentIdParamSchema),
  TicketPaymentController.reverse
);

/**
 * Payment history endpoint (attached to tickets)
 * GET /api/v1/tickets/:ticketId/payment-history
 */
router.get(
  "/tickets/:ticketId/payment-history",
  TicketPaymentController.getPaymentHistory
);

export default router;
