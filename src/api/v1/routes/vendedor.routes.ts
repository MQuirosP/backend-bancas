import { Router } from "express";
import { VendedorController } from "../controllers/vendedor.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
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
import { requireAdminOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

// Escritura
router.post(
  "/",
  requireAdminOrVentana,
  validateBody(CreateVendedorSchema),
  VendedorController.create
);

router.put(
  "/:id",
  requireAdminOrVentana,
  validateParams(VendedorIdParamSchema),
  validateBody(UpdateVendedorSchema),
  VendedorController.update
);

router.patch(
  "/:id",
  requireAdminOrVentana,
  validateParams(VendedorIdParamSchema),
  validateBody(UpdateVendedorSchema),
  VendedorController.update
);

router.delete(
  "/:id",
  requireAdminOrVentana,
  validateParams(VendedorIdParamSchema),
  VendedorController.delete
);

router.patch(
  "/:id/restore",
  requireAdminOrVentana,
  validateParams(VendedorIdParamSchema),
  VendedorController.restore
);

// Lectura
router.get(
  "/",
  validateQuery(ListVendedoresQuerySchema),
  VendedorController.findAll
);

router.get(
  "/:id",
  validateParams(VendedorIdParamSchema),
  VendedorController.findById
);

export default router;
