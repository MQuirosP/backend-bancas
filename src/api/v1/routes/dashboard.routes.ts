import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import DashboardController from "../controllers/dashboard.controller";
import { validateDashboardQuery, validateAccumulatedBalances } from "../validators/dashboard.validator";

const router = Router();

// Middleware de autenticación PRIMERO
router.use(protect);

// Middleware de contexto de banca DESPUÉS de protect (para que req.user esté disponible)
router.use(bancaContextMiddleware);

/**
 * Dashboard endpoints
 */

// Dashboard principal
router.get("/", validateDashboardQuery, DashboardController.getMainDashboard);

// Desgloses específicos
router.get("/ganancia/month-to-date", DashboardController.getGananciaMonthToDate); //  NUEVO: Sin validateDashboardQuery (no usa fechas del query)
router.get("/ganancia", validateDashboardQuery, DashboardController.getGanancia);
router.get("/cxc", validateDashboardQuery, DashboardController.getCxC);
router.get("/cxp", validateDashboardQuery, DashboardController.getCxP);

// Endpoints consolidados (reemplazan múltiples requests del FE)
router.get("/summary", validateDashboardQuery, DashboardController.getDashboardSummary);
router.get("/entities", validateDashboardQuery, DashboardController.getDashboardEntities);

// Endpoints legacy (se mantienen para compatibilidad hasta que el FE migre)
router.get("/timeseries", validateDashboardQuery, DashboardController.getTimeSeries);
router.get("/exposure", validateDashboardQuery, DashboardController.getExposure);
router.get("/vendedores", validateDashboardQuery, DashboardController.getVendedores);
router.post("/accumulated-balances", DashboardController.getAccumulatedBalances);
router.get("/accumulated-balances", DashboardController.getAccumulatedBalances);
router.get("/export", validateDashboardQuery, DashboardController.exportDashboard);

export default router;
