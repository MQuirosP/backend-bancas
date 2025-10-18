import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdminOrVentana } from "../../../middlewares/roleGuards.middleware";
import { validateQuery } from "../../../middlewares/validate.middleware";
import { CutoffInspectQuerySchema } from "../validators/diagnostics.validator";
import DiagnosticsController from "../controllers/diagnostics.controller";

const router = Router();

router.use(protect);

// Admin o Ventana (la verificación de “alcance” de ventana concreta se hace aguas arriba si deseas)
router.get(
  "/cutoff",
  requireAdminOrVentana,
  validateQuery(CutoffInspectQuerySchema),
  DiagnosticsController.cutoffInspect
);

export default router;
