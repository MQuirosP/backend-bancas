// src/api/v1/routes/venta.routes.ts
import { Router } from "express";
import { VentaController } from "../controllers/venta.controller";
import {
  validateListVentasQuery,
  validateVentasSummaryQuery,
  validateVentasBreakdownQuery,
  validateVentasTimeseriesQuery,
} from "../validators/venta.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { Role } from "@prisma/client";

const router = Router();

// Autenticación y autorización (todos los endpoints requieren JWT)
router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// 2) Resumen ejecutivo (KPI)
// GET /ventas/summary
router.get("/summary", validateVentasSummaryQuery, VentaController.summary);

// 3) Desglose por dimensión
// GET /ventas/breakdown?dimension=ventana|vendedor|loteria|sorteo|numero&top=10
router.get("/breakdown", validateVentasBreakdownQuery, VentaController.breakdown);

// 4) Serie de tiempo
// GET /ventas/timeseries?granularity=hour|day|week
router.get("/timeseries", validateVentasTimeseriesQuery, VentaController.timeseries);

// 1) Listado transaccional (detalle)
// GET /ventas
// IMPORTANTE: Este debe ir al final para evitar conflictos con /summary, /breakdown, /timeseries
router.get("/", validateListVentasQuery, VentaController.list);

export default router;
