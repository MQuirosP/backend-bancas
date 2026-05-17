import { Router } from "express";
import { VentanaController } from "../controllers/ventana.controller";
import { protect, restrictToAdminOrSelf, restrictToAdminOrVentanaSelf } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  CreateVentanaSchema,
  UpdateVentanaSchema,
  VentanaIdParamSchema,
  ListVentanasQuerySchema,
  ReasonBodySchema,
} from "../validators/ventana.validator";
import { requireAdmin, requireAdminOrBanca } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);
router.use(bancaContextMiddleware);

// Solo ADMIN o BANCA pueden crear, editar o eliminar Ventanas
router.post("/", requireAdminOrBanca, validateBody(CreateVentanaSchema), VentanaController.create);

router.put(
  "/:id",
  restrictToAdminOrVentanaSelf,
  validateParams(VentanaIdParamSchema),
  validateBody(UpdateVentanaSchema),
  VentanaController.update
);

router.patch(
  "/:id",
  restrictToAdminOrVentanaSelf,
  validateParams(VentanaIdParamSchema),
  validateBody(UpdateVentanaSchema),
  VentanaController.update
);

router.delete(
  "/:id",
  restrictToAdminOrVentanaSelf,
  validateParams(VentanaIdParamSchema),
  validateBody(ReasonBodySchema),
  VentanaController.delete
);

// Restore (sin body o con reason opcional para auditoría)
router.patch(
  "/:id/restore",
  restrictToAdminOrVentanaSelf,
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
