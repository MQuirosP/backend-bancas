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
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

// CREATE
router.post(
  "/",
  requireAdmin,
  validateBody(CreateRestrictionRuleSchema),
  RestrictionRuleController.create
);

// LIST (usa validateQuery, no validateBody)
router.get(
  "/",
  requireAdmin,
  validateQuery(ListRestrictionRuleQuerySchema),
  RestrictionRuleController.list
);

// GET BY ID
router.get(
  "/:id",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  RestrictionRuleController.findById
);

// UPDATE
router.patch(
  "/:id",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  validateBody(UpdateRestrictionRuleSchema),
  RestrictionRuleController.update
);

// SOFT DELETE (con reason opcional)
router.delete(
  "/:id",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  validateBody(ReasonBodySchema),
  RestrictionRuleController.delete
);

// RESTORE (sin body o con reason opcional si quieres)
router.patch(
  "/:id/restore",
  requireAdmin,
  validateParams(RestrictionRuleIdParamSchema),
  RestrictionRuleController.restore
);

export default router;
