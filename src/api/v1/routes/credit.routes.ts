import { Router } from "express";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { Role } from "../../../generated/prisma/client";
import { CreditController } from "../controllers/credit.controller";

const router = Router();

router.use(protect);
router.use(bancaContextMiddleware);

router.get(
  "/status/me",
  restrictTo(Role.VENDEDOR, Role.VENTANA, Role.BANCA, Role.ADMIN),
  CreditController.getStatusMe
);

router.get(
  "/status",
  restrictTo(Role.VENDEDOR, Role.VENTANA, Role.BANCA, Role.ADMIN),
  CreditController.getStatus
);

export default router;
