import { Router } from "express";
import { protect } from "../../../middlewares/auth.middleware";
import DashboardController from "../controllers/dashboard.controller";

const router = Router();

// Middleware de autenticación
router.use(protect);

/**
 * Dashboard endpoints
 */

// Dashboard principal
router.get("/", DashboardController.getMainDashboard);

// Desgloses específicos
router.get("/ganancia", DashboardController.getGanancia);
router.get("/cxc", DashboardController.getCxC);
router.get("/cxp", DashboardController.getCxP);

export default router;
