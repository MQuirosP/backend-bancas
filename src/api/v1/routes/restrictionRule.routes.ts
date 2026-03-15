// src/modules/restrictions/routes/restrictions.router.ts
import { Router } from "express";
import { RestrictionRuleController } from "../controllers/restrictionRule.controller";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  CreateRestrictionRuleSchema,
  UpdateRestrictionRuleSchema,
  ListRestrictionRuleQuerySchema,
  RestrictionRuleIdParamSchema,
  ReasonBodySchema,
} from "../validators/restrictionRule.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdmin, requireAuth } from "../../../middlewares/roleGuards.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";

const router = Router();

//  todos los endpoints requieren estar autenticado
router.use(protect);

//  aplicar contexto de banca (resuelve bancaId para VENDEDOR/VENTANA)
router.use(bancaContextMiddleware);

/**
 * LIBERADOS (solo requieren estar autenticado)
 * GET /api/v1/restrictions
 * GET /api/v1/restrictions/:id
 * @deprecated Use /grouped for consolidated view
 */
router.get(
  "/",
  requireAuth,
  validateQuery(ListRestrictionRuleQuerySchema),
  RestrictionRuleController.list
);

/**
 * GET /api/v1/restrictions/grouped
 * Nueva vista consolidada para el frontend
 */
router.get(
  "/grouped",
  requireAuth,
  validateQuery(ListRestrictionRuleQuerySchema),
  RestrictionRuleController.listGrouped
);

/**
 *  ADMIN: Endpoint de monitoreo del cron job
 * DEBE ir ANTES de /:id para evitar conflictos de rutas
 * GET /api/v1/restrictions/cron-health
 */
router.get(
  "/cron-health",
  requireAdmin,
  RestrictionRuleController.getCronHealth
);

/**
 *  ADMIN: Ejecutar cron manualmente desde el frontend
 * POST /api/v1/restrictions/cron-health/execute
 */
router.post(
  "/cron-health/execute",
  requireAdmin,
  RestrictionRuleController.executeCronManually
);

/**
 *  VENDEDOR: Obtener mis restricciones (generales + específicas)
 * GET /api/v1/restrictions/me
 */
router.get(
  "/me",
  requireAuth,
  RestrictionRuleController.myRestrictions
);

router.get(
  "/:id",
  requireAuth,
  validateParams(RestrictionRuleIdParamSchema),
  RestrictionRuleController.findById
);

/**
 *  ADMIN (CRUD)
 */
router.post(
  "/",
  requireAdmin,
  validateBody(CreateRestrictionRuleSchema),
  RestrictionRuleController.create
);

/**
 * PUT /api/v1/restrictions/bulk
 * Edición masiva de reglas
 */
router.put(
  "/bulk",
  requireAdmin,
  // validateBody(BulkUpdateRestrictionRuleSchema), // Opcional, ya se valida en el service si es necesario
  RestrictionRuleController.bulkUpdate
);

/**
 * DELETE /api/v1/restrictions/bulk
 * Borrado masivo (desactivación lógica)
 */
router.delete(
  "/bulk",
  requireAdmin,
  RestrictionRuleController.bulkDelete
);

router.patch(
  "/:id",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  validateBody(UpdateRestrictionRuleSchema),
  RestrictionRuleController.update
);

router.delete(
  "/:id",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  validateBody(ReasonBodySchema),
  RestrictionRuleController.delete
);

router.patch(
  "/:id/restore",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  RestrictionRuleController.restore
);

export default router;
