import { Router } from "express";
import { SorteoController } from "../controllers/sorteo.controller";
import {
  validateCreateSorteo,
  validateUpdateSorteo,
  validateEvaluateSorteo,
  validateIdParam,
} from "../validators/sorteo.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";

const router = Router();

// ────────────────────────────────────────────────────────────
// Guards
// ────────────────────────────────────────────────────────────
function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

// All routes require auth
router.use(protect);

// ────────────────────────────────────────────────────────────
/** Admin-only (mutations) */
// Create
router.post("/", requireAdmin, validateCreateSorteo, SorteoController.create);

// Update (support both PUT & PATCH semantics pointing to same handler)
router.put(
  "/:id",
  requireAdmin,
  validateIdParam,
  validateUpdateSorteo,
  SorteoController.update
);
router.patch(
  "/:id",
  requireAdmin,
  validateIdParam,
  validateUpdateSorteo,
  SorteoController.update
);

// State transitions
router.patch("/:id/open", requireAdmin, validateIdParam, SorteoController.open);
router.patch("/:id/close", requireAdmin, validateIdParam, SorteoController.close);
router.patch(
  "/:id/evaluate",
  requireAdmin,
  validateIdParam,
  validateEvaluateSorteo,
  SorteoController.evaluate
);

// Delete (soft/hard según controller)
router.delete("/:id", requireAdmin, validateIdParam, SorteoController.delete);

// ────────────────────────────────────────────────────────────
/** Reads (any authenticated user) */
router.get("/", SorteoController.list);
router.get("/:id", validateIdParam, SorteoController.findById);

export default router;
