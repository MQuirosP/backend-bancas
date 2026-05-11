/**
 * Rutas para el módulo de reportes
 */

import { Router } from 'express';
import { protect } from '../../../middlewares/auth.middleware';
import { bancaContextMiddleware } from '../../../middlewares/bancaContext.middleware';
import { requireAdmin, requireAdminOrBanca, requireAdminBancaOrVentana } from '../../../middlewares/roleGuards.middleware';
import { ReportsController } from '../controllers/reports.controller';
import { validateQuery, validateParams } from '../../../middlewares/validate.middleware';
import {
  WinnersPaymentsQuerySchema,
  NumbersAnalysisQuerySchema,
  CancelledTicketsQuerySchema,
  LoteriasPerformanceQuerySchema,
  VentanasRankingQuerySchema,
  VendedoresCommissionsChartQuerySchema,
  ExposureQuerySchema,
  ProfitabilityQuerySchema,
  TimeAnalysisQuerySchema,
  VendedoresRankingQuerySchema,
  WinnersListQuerySchema,
  WinnersListParamsSchema,
  NumbersAnalysisDetailQuerySchema,
} from '../validators/reports.validator';

const router = Router();

// Middleware de autenticación PRIMERO
router.use(protect);
router.use(bancaContextMiddleware);

// Reportes de Tickets
router.get(
  '/tickets/winners-payments',
  requireAdminOrBanca,
  validateQuery(WinnersPaymentsQuerySchema),
  ReportsController.getWinnersPayments
);

router.get(
  '/tickets/numbers-analysis',
  requireAdminBancaOrVentana,
  validateQuery(NumbersAnalysisQuerySchema),
  ReportsController.getNumbersAnalysis
);

router.get(
  '/tickets/numbers-analysis/detail',
  requireAdminOrBanca,
  validateQuery(NumbersAnalysisDetailQuerySchema),
  ReportsController.getNumbersAnalysisDetail
);

router.get(
  '/tickets/cancelled',
  requireAdminOrBanca,
  validateQuery(CancelledTicketsQuerySchema),
  ReportsController.getCancelledTickets
);

// Reportes de Loterías
router.get(
  '/loterias/performance',
  requireAdminOrBanca,
  validateQuery(LoteriasPerformanceQuerySchema),
  ReportsController.getLoteriasPerformance
);

// Reportes de Listeros
router.get(
  '/ventanas/ranking',
  requireAdminOrBanca,
  validateQuery(VentanasRankingQuerySchema),
  ReportsController.getVentanasRanking
);

// Reportes de Vendedores
router.get(
  '/vendedores/commissions-chart',
  requireAdminOrBanca,
  validateQuery(VendedoresCommissionsChartQuerySchema),
  ReportsController.getVendedoresCommissionsChart
);

router.get(
  '/vendedores/ranking',
  requireAdminOrBanca,
  validateQuery(VendedoresRankingQuerySchema),
  ReportsController.getVendedoresRanking
);

// Nuevos Endpoints de Tickets
router.get(
  '/tickets/exposure',
  requireAdminOrBanca,
  validateQuery(ExposureQuerySchema),
  ReportsController.getExposure
);

router.get(
  '/tickets/profitability',
  requireAdminOrBanca,
  validateQuery(ProfitabilityQuerySchema),
  ReportsController.getProfitability
);

router.get(
  '/tickets/time-analysis',
  requireAdminOrBanca,
  validateQuery(TimeAnalysisQuerySchema),
  ReportsController.getTimeAnalysis
);

// Nuevo endpoint para lista de ganadores (Reporte optimizado)
router.get(
  '/winners-list/:sorteoId',
  validateParams(WinnersListParamsSchema),
  validateQuery(WinnersListQuerySchema),
  ReportsController.getWinnersList
);

export default router;

