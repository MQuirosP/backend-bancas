import { Router } from "express";
import { TicketController } from "../controllers/ticket.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import {
  CreateTicketSchema,
  validateListTicketsQuery,
  RegisterPaymentSchema,
  ReversePaymentSchema,
  FinalizePaymentSchema,
  validateNumbersSummaryQuery,
  validateTicketNumberParam
} from "../validators/ticket.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// Ticket CRUD
router.post("/", validateBody(CreateTicketSchema), TicketController.create);
// IMPORTANTE: Las rutas literales deben ir ANTES de las rutas con parámetros
router.get("/filter-options", TicketController.getFilterOptions);
router.get("/numbers-summary/filter-options", TicketController.getNumbersSummaryFilterOptions);
router.get("/numbers-summary", validateNumbersSummaryQuery, TicketController.numbersSummary);
router.post("/numbers-summary/pdf", TicketController.numbersSummaryPdf);
router.post("/numbers-summary/pdf/batch", TicketController.numbersSummaryPdfBatch);
router.get("/by-number/:ticketNumber", validateTicketNumberParam, TicketController.getByTicketNumber);
// IMPORTANTE: /:id/image debe ir ANTES de /:id para que no capture esa ruta
router.get("/:id/image", TicketController.getTicketImage);
router.get("/:id", TicketController.getById);
router.get("/", validateListTicketsQuery, TicketController.list);
router.patch("/:id/cancel", TicketController.cancel);
router.patch("/:id/restore", TicketController.restore);

// Payment endpoints (unificados en Ticket)
router.post(
  "/:id/pay",
  validateBody(RegisterPaymentSchema),
  TicketController.registerPayment
);

router.post(
  "/:id/reverse-payment",
  validateBody(ReversePaymentSchema),
  TicketController.reversePayment
);

router.post(
  "/:id/finalize-payment",
  validateBody(FinalizePaymentSchema),
  TicketController.finalizePayment
);

export default router;
