/**
 * Rutas para el módulo de reportes
 */

import { Router } from 'express';
import { protect } from '../../../middlewares/auth.middleware';
import { requireAdmin } from '../../../middlewares/roleGuards.middleware';
import { ReportsController } from '../controllers/reports.controller';
import { validateQuery } from '../../../middlewares/validate.middleware';
import {
  WinnersPaymentsQuerySchema,
  NumbersAnalysisQuerySchema,
  CancelledTicketsQuerySchema,
  LoteriasPerformanceQuerySchema,
  VentanasRankingQuerySchema,
  VendedoresCommissionsChartQuerySchema,
} from '../validators/reports.validator';

const router = Router();

// Middleware de autenticación PRIMERO
router.use(protect);

// Reportes de Tickets
router.get(
  '/tickets/winners-payments',
  requireAdmin,
  validateQuery(WinnersPaymentsQuerySchema),
  ReportsController.getWinnersPayments
);

router.get(
  '/tickets/numbers-analysis',
  requireAdmin,
  validateQuery(NumbersAnalysisQuerySchema),
  ReportsController.getNumbersAnalysis
);

router.get(
  '/tickets/cancelled',
  requireAdmin,
  validateQuery(CancelledTicketsQuerySchema),
  ReportsController.getCancelledTickets
);

// Reportes de Loterías
router.get(
  '/loterias/performance',
  requireAdmin,
  validateQuery(LoteriasPerformanceQuerySchema),
  ReportsController.getLoteriasPerformance
);

// Reportes de Listeros
router.get(
  '/ventanas/ranking',
  requireAdmin,
  validateQuery(VentanasRankingQuerySchema),
  ReportsController.getVentanasRanking
);

// Reportes de Vendedores
router.get(
  '/vendedores/commissions-chart',
  requireAdmin,
  validateQuery(VendedoresCommissionsChartQuerySchema),
  ReportsController.getVendedoresCommissionsChart
);

export default router;

