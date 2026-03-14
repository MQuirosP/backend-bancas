/**
 * Validators para el módulo de reportes
 */

import { z } from 'zod';

// Schema común para parámetros de fecha
export const DateTokenSchema = z.enum(['today', 'yesterday', 'week', 'month', 'year', 'range']).default('today');

// Schema base para parámetros de fecha (sin refinamientos para permitir extensiones)
export const DateRangeSchemaBase = z.object({
  date: DateTokenSchema,
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate debe ser YYYY-MM-DD').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate debe ser YYYY-MM-DD').optional(),
});

// Lógica de refinamiento para reutilizar
export const dateRangeRefine = (data: any) => {
  if (data.date === 'range') {
    return !!data.fromDate && !!data.toDate;
  }
  return true;
};

export const dateRangeRefineOptions = {
  message: 'fromDate y toDate son requeridos cuando date=range',
  path: ['fromDate'],
};

// Schema con refinamiento para uso directo
export const DateRangeSchema = DateRangeSchemaBase.refine(dateRangeRefine, dateRangeRefineOptions);

// Schema común para paginación
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
});

// Schema común para filtros de entidad
export const EntityFiltersSchema = z.object({
  ventanaId: z.string().uuid().optional(),
  vendedorId: z.string().uuid().optional(),
  loteriaId: z.string().uuid().optional(),
  sorteoId: z.string().uuid().optional(),
});

// ============================================================================
// REPORTE DE TICKETS
// ============================================================================

export const WinnersPaymentsQuerySchema = DateRangeSchemaBase.merge(PaginationSchema).merge(EntityFiltersSchema).extend({
  paymentStatus: z.enum(['all', 'paid', 'partial', 'unpaid']).default('all').optional(),
  // Nuevos filtros
  expiredOnly: z.coerce.boolean().default(false).optional(),
  minPayout: z.coerce.number().min(0).optional(),
  maxPayout: z.coerce.number().min(0).optional(),
  betType: z.enum(['NUMERO', 'REVENTADO', 'all']).default('all').optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const NumbersAnalysisQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  betType: z.enum(['NUMERO', 'REVENTADO', 'all']).default('all').optional(),
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
  // Nuevos parámetros
  includeWinners: z.coerce.boolean().default(false).optional(),
  includeExposure: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const CancelledTicketsQuerySchema = DateRangeSchemaBase.merge(PaginationSchema).merge(EntityFiltersSchema).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE LOTERÍAS
// ============================================================================

export const LoteriasPerformanceQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const SorteosAnalysisQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  loteriaId: z.string().uuid(), // Requerido
  status: z.enum(['SCHEDULED', 'OPEN', 'EVALUATED', 'CLOSED', 'all']).default('all').optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const MultipliersAnalysisQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE LISTEROS
// ============================================================================

export const VentanasRankingQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(50).default(10).optional(),
  sortBy: z.enum(['ventas', 'neto', 'margin', 'tickets']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VentanasEfficiencyQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  ventanaId: z.string().uuid(), // Requerido
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VentanasPaymentsControlQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  includeHistory: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE VENDEDORES
// ============================================================================

export const VendedoresProductivityQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'commissions', 'winRate']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VendedoresCommissionsChartQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  ventanaId: z.string().uuid(), // Requerido (sin valor por defecto)
  ticketStatus: z.string().optional(), // Ej: "ACTIVE,EVALUATED,RESTORED"
  excludeTicketStatus: z.string().optional(), // Ej: "CANCELLED"
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VendedoresSalesBehaviorQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// NUEVOS ENDPOINTS DE REPORTES
// ============================================================================

// Endpoint de Exposición y Riesgo (CRÍTICO)
export const ExposureQuerySchema = EntityFiltersSchema.extend({
  sorteoId: z.string().uuid(), // REQUERIDO
  loteriaId: z.string().uuid().optional(),
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  minExposure: z.coerce.number().min(0).optional(),
}).strict();

// Endpoint de Rentabilidad
export const ProfitabilityQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  includeComparison: z.coerce.boolean().default(false).optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// Endpoint de Análisis por Horarios
export const TimeAnalysisQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  metric: z.enum(['ventas', 'tickets', 'cancelaciones']).default('ventas').optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// Endpoint de Ranking de Vendedores
export const VendedoresRankingQuerySchema = DateRangeSchemaBase.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'comisiones', 'margen']).default('ventas').optional(),
  includeInactive: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// Endpoint de Ganadores por Sorteo
export const WinnersListQuerySchema = z.object({
  vendedorId: z.string().uuid().optional(),
}).strict();

export const WinnersListParamsSchema = z.object({
  sorteoId: z.string().uuid('sorteoId inválido (UUID)'),
}).strict();

// Endpoint de Detalle de Análisis de Números (Drill-down)
export const NumbersAnalysisDetailQuerySchema = DateRangeSchemaBase.extend({
  number: z.string().min(1, 'Número es requerido'),
  loteriaId: z.string().uuid('loteriaId inválido (UUID)'),
  betType: z.enum(['NUMERO', 'REVENTADO', 'all']).default('all').optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();
