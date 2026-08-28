import { Router } from "express";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "../../../generated/prisma/client";
import { triggerGoogleDriveBackup } from "../controllers/adminBackup.controller";

const router = Router();

// Endpoint de respaldo protegido sólo para Administradores
router.post(
  "/trigger-google-drive",
  protect,
  restrictTo(Role.ADMIN),
  triggerGoogleDriveBackup
);

export default router;
