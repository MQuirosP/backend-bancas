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
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import { Role } from "@prisma/client";
import { protect } from "../../../middlewares/auth.middleware";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

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
