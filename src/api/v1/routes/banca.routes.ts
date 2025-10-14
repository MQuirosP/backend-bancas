import { Router } from "express";
import { BancaController } from "../controllers/banca.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  BancaIdParamSchema,
  CreateBancaSchema,
  UpdateBancaSchema,
  ListBancasQuerySchema,
  ReasonBodySchema,
} from "../validators/banca.validator";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

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
