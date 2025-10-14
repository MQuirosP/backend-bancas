import { Router } from "express";
import { LoteriaController } from "../controllers/loteria.controller";
import { protect } from "../../../middlewares/auth.middleware";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../middlewares/validate.middleware";
import { createLoteriaSchema, listLoteriaQuerySchema, loteriaIdSchema, updateLoteriaSchema } from "../validators/loteria.validator";

const router = Router();

router.use(protect);

// Crear una nueva lotería
router.post("/", validateBody(createLoteriaSchema), LoteriaController.create);

// Listar loterías (activas / eliminadas)
router.get("/", validateQuery(listLoteriaQuerySchema), LoteriaController.list);

// Obtener una lotería por ID
router.get("/:id", validateParams(loteriaIdSchema), LoteriaController.getById);

router.patch(
  "/:id",
  validateParams(loteriaIdSchema),
  validateBody(updateLoteriaSchema), // ya es parcial
  LoteriaController.update
);

// Actualizar una lotería
router.put(
  "/:id",
  validateParams(loteriaIdSchema),
  validateBody(updateLoteriaSchema),
  LoteriaController.update
);

// Eliminar (soft delete)
router.delete(
  "/:id",
  validateParams(loteriaIdSchema),
  LoteriaController.remove
);

// Restaurar
router.patch(
  "/:id/restore",
  validateParams(loteriaIdSchema),
  LoteriaController.restore
);

export default router;
