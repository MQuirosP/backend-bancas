// src/api/v1/routes/venta.routes.ts
import { Router } from "express";
import { VentaController } from "../controllers/venta.controller";
import {
  validateListVentasQuery,
  validateVentasSummaryQuery,
  validateVentasBreakdownQuery,
  validateVentasTimeseriesQuery,
  validateFacetsQuery,
} from "../validators/venta.validator";
import { protect, restrictTo } from "../../../middlewares/auth.middleware";
import { bancaContextMiddleware } from "../../../middlewares/bancaContext.middleware";
import { Role } from "@prisma/client";

const router = Router();

// Autenticación y autorización (todos los endpoints requieren JWT)
router.use(protect);
router.use(restrictTo(Role.VENDEDOR, Role.VENTANA, Role.ADMIN));

// Middleware de contexto de banca DESPUÉS de protect (para que req.user esté disponible)
router.use(bancaContextMiddleware);

// 2) Resumen ejecutivo (KPI)
// GET /ventas/summary
router.get("/summary", validateVentasSummaryQuery, VentaController.summary);

// 3) Desglose por dimensión
// GET /ventas/breakdown?dimension=ventana|vendedor|loteria|sorteo|numero&top=10
router.get("/breakdown", validateVentasBreakdownQuery, VentaController.breakdown);

// 4) Serie de tiempo
// GET /ventas/timeseries?granularity=hour|day|week
router.get("/timeseries", validateVentasTimeseriesQuery, VentaController.timeseries);

// 5) Facets - Valores válidos para filtros
// GET /ventas/facets
router.get("/facets", validateFacetsQuery, VentaController.facets);

// 1) Listado transaccional (detalle)
// GET /ventas
// IMPORTANTE: Este debe ir al final para evitar conflictos con /summary, /breakdown, /timeseries, /facets
router.get("/", validateListVentasQuery, VentaController.list);

export default router;
