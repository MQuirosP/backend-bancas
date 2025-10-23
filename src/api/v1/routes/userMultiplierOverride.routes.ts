// src/api/v1/routes/userMultiplierOverrides.routes.ts
import { Router } from "express";
import {
  createUMOValidator,
  updateUMOValidator,
  listUMOQueryValidator,
} from "../validators/userMultiplierOverride.validator";
import UserMultiplierOverrideController from "../controllers/userMultiplierOverride.controller";
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
  validateBody(createUMOValidator),
  UserMultiplierOverrideController.create
);

// Update (ADMIN, VENTANA)
router.patch(
  "/:id",
  requireAdminOrVentana,
  validateBody(updateUMOValidator),
  UserMultiplierOverrideController.update
);

// Soft Delete (ADMIN, VENTANA) - opcionalmente acepta { deletedReason } en body
router.delete(
  "/:id",
  requireAdminOrVentana,
  UserMultiplierOverrideController.remove
);

// Restore (ADMIN, VENTANA)
router.patch(
  "/:id/restore",
  requireAdminOrVentana,
  UserMultiplierOverrideController.restore
);

// GetById (lectura para cualquier autenticado; el service aplica guardas por rol)
router.get("/:id", UserMultiplierOverrideController.getById);

// List (lectura para cualquier autenticado; el service limita por rol)
router.get(
  "/",
  validateQuery(listUMOQueryValidator),
  UserMultiplierOverrideController.list
);

export default router;
