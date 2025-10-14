import { Router } from "express";
import { RestrictionRuleController } from "../controllers/restrictionRule.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import { createRestrictionRuleSchema, updateRestrictionRuleSchema, listRestrictionRuleSchema } from "../validators/restrictionRule.validator";
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

router.use(protect)

router.post("/", requireAdmin, validateBody(createRestrictionRuleSchema), RestrictionRuleController.create);
router.get("/", requireAdmin, validateBody(listRestrictionRuleSchema), RestrictionRuleController.list);
router.get("/:id", requireAdmin, RestrictionRuleController.findById);
router.patch("/:id",requireAdmin, validateBody(updateRestrictionRuleSchema), RestrictionRuleController.update);
router.delete("/:id", requireAdmin, RestrictionRuleController.delete);
router.patch("/:id/restore", requireAdmin,  RestrictionRuleController.restore);


export default router;