import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import { TicketPaymentController } from "../controllers/ticketPayment.controller";
import {
  CreatePaymentSchema,
  ListPaymentsQuerySchema,
  TicketPaymentIdParamSchema,
} from "../validators/ticketPayment.validator";

const router = Router();

router.use(protect);

router.post("/", validateBody(CreatePaymentSchema), TicketPaymentController.create);
router.get("/", validateQuery(ListPaymentsQuerySchema), TicketPaymentController.list);
router.patch("/:id/reverse",
  validateParams(TicketPaymentIdParamSchema),
  TicketPaymentController.reverse
);

export default router;
