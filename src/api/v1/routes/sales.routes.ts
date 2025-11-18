// src/api/v1/routes/sales.routes.ts
import { Router } from "express";
import { SalesController } from "../controllers/sales.controller";
import { protect } from "../../../middlewares/auth.middleware";
import { requireAuth } from "../../../middlewares/roleGuards.middleware";
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

const DailyStatsQuerySchema = z.object({
  vendedorId: z.uuid().optional(),
  ventanaId: z.uuid().optional(),
  bancaId: z.uuid().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha debe ser YYYY-MM-DD").optional(),
}).strict();

const router = Router();

// Todos los endpoints requieren autenticación
router.use(protect);
router.use(requireAuth);

/**
 * GET /api/v1/sales/daily-stats
 * Obtiene las ventas del día para un vendedor, ventana o banca
 */
router.get(
  "/daily-stats",
  validateQuery(DailyStatsQuerySchema),
  SalesController.getDailyStats
);

export default router;




