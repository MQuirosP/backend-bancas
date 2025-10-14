import { Router } from "express";
import MultiplierController from "../controllers/multiplier.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  CreateMultiplierSchema,
  UpdateMultiplierSchema,
  ListMultipliersQuerySchema,
  MultiplierIdParamSchema,
  ToggleMultiplierSchema,
} from "../validators/multiplier.validator";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

router.post("/", requireAdmin, validateBody(CreateMultiplierSchema), MultiplierController.create);

router.get("/", requireAdmin, validateQuery(ListMultipliersQuerySchema), MultiplierController.list);

router.get("/:id", requireAdmin, validateParams(MultiplierIdParamSchema), MultiplierController.getById);

router.patch(
  "/:id",
  requireAdmin,
  validateParams(MultiplierIdParamSchema),
  validateBody(UpdateMultiplierSchema),
  MultiplierController.update
);

router.patch(
  "/:id/restore",
  requireAdmin,
  validateParams(MultiplierIdParamSchema),
  MultiplierController.restore
);

// toggle isActive (soft/hard según tu service)
router.delete(
  "/:id",
  requireAdmin,
  validateParams(MultiplierIdParamSchema),
  validateBody(ToggleMultiplierSchema), // { isActive: boolean }
  MultiplierController.softDelete
);

export default router;
