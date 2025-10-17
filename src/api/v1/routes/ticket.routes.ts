import { Router } from "express";
import { TicketController } from "../controllers/ticket.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import { CreateTicketSchema } from "../validators/ticket.validator";
import { validateListTicketsQuery } from "../validators/ticket.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

router.post("/", validateBody(CreateTicketSchema), TicketController.create);
router.get("/:id", TicketController.getById);

router.get("/", validateListTicketsQuery, TicketController.list);

router.patch("/:id/cancel", TicketController.cancel);

export default router;
