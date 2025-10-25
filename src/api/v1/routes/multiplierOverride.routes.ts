// src/api/v1/routes/multiplierOverride.routes.ts
import { Router } from "express";
import {
  createMultiplierOverrideValidator,
  updateMultiplierOverrideValidator,
  listMultiplierOverrideQueryValidator,
  idParamValidator,
} from "../validators/multiplierOverride.validator";
import MultiplierOverrideController from "../controllers/multiplierOverride.controller";
import { validateBody, validateQuery, validateParams } from "../../../middlewares/validate.middleware";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdminOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

// Authentication required for all routes
router.use(protect);

// Create (ADMIN, VENTANA)
router.post(
  "/",
  requireAdminOrVentana,
  validateBody(createMultiplierOverrideValidator),
  MultiplierOverrideController.create
);

// Update (ADMIN, VENTANA)
router.put(
  "/:id",
  requireAdminOrVentana,
  validateParams(idParamValidator),
  validateBody(updateMultiplierOverrideValidator),
  MultiplierOverrideController.update
);

// Soft Delete (ADMIN, VENTANA) - optionally accepts { deletedReason } in body
router.delete(
  "/:id",
  requireAdminOrVentana,
  validateParams(idParamValidator),
  MultiplierOverrideController.remove
);

// Restore (ADMIN, VENTANA)
router.patch(
  "/:id/restore",
  requireAdminOrVentana,
  validateParams(idParamValidator),
  MultiplierOverrideController.restore
);

// GetById (read for any authenticated user; service applies role-based guards)
router.get(
  "/:id",
  validateParams(idParamValidator),
  MultiplierOverrideController.getById
);

// List (read for any authenticated user; service limits by role)
router.get(
  "/",
  validateQuery(listMultiplierOverrideQueryValidator),
  MultiplierOverrideController.list
);

export default router;
