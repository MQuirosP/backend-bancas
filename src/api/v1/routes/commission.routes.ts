// src/api/v1/routes/commission.routes.ts
import { Router } from "express";
import { CommissionController } from "../controllers/commission.controller";
import {
  validateUpdateBancaCommissionPolicyBody,
  validateUpdateVentanaCommissionPolicyBody,
  validateUpdateUserCommissionPolicyBody,
} from "../validators/commission.validator";
import {
  protect,
  restrictTo,
  restrictToCommissionAdminSelfOrVentanaVendor,
} from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

router.use(protect);

// ==================== BANCA COMMISSION POLICIES ====================

// PUT /api/v1/bancas/:id/commission-policy
router.put(
  "/bancas/:id/commission-policy",
  restrictTo(Role.ADMIN),
  validateUpdateBancaCommissionPolicyBody,
  CommissionController.updateBancaCommissionPolicy
);

// GET /api/v1/bancas/:id/commission-policy
router.get(
  "/bancas/:id/commission-policy",
  restrictTo(Role.ADMIN),
  CommissionController.getBancaCommissionPolicy
);

// ==================== VENTANA COMMISSION POLICIES ====================

// PUT /api/v1/ventanas/:id/commission-policy
router.put(
  "/ventanas/:id/commission-policy",
  restrictTo(Role.ADMIN),
  validateUpdateVentanaCommissionPolicyBody,
  CommissionController.updateVentanaCommissionPolicy
);

// GET /api/v1/ventanas/:id/commission-policy
router.get(
  "/ventanas/:id/commission-policy",
  restrictTo(Role.ADMIN),
  CommissionController.getVentanaCommissionPolicy
);

// ==================== USER COMMISSION POLICIES ====================

// PUT /api/v1/users/:id/commission-policy
router.put(
  "/users/:id/commission-policy",
  restrictToCommissionAdminSelfOrVentanaVendor,
  validateUpdateUserCommissionPolicyBody,
  CommissionController.updateUserCommissionPolicy
);

// GET /api/v1/users/:id/commission-policy
router.get(
  "/users/:id/commission-policy",
  restrictToCommissionAdminSelfOrVentanaVendor,
  CommissionController.getUserCommissionPolicy
);

export default router;
