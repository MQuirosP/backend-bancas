import { Router } from "express";
import { TicketController } from "../controllers/ticket.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import { 
  CreateTicketSchema, 
  validateListTicketsQuery,
  RegisterPaymentSchema,
  ReversePaymentSchema,
  FinalizePaymentSchema
} from "../validators/ticket.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// Ticket CRUD
router.post("/", validateBody(CreateTicketSchema), TicketController.create);
router.get("/:id", TicketController.getById);
router.get("/", validateListTicketsQuery, TicketController.list);
router.patch("/:id/cancel", TicketController.cancel);

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
