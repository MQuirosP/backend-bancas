import { Router } from "express";
import { VendedorController } from "../controllers/vendedor.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../middlewares/validate.middleware";
import {
  CreateVendedorSchema,
  UpdateVendedorSchema,
  VendedorIdParamSchema,
  ListVendedoresQuerySchema,
} from "../validators/vendedor.validator";
import { requireAdminOrBanca, requireAdminBancaOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);
router.use(bancaContextMiddleware);

// Escritura
router.post(
  "/",
  requireAdminOrBanca,
  validateBody(CreateVendedorSchema),
  VendedorController.create
);

router.put(
  "/:id",
  requireAdminOrBanca,
  validateParams(VendedorIdParamSchema),
  validateBody(UpdateVendedorSchema),
  VendedorController.update
);

router.patch(
  "/:id",
  requireAdminOrBanca,
  validateParams(VendedorIdParamSchema),
  validateBody(UpdateVendedorSchema),
  VendedorController.update
);

router.delete(
  "/:id",
  requireAdminOrBanca,
  validateParams(VendedorIdParamSchema),
  VendedorController.delete
);

router.patch(
  "/:id/restore",
  requireAdminOrBanca,
  validateParams(VendedorIdParamSchema),
  VendedorController.restore
);

// Lectura
router.get(
  "/",
  requireAdminBancaOrVentana,
  validateQuery(ListVendedoresQuerySchema),
  VendedorController.findAll
);

router.get(
  "/:id",
  requireAdminBancaOrVentana,
  validateParams(VendedorIdParamSchema),
  VendedorController.findById
);

export default router;
