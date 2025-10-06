import { Router } from "express";
import { SorteoController } from "../controllers/sorteo.controller";
import { validateCreateSorteo, validateUpdateSorteo, validateEvaluateSorteo } from "../validators/sorteo.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { AuthenticatedRequest } from "../../../core/types";
import { AppError } from "../../../core/errors";

const router = Router();

function requireAdmin(req: AuthenticatedRequest, _res: any, next: any) {
  if (!req.user) throw new AppError("Unauthorized", 401);
  if (req.user.role !== Role.ADMIN) throw new AppError("Forbidden", 403);
  next();
}

router.use(protect);

// Admin-only actions
router.post("/", requireAdmin, validateCreateSorteo, SorteoController.create);
router.put("/:id", requireAdmin, validateUpdateSorteo, SorteoController.update);
router.patch("/:id/open", requireAdmin, SorteoController.open);
router.patch("/:id/close", requireAdmin, SorteoController.close);
router.patch("/:id/evaluate", requireAdmin, validateEvaluateSorteo, SorteoController.evaluate);
router.delete("/:id", requireAdmin, SorteoController.delete);

// Reads
router.get("/", SorteoController.list);
router.get("/:id", SorteoController.findById);

export default router;
