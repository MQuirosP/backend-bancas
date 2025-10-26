// src/api/v1/routes/loteria.routes.ts
import { Router } from "express";
import { LoteriaController } from "../controllers/loteria.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { validateBody, validateParams, validateQuery } from "../../../middlewares/validate.middleware";
import {
  createLoteriaSchema,
  listLoteriaQuerySchema,
  loteriaIdSchema,
  previewScheduleQuerySchema,
  updateLoteriaSchema,
  seedSorteosBodySchema,
} from "../validators/loteria.validator";
import z from "zod";

const router = Router();
router.use(protect);

// Colección
router.post(
  "/:id/seed_sorteos",
  validateParams(loteriaIdSchema),
  validateQuery(previewScheduleQuerySchema.extend({ dryRun: z.enum(["true","false"]).optional() })), // si quieres validarlo
  validateBody(seedSorteosBodySchema),
  LoteriaController.seedSorteos
)
router.post("/", validateBody(createLoteriaSchema), LoteriaController.create);
router.get("/", validateQuery(listLoteriaQuerySchema), LoteriaController.list);

// Item (acciones específicas antes del GET por id es opcional; aquí lo dejo arriba por claridad)
router.get(
  "/:id/preview_schedule",
  validateParams(loteriaIdSchema),
  validateQuery(previewScheduleQuerySchema),
  LoteriaController.previewSchedule
);

router.get("/:id", validateParams(loteriaIdSchema), LoteriaController.getById);
router.patch("/:id", validateParams(loteriaIdSchema), validateBody(updateLoteriaSchema), LoteriaController.update);
router.put("/:id", validateParams(loteriaIdSchema), validateBody(updateLoteriaSchema), LoteriaController.update);
router.delete("/:id", validateParams(loteriaIdSchema), LoteriaController.remove);
router.patch("/:id/restore", validateParams(loteriaIdSchema), LoteriaController.restore);

export default router;
