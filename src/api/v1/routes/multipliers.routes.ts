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
import {
  requireAdminOrBanca,
  requireAdminBancaOrVentana,
  requireAdminVentanaOrVendedor,
} from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

router.post("/", requireAdminOrBanca, validateBody(CreateMultiplierSchema), MultiplierController.create);

router.get(
  "/",
  requireAdminVentanaOrVendedor,
  validateQuery(ListMultipliersQuerySchema),
  MultiplierController.list
);

router.get("/:id", requireAdminOrBanca, validateParams(MultiplierIdParamSchema), MultiplierController.getById);

router.put(
  "/:id",
  requireAdminOrBanca,
  validateParams(MultiplierIdParamSchema),
  validateBody(UpdateMultiplierSchema),
  MultiplierController.update
);

router.patch(
  "/:id",
  requireAdminOrBanca,
  validateParams(MultiplierIdParamSchema),
  validateBody(UpdateMultiplierSchema),
  MultiplierController.update
);

router.patch(
  "/:id/restore",
  requireAdminOrBanca,
  validateParams(MultiplierIdParamSchema),
  MultiplierController.restore
);

// toggle isActive (soft/hard según tu service)
router.delete(
  "/:id",
  requireAdminOrBanca,
  validateParams(MultiplierIdParamSchema),
  validateBody(ToggleMultiplierSchema), // { isActive: boolean }
  MultiplierController.softDelete
);

export default router;
