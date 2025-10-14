// src/api/v1/routes/multipliers.routes.ts
import { Router } from "express";
import MultiplierController from "../controllers/multiplier.controller";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";
import { Role } from "@prisma/client";
import { validateCreateMultiplier } from "../validators/multiplier.validator";
import { protect } from "../../../middlewares/auth.middleware";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

router.use(protect);

router.post("/", requireAdmin, validateCreateMultiplier, MultiplierController.create);
router.get("/", requireAdmin, MultiplierController.list);
router.get("/:id", requireAdmin, MultiplierController.getById);
router.patch("/:id", requireAdmin, MultiplierController.update);
router.patch("/:id/restore", requireAdmin, MultiplierController.restore);
router.delete("/:id", requireAdmin, MultiplierController.softDelete);

export default router;
