import { Router } from "express";
import { VendedorController } from "../controllers/vendedor.controller";
import { validateCreateVendedor, validateUpdateVendedor } from "../validators/vendedor.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";

const router = Router();

function requireAdminOrVentana(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role === Role.ADMIN || req.user.role === Role.VENTANA) return next();
  throw new AppError("Forbidden", 403);
}

router.use(protect);

// Escritura: ADMIN o VENTANA (con scoping en Service)
router.post("/", requireAdminOrVentana, validateCreateVendedor, VendedorController.create);
router.put("/:id", requireAdminOrVentana, validateUpdateVendedor, VendedorController.update);
router.delete("/:id", requireAdminOrVentana, VendedorController.delete);
router.patch("/:id/restore", requireAdminOrVentana, VendedorController.restore);

// Lectura: cualquier autenticado (scoping en Service)
router.get("/", VendedorController.findAll);
router.get("/:id", VendedorController.findById);

export default router;
