import { Router } from "express";
import UserBancaController from "../controllers/userBanca.controller";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";
import { validateBody, validateParams } from "../../../middlewares/validate.middleware";
import { z } from "zod";

const router = Router({ mergeParams: true });

router.use(protect);

const bancaIdParamSchema = z.object({ bancaId: z.string().uuid("Invalid bancaId") });
const assignBancaSchema = z.object({ bancaId: z.string().uuid("Invalid bancaId"), isDefault: z.boolean().optional() });

// GET / => List user bancas
router.get("/", restrictTo(Role.ADMIN, Role.BANCA), UserBancaController.list);

// POST / => Assign banca (ADMIN only)
router.post("/", restrictTo(Role.ADMIN), validateBody(assignBancaSchema), UserBancaController.assign);

// PATCH /:bancaId/default => Set default banca
router.patch("/:bancaId/default", restrictTo(Role.ADMIN, Role.BANCA), validateParams(bancaIdParamSchema), UserBancaController.setDefault);

// DELETE /:bancaId => Remove banca assignment (ADMIN only)
router.delete("/:bancaId", restrictTo(Role.ADMIN), validateParams(bancaIdParamSchema), UserBancaController.remove);

export default router;
