import { Router } from "express";
import { Role } from "../../../generated/prisma/client";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { PremiaticoController } from "../controllers/premiatico.controller";

const router = Router();

router.use(protect);
router.use(bancaContextMiddleware);

router.get(
  "/campaigns",
  restrictTo(Role.VENDEDOR, Role.VENTANA, Role.BANCA, Role.ADMIN),
  PremiaticoController.getCampaigns,
);

router.post(
  "/sales",
  restrictTo(Role.VENDEDOR, Role.VENTANA, Role.BANCA, Role.ADMIN),
  PremiaticoController.createSale,
);

router.get(
  "/config/banca/:bancaId",
  restrictTo(Role.ADMIN, Role.BANCA),
  PremiaticoController.getBancaConfig,
);

router.patch(
  "/config/banca/:bancaId",
  restrictTo(Role.ADMIN, Role.BANCA),
  PremiaticoController.updateBancaConfig,
);

router.patch(
  "/config/user/:userId",
  restrictTo(Role.ADMIN, Role.BANCA, Role.VENTANA),
  PremiaticoController.updateUserConfig,
);

export default router;
