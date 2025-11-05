// src/api/v1/routes/commissions.routes.ts
import { Router } from "express";
import { CommissionsController } from "../controllers/commissions.controller";
import {
  validateCommissionsListQuery,
  validateCommissionsDetailQuery,
  validateCommissionsTicketsQuery,
} from "../validators/commissions.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

// Autenticación y autorización (todos los endpoints requieren JWT)
router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// 1) Lista de comisiones por periodo
// GET /api/v1/commissions
router.get("/", validateCommissionsListQuery, CommissionsController.list);

// 2) Detalle de comisiones por lotería
// GET /api/v1/commissions/detail
router.get("/detail", validateCommissionsDetailQuery, CommissionsController.detail);

// 3) Tickets con comisiones (con paginación)
// GET /api/v1/commissions/tickets
router.get("/tickets", validateCommissionsTicketsQuery, CommissionsController.tickets);

export default router;

