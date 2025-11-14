// src/api/v1/routes/sorteo.routes.ts
import { Router } from "express";
import { SorteoController } from "../controllers/sorteo.controller";
import {
  validateCreateSorteo,
  validateUpdateSorteo,
  validateEvaluateSorteo,
  validateIdParam,
  validateListSorteosQuery,
  validateRevertSorteo,
  validateEvaluatedSummaryQuery,
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
  "/:id/evaluate",
  requireAdmin,
  validateIdParam,
  validateEvaluateSorteo,
  SorteoController.evaluate
);
router.patch(
  "/:id/revert-evaluation",
  requireAdmin,
  validateIdParam,
  validateRevertSorteo,
  SorteoController.revertEvaluation
);
router.delete("/:id", requireAdmin, validateIdParam, SorteoController.delete);

// Lecturas
// IMPORTANTE: Las rutas literales deben ir ANTES de las rutas con parámetros
router.get("/evaluated-summary", validateEvaluatedSummaryQuery, SorteoController.evaluatedSummary);
router.get("/", validateListSorteosQuery, SorteoController.list);
// Usar regex para que :id solo acepte UUIDs (evita conflictos con rutas literales)
router.get("/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", validateIdParam, SorteoController.findById);

export default router;
