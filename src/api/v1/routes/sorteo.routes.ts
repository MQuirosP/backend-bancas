// src/api/v1/routes/sorteo.routes.ts
import { Router } from "express";
import { SorteoController } from "../controllers/sorteo.controller";
import {
  validateCreateSorteo,
  validateUpdateSorteo,
  validateEvaluateSorteo,
  validateIdParam,
  validateListSorteosQuery,
} from "../validators/sorteo.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();
router.use(protect);

// Admin
router.post("/", requireAdmin, validateCreateSorteo, SorteoController.create);
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
router.patch(
  "/:id/restore",
  requireAdmin,
  validateIdParam,
  SorteoController.update
);
router.patch(
  "/:id/close",
  requireAdmin,
  validateIdParam,
  SorteoController.close
);
router.patch("/:id/open", requireAdmin, validateIdParam, SorteoController.open);
router.patch(
  "/:id/close",
  requireAdmin,
  validateIdParam,
  SorteoController.close
);
router.patch(
  "/:id/evaluate",
  requireAdmin,
  validateIdParam,
  validateEvaluateSorteo,
  SorteoController.evaluate
);
router.delete("/:id", requireAdmin, validateIdParam, SorteoController.delete);

// Lecturas
router.get("/", validateListSorteosQuery, SorteoController.list);
router.get("/:id", validateIdParam, SorteoController.findById);

export default router;
