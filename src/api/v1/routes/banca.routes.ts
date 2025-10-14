import { Router } from "express";
import { BancaController } from "../controllers/banca.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  BancaIdParamSchema,
  CreateBancaSchema,
  UpdateBancaSchema,
  ListBancasQuerySchema,
  ReasonBodySchema,
} from "../validators/banca.validator";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

router.use(protect);

// Solo ADMIN puede crear/editar/eliminar Banca
router.post("/", requireAdmin, validateBody(CreateBancaSchema), BancaController.create);

router.put(
  "/:id",
  requireAdmin,
  validateParams(BancaIdParamSchema),
  validateBody(UpdateBancaSchema),
  BancaController.update
);

router.delete(
  "/:id",
  requireAdmin,
  validateParams(BancaIdParamSchema),
  validateBody(ReasonBodySchema),
  BancaController.delete
);

// Restore
router.patch(
  "/:id/restore",
  requireAdmin,
  validateParams(BancaIdParamSchema),
  BancaController.restore
);

// Lectura para usuarios autenticados
router.get("/", validateQuery(ListBancasQuerySchema), BancaController.findAll);

router.get(
  "/:id",
  validateParams(BancaIdParamSchema),
  BancaController.findById
);

export default router;
