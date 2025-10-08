import { Router } from "express";
import { RestrictionRuleController } from "../controllers/restrictionRule.controller";
import { validateBody } from "../../../middlewares/validate.middleware";
import { createRestrictionRuleSchema, updateRestrictionRuleSchema, listRestrictionRuleSchema } from "../validators/restrictionRule.validator";


const router = Router();


router.post("/", validateBody(createRestrictionRuleSchema), RestrictionRuleController.create);
router.get("/", validateBody(listRestrictionRuleSchema), RestrictionRuleController.list);
router.get("/:id", RestrictionRuleController.findById);
router.patch("/:id", validateBody(updateRestrictionRuleSchema), RestrictionRuleController.update);
router.delete("/:id", RestrictionRuleController.delete);
router.post("/:id/restore", RestrictionRuleController.restore);


export default router;