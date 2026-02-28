import { Router } from "express";
import { SorteoListasController } from "../controllers/sorteo-listas.controller";
import {
    validateIdParam,
    validateExcludeLista,
    validateIncludeLista,
} from "../validators/sorteo-listas.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdmin, requireAdminOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

// GET /api/v1/sorteos/:id/listas - Obtener resumen de listas (ADMIN + VENTANA)
router.get("/:id/listas", requireAdminOrVentana, validateIdParam, SorteoListasController.getListas);

// POST /api/v1/sorteos/:id/listas/exclude - Excluir lista (solo ADMIN)
router.post(
    "/:id/listas/exclude",
    requireAdmin,
    validateIdParam,
    validateExcludeLista,
    SorteoListasController.excludeLista
);

// POST /api/v1/sorteos/:id/listas/include - Incluir lista (solo ADMIN)
router.post(
    "/:id/listas/include",
    requireAdmin,
    validateIdParam,
    validateIncludeLista,
    SorteoListasController.includeLista
);

// GET /api/v1/sorteos/:id/listas/excluded - Obtener listas excluidas (ADMIN + VENTANA)
router.get(
    "/:id/listas/excluded",
    requireAdminOrVentana,
    validateIdParam,
    SorteoListasController.getExcludedListas
);

export default router;
