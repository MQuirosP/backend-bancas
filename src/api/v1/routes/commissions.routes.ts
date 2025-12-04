// src/api/v1/routes/commissions.routes.ts
import { Router } from "express";
import { CommissionsController } from "../controllers/commissions.controller";
import {
  validateCommissionsListQuery,
  validateCommissionsDetailQuery,
  validateCommissionsTicketsQuery,
  validateCommissionsExportQuery,
} from "../validators/commissions.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { Role } from "@prisma/client";
import rateLimit from "express-rate-limit";

const router = Router();

// Autenticación y autorización (todos los endpoints requieren JWT)
router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// Middleware de contexto de banca DESPUÉS de protect (para que req.user esté disponible)
router.use(bancaContextMiddleware);

// Rate limiter específico para exportaciones
const exportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // 10 exportaciones por minuto por usuario
  skipSuccessfulRequests: false,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: "Demasiadas exportaciones. Por favor espere un momento antes de intentar nuevamente.",
    });
  },
});

// 1) Lista de comisiones por periodo
// GET /api/v1/commissions
router.get("/", validateCommissionsListQuery, CommissionsController.list);

// 2) Detalle de comisiones por lotería
// GET /api/v1/commissions/detail
router.get("/detail", validateCommissionsDetailQuery, CommissionsController.detail);

// 3) Tickets con comisiones (con paginación)
// GET /api/v1/commissions/tickets
router.get("/tickets", validateCommissionsTicketsQuery, CommissionsController.tickets);

// 4) Exportación de comisiones (CSV, Excel, PDF)
// GET /api/v1/commissions/export
router.get("/export", exportLimiter, validateCommissionsExportQuery, CommissionsController.export);

export default router;

