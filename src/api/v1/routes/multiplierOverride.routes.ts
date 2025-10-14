// src/api/v1/routes/userMultiplierOverrides.routes.ts
import { Router } from "express";
import {
  createUMOValidator,
  updateUMOValidator,
  listUMOQueryValidator,
} from "../../v1/validators/multiplierOverride.validator";
import MultiplierOverrideController from "../../v1/controllers/multiplierOverride.controller";
import { validateBody, validateQuery } from "../../../middlewares/validate.middleware";
import { protect } from "../../../middlewares/auth.middleware";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import { Role } from "@prisma/client";

const router = Router();

/**
 * Solo ADMIN y VENTANA para mutaciones (create/update/delete/restore)
 */
function requireAdminOrVentana(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  const allowed: Role[] = [Role.ADMIN, Role.VENTANA];
  if (!allowed.includes(req.user.role as Role)) {
    throw new AppError("Forbidden: insufficient permissions", 403);
  }
  next();
}

// Autenticación obligatoria para todas
router.use(protect);

// Create (ADMIN, VENTANA)
router.post(
  "/",
  requireAdminOrVentana,
  validateBody(createUMOValidator),
  MultiplierOverrideController.create
);

// Update (ADMIN, VENTANA)
router.patch(
  "/:id",
  requireAdminOrVentana,
  validateBody(updateUMOValidator),
  MultiplierOverrideController.update
);

// Soft Delete (ADMIN, VENTANA) - opcionalmente acepta { deletedReason } en body
router.delete(
  "/:id",
  requireAdminOrVentana,
  MultiplierOverrideController.remove
);

// Restore (ADMIN, VENTANA)
router.patch(
  "/:id/restore",
  requireAdminOrVentana,
  MultiplierOverrideController.restore
);

// GetById (lectura para cualquier autenticado; el service aplica guardas por rol)
router.get("/:id", MultiplierOverrideController.getById);

// List (lectura para cualquier autenticado; el service limita por rol)
router.get(
  "/",
  validateQuery(listUMOQueryValidator),
  MultiplierOverrideController.list
);

export default router;
