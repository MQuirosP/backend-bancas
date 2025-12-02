import { Router } from "express";
import { SorteoListasController } from "../controllers/sorteo-listas.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAdmin } from "../../../middlewares/roleGuards.middleware";

const router = Router();

// Todas las rutas requieren autenticación y rol ADMIN
router.use(protect);
router.use(requireAdmin);

/**
 * GET /api/v1/listas-excluidas
 * Obtiene todas las listas excluidas con filtros opcionales
 *
 * Query params:
 * - sorteoId: Filtrar por sorteo específico
 * - ventanaId: Filtrar por ventana específica
 * - vendedorId: Filtrar por vendedor específico
 * - multiplierId: Filtrar por multiplicador específico
 * - loteriaId: Filtrar por lotería específica
 * - fromDate: Fecha desde (ISO string)
 * - toDate: Fecha hasta (ISO string)
 *
 * Response: Respuesta normalizada con información completa
 */
router.get("/", SorteoListasController.getExcludedListas);

export default router;
