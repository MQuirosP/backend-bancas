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

const router = Router();

// 🔐 todos los endpoints requieren estar autenticado
router.use(protect);

/**
 * LIBERADOS (solo requieren estar autenticado)
 * GET /api/v1/restrictions
 * GET /api/v1/restrictions/:id
 */
router.get(
  "/",
  requireAuth,                          // ← antes requireAdmin
  validateQuery(ListRestrictionRuleQuerySchema),
  RestrictionRuleController.list
);

router.get(
  "/:id",
  requireAuth,                          // ← antes requireAdmin
  validateParams(RestrictionRuleIdParamSchema),
  RestrictionRuleController.findById
);

/**
 * 🔒 ADMIN (CRUD)
 */
router.post(
  "/",
  requireAdmin,
  validateBody(CreateRestrictionRuleSchema),
  RestrictionRuleController.create
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
