import { Router } from "express";
import { SorteoListasController } from "../controllers/sorteo-listas.controller";
import {
    validateIdParam,
    validateExcludeLista,
    validateIncludeLista,
} from "../validators/sorteo-listas.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

// Todas las rutas requieren autenticación y rol ADMIN
router.use(protect);
router.use(requireAdmin);

// GET /api/v1/sorteos/:id/listas - Obtener resumen de listas
router.get("/:id/listas", validateIdParam, SorteoListasController.getListas);

// POST /api/v1/sorteos/:id/listas/exclude - Excluir lista
router.post(
    "/:id/listas/exclude",
    validateIdParam,
    validateExcludeLista,
    SorteoListasController.excludeLista
);

// POST /api/v1/sorteos/:id/listas/include - Incluir lista (revertir exclusión)
router.post(
    "/:id/listas/include",
    validateIdParam,
    validateIncludeLista,
    SorteoListasController.includeLista
);

// GET /api/v1/sorteos/:id/listas/excluded - Obtener listas excluidas
router.get(
    "/:id/listas/excluded",
    validateIdParam,
    SorteoListasController.getExcludedListas
);

export default router;
