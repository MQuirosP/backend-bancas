// src/api/v1/routes/sorteo.routes.ts
import { Router } from "express";
import { SorteoController } from "../controllers/sorteo.controller";
import { SorteoListasController } from "../controllers/sorteo-listas.controller";
import {
  validateCreateSorteo,
  validateUpdateSorteo,
  validateEvaluateSorteo,
  validateIdParam,
  validateListSorteosQuery,
  validateRevertSorteo,
  validateEvaluatedSummaryQuery,
  validateSetActiveSorteo,
} from "../validators/sorteo.validator";
import {
  validateIdParam as validateListaIdParam,
  validateExcludeLista,
  validateIncludeLista,
} from "../validators/sorteo-listas.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { requireAdmin, requireAdminOrBanca, requireAdminBancaOrVentana } from "../../../middlewares/roleGuards.middleware";
import { SorteosAutoController } from "../controllers/sorteosAuto.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import { UpdateSorteosAutoConfigSchema } from "../validators/sorteosAuto.validator";

const router = Router();
router.use(protect);
router.use(bancaContextMiddleware);

// IMPORTANTE: Rutas literales específicas DEBEN ir ANTES de las rutas con parámetros :id
// Rutas de automatización de sorteos (rutas literales primero)
router.get('/auto-config', requireAdmin, SorteosAutoController.getConfig);
router.patch(
  '/auto-config',
  requireAdmin,
  validateBody(UpdateSorteosAutoConfigSchema),
  SorteosAutoController.updateConfig
);
router.get('/auto-status', SorteosAutoController.getHealthStatus);
router.post('/auto-open/execute', requireAdminOrBanca, SorteosAutoController.executeAutoOpen);
router.post('/auto-create/execute', requireAdminOrBanca, SorteosAutoController.executeAutoCreate);
router.post('/auto-close/execute', requireAdminOrBanca, SorteosAutoController.executeAutoClose);

// Admin - Rutas de sorteos
router.post("/", requireAdminOrBanca, validateCreateSorteo, SorteoController.create);
router.put(
  "/:id",
  requireAdminOrBanca,
  validateIdParam,
  validateUpdateSorteo,
  SorteoController.update
);
router.patch(
  "/:id",
  requireAdminOrBanca,
  validateIdParam,
  validateUpdateSorteo,
  SorteoController.update
);
router.patch(
  "/:id/restore",
  requireAdminOrBanca,
  validateIdParam,
  SorteoController.restore
);
router.patch(
  "/:id/reset-to-scheduled",
  requireAdminOrBanca,
  validateIdParam,
  SorteoController.resetToScheduled
);
router.patch(
  "/:id/close",
  requireAdminOrBanca,
  validateIdParam,
  SorteoController.close
);
router.patch("/:id/open", requireAdminOrBanca, validateIdParam, SorteoController.open);
router.patch("/:id/force-open", requireAdminOrBanca, validateIdParam, SorteoController.forceOpen);
router.patch("/:id/activate-and-open", requireAdminOrBanca, validateIdParam, SorteoController.activateAndOpen);
router.patch(
  "/:id/set-active",
  requireAdminOrBanca,
  validateIdParam,
  validateSetActiveSorteo,
  SorteoController.setActive
);
router.patch(
  "/:id/evaluate",
  requireAdminOrBanca,
  validateIdParam,
  validateEvaluateSorteo,
  SorteoController.evaluate
);
router.patch(
  "/:id/revert-evaluation",
  requireAdminOrBanca,
  validateIdParam,
  validateRevertSorteo,
  SorteoController.revertEvaluation
);
router.delete("/:id", requireAdminOrBanca, validateIdParam, SorteoController.delete);

// Rutas de exclusión de listas (ADMIN only, pero VENTANA puede ver el resumen)
router.get("/:id/listas", requireAdminBancaOrVentana, validateListaIdParam, SorteoListasController.getListas);
router.post("/:id/listas/exclude", requireAdminOrBanca, validateListaIdParam, validateExcludeLista, SorteoListasController.excludeLista);
router.post("/:id/listas/include", requireAdminOrBanca, validateListaIdParam, validateIncludeLista, SorteoListasController.includeLista);

// Lecturas
// IMPORTANTE: Las rutas literales deben ir ANTES de las rutas con parámetros
router.get("/evaluated-summary", validateEvaluatedSummaryQuery, SorteoController.evaluatedSummary);
router.get("/", validateListSorteosQuery, SorteoController.list);
// Usar regex para que :id solo acepte UUIDs (evita conflictos con rutas literales)
router.get("/:id([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", validateIdParam, SorteoController.findById);

export default router;
