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
 * Middleware: permite solo a ADMIN y VENTANA 
 */
function requireAdminOrVentana(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);

  const allowedRoles: Role[] = [Role.ADMIN, Role.VENTANA];
  if (!allowedRoles.includes(req.user.role as Role)) {
    throw new AppError("Forbidden: insufficient permissions", 403);
  }

  next();
}

/** 
 * Middleware: permite lectura a cualquier usuario autenticado
 */
router.use(protect);

// Crear (ADMIN, VENTANA)
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

// Delete (ADMIN, VENTANA)
router.delete("/:id", requireAdminOrVentana, MultiplierOverrideController.remove);

// GetById (ADMIN, VENTANA dueños, VENDEDOR si es suyo)
router.get("/:id", MultiplierOverrideController.getById);

// List (ADMIN global; VENTANA acotado a su ventana; VENDEDOR: solo suyos)
router.get("/", validateQuery(listUMOQueryValidator), MultiplierOverrideController.list);

export default router;
