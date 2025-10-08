import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { TicketPaymentController } from "../controllers/ticketPayment.controller";

const router = Router();

router.post("/", protect, TicketPaymentController.create);
router.get("/", protect, TicketPaymentController.list);
router.patch("/:id/reverse", protect, TicketPaymentController.reverse);

export default router;
