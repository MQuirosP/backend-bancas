// src/api/v1/routes/commission.routes.ts
import { Router } from "express";
import { CommissionController } from "../controllers/commission.controller";
import {
  validateUpdateBancaCommissionPolicyBody,
  validateUpdateVentanaCommissionPolicyBody,
  validateUpdateUserCommissionPolicyBody,
} from "../validators/commission.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

// Todos los endpoints de comisiones son ADMIN only
router.use(protect);
router.use(restrictTo(Role.ADMIN));

// ==================== BANCA COMMISSION POLICIES ====================

// PUT /api/v1/bancas/:id/commission-policy
router.put(
  "/bancas/:id/commission-policy",
  validateUpdateBancaCommissionPolicyBody,
  CommissionController.updateBancaCommissionPolicy
);

// GET /api/v1/bancas/:id/commission-policy
router.get("/bancas/:id/commission-policy", CommissionController.getBancaCommissionPolicy);

// ==================== VENTANA COMMISSION POLICIES ====================

// PUT /api/v1/ventanas/:id/commission-policy
router.put(
  "/ventanas/:id/commission-policy",
  validateUpdateVentanaCommissionPolicyBody,
  CommissionController.updateVentanaCommissionPolicy
);

// GET /api/v1/ventanas/:id/commission-policy
router.get("/ventanas/:id/commission-policy", CommissionController.getVentanaCommissionPolicy);

// ==================== USER COMMISSION POLICIES ====================

// PUT /api/v1/users/:id/commission-policy
router.put(
  "/users/:id/commission-policy",
  validateUpdateUserCommissionPolicyBody,
  CommissionController.updateUserCommissionPolicy
);

// GET /api/v1/users/:id/commission-policy
router.get("/users/:id/commission-policy", CommissionController.getUserCommissionPolicy);

export default router;
