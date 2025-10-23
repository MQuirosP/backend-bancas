// src/api/v1/routes/ventanaMultiplierOverrides.routes.ts
import { Router } from "express";
import {
  createVMOValidator,
  updateVMOValidator,
  listVMOQueryValidator,
} from "../validators/ventanaMultiplierOverride.validator";
import VentanaMultiplierOverrideController from "../controllers/ventanaMultiplierOverride.controller";
import { validateBody, validateQuery } from "../../../middlewares/validate.middleware";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdminOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

// Autenticación obligatoria para todas
router.use(protect);

// Create (ADMIN, VENTANA)
router.post(
  "/",
  requireAdminOrVentana,
  validateBody(createVMOValidator),
  VentanaMultiplierOverrideController.create
);

// Update (ADMIN, VENTANA)
router.patch(
  "/:id",
  requireAdminOrVentana,
  validateBody(updateVMOValidator),
  VentanaMultiplierOverrideController.update
);

// Deactivate (ADMIN, VENTANA) - opcionalmente acepta { deletedReason } en body
router.delete(
  "/:id",
  requireAdminOrVentana,
  VentanaMultiplierOverrideController.remove
);

// Restore (ADMIN, VENTANA)
router.patch(
  "/:id/restore",
  requireAdminOrVentana,
  VentanaMultiplierOverrideController.restore
);

// GetById (lectura para cualquier autenticado; el service aplica guardas por rol)
router.get("/:id", VentanaMultiplierOverrideController.getById);

// List (lectura para cualquier autenticado; el service limita por rol)
router.get(
  "/",
  validateQuery(listVMOQueryValidator),
  VentanaMultiplierOverrideController.list
);

export default router;
