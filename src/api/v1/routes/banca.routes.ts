import { Router } from "express";
import { BancaController } from "../controllers/banca.controller";
import { validateCreateBanca, validateUpdateBanca } from "../validators/banca.validator";
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

// Solo ADMIN puede crear/editar/eliminar Banca
router.post("/", requireAdmin, validateCreateBanca, BancaController.create);
router.put("/:id", requireAdmin, validateUpdateBanca, BancaController.update);
router.delete("/:id", requireAdmin, BancaController.delete);

// Restore
router.patch("/:id/restore", requireAdmin, BancaController.restore);

// Lectura para usuarios autenticados
router.get("/", BancaController.findAll);
router.get("/:id", BancaController.findById);

export default router;
