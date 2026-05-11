import { Router } from "express";
import { SorteoListasController } from "../controllers/sorteo-listas.controller";
import {
    validateIdParam,
    validateExcludeLista,
    validateIncludeLista,
} from "../validators/sorteo-listas.validator";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdminOrBanca, requireAdminBancaOrVentana } from "../../../middlewares/roleGuards.middleware";

const router = Router();

router.use(protect);

// GET /api/v1/sorteos/:id/listas - Obtener resumen de listas (ADMIN + BANCA + VENTANA)
router.get("/:id/listas", requireAdminBancaOrVentana, validateIdParam, SorteoListasController.getListas);

// POST /api/v1/sorteos/:id/listas/exclude - Excluir lista (ADMIN + BANCA)
router.post(
    "/:id/listas/exclude",
    requireAdminOrBanca,
    validateIdParam,
    validateExcludeLista,
    SorteoListasController.excludeLista
);

// POST /api/v1/sorteos/:id/listas/include - Incluir lista (ADMIN + BANCA)
router.post(
    "/:id/listas/include",
    requireAdminOrBanca,
    validateIdParam,
    validateIncludeLista,
    SorteoListasController.includeLista
);

// GET /api/v1/sorteos/:id/listas/excluded - Obtener listas excluidas (ADMIN + BANCA + VENTANA)
router.get(
    "/:id/listas/excluded",
    requireAdminBancaOrVentana,
    validateIdParam,
    SorteoListasController.getExcludedListas
);

export default router;
