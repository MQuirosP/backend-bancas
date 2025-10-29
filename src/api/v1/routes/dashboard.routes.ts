import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import DashboardController from "../controllers/dashboard.controller";
import { validateDashboardQuery } from "../validators/dashboard.validator";

const router = Router();

// Middleware de autenticación
router.use(protect);

/**
 * Dashboard endpoints
 */

// Dashboard principal
router.get("/", validateDashboardQuery, DashboardController.getMainDashboard);

// Desgloses específicos
router.get("/ganancia", validateDashboardQuery, DashboardController.getGanancia);
router.get("/cxc", validateDashboardQuery, DashboardController.getCxC);
router.get("/cxp", validateDashboardQuery, DashboardController.getCxP);

// Nuevos endpoints
router.get("/timeseries", validateDashboardQuery, DashboardController.getTimeSeries);
router.get("/exposure", validateDashboardQuery, DashboardController.getExposure);
router.get("/vendedores", validateDashboardQuery, DashboardController.getVendedores);
router.get("/export", validateDashboardQuery, DashboardController.exportDashboard);

export default router;
