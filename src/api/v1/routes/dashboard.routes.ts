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

export default router;
