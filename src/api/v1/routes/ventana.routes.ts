import { Router } from "express";
import { VentanaController } from "../controllers/ventana.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  CreateVentanaSchema,
  UpdateVentanaSchema,
  VentanaIdParamSchema,
  ListVentanasQuerySchema,
  ReasonBodySchema,
} from "../validators/ventana.validator";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

// Solo ADMIN puede crear, editar o eliminar Ventanas
router.post("/", requireAdmin, validateBody(CreateVentanaSchema), VentanaController.create);

router.put(
  "/:id",
  requireAdmin,
  validateParams(VentanaIdParamSchema),
  validateBody(UpdateVentanaSchema),
  VentanaController.update
);

router.delete(
  "/:id",
  requireAdmin,
  validateParams(VentanaIdParamSchema),
  validateBody(ReasonBodySchema),
  VentanaController.delete
);

// Restore (sin body o con reason opcional para auditoría)
router.patch(
  "/:id/restore",
  requireAdmin,
  validateParams(VentanaIdParamSchema),
  VentanaController.restore
);

// Todos los roles autenticados pueden ver Ventanas
router.get("/", validateQuery(ListVentanasQuerySchema), VentanaController.findAll);

router.get(
  "/:id",
  validateParams(VentanaIdParamSchema),
  VentanaController.findById
);

export default router;
