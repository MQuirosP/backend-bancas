import { Router } from "express";
import { VentanaController } from "../controllers/ventana.controller";
import { validateCreateVentana, validateUpdateVentana } from "../validators/ventana.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

router.use(protect);

// Solo ADMIN puede crear, editar o eliminar Ventanas
router.post("/", requireAdmin, validateCreateVentana, VentanaController.create);
router.put("/:id", requireAdmin, validateUpdateVentana, VentanaController.update);
router.delete("/:id", requireAdmin, VentanaController.delete);

// Restore
router.patch("/:id/restore", requireAdmin, VentanaController.restore);

// Todos los roles autenticados pueden ver Ventanas
router.get("/", VentanaController.findAll);
router.get("/:id", VentanaController.findById);

export default router;
