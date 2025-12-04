// src/api/v1/routes/accounts.routes.ts
import { Router } from "express";
import { AccountsController } from "../controllers/accounts.controller";
import {
  validateGetStatementQuery,
  validateCreatePaymentBody,
  validateGetPaymentHistoryQuery,
  validateReversePaymentBody,
  validateGetCurrentBalanceQuery,
  validateAccountStatementExportQuery,
} from "../validators/accounts.validator";
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

// 1) Obtener estado de cuenta día a día del mes
// GET /accounts/statement
router.get("/statement", validateGetStatementQuery, AccountsController.getStatement);

// 2) Registrar pago o cobro
// POST /accounts/payment
router.post("/payment", validateCreatePaymentBody, AccountsController.createPayment);

// 3) Obtener historial de pagos/cobros de un día
// GET /accounts/payment-history
router.get("/payment-history", validateGetPaymentHistoryQuery, AccountsController.getPaymentHistory);

// 4) Revertir un pago/cobro
// POST /accounts/reverse-payment
router.post("/reverse-payment", validateReversePaymentBody, AccountsController.reversePayment);

// 5) Eliminar un estado de cuenta (solo ADMIN, solo si está vacío)
// DELETE /accounts/statement/:id
router.delete("/statement/:id", AccountsController.deleteStatement);

// 6) Obtener balance acumulado actual de la ventana (solo VENTANA)
// GET /accounts/balance/current
router.get("/balance/current", validateGetCurrentBalanceQuery, AccountsController.getCurrentBalance);

// 7) Exportar estados de cuenta (CSV, Excel, PDF)
// GET /accounts/export
router.get("/export", exportLimiter, validateAccountStatementExportQuery, AccountsController.export);

export default router;
