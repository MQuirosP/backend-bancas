/**
 * Validators para el módulo de reportes
 */

import { z } from 'zod';

// Schema común para parámetros de fecha
export const DateTokenSchema = z.enum(['today', 'yesterday', 'week', 'month', 'year', 'range']).default('today');

export const DateRangeSchema = z.object({
  date: DateTokenSchema,
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate debe ser YYYY-MM-DD').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate debe ser YYYY-MM-DD').optional(),
}).refine((data) => {
  if (data.date === 'range') {
    return !!data.fromDate && !!data.toDate;
  }
  return true;
}, {
  message: 'fromDate y toDate son requeridos cuando date=range',
  path: ['fromDate'],
});

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

export const WinnersPaymentsQuerySchema = DateRangeSchema.merge(PaginationSchema).merge(EntityFiltersSchema).extend({
  paymentStatus: z.enum(['all', 'paid', 'partial', 'unpaid']).default('all').optional(),
  // Nuevos filtros
  expiredOnly: z.coerce.boolean().default(false).optional(),
  minPayout: z.coerce.number().min(0).optional(),
  maxPayout: z.coerce.number().min(0).optional(),
  betType: z.enum(['NUMERO', 'REVENTADO', 'all']).default('all').optional(),
}).strict();

export const NumbersAnalysisQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  betType: z.enum(['NUMERO', 'REVENTADO', 'all']).default('all').optional(),
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
  // Nuevos parámetros
  includeWinners: z.coerce.boolean().default(false).optional(),
  includeExposure: z.coerce.boolean().default(false).optional(),
}).strict();

export const CancelledTicketsQuerySchema = DateRangeSchema.merge(PaginationSchema).merge(EntityFiltersSchema).strict();

// ============================================================================
// REPORTE DE LOTERÍAS
// ============================================================================

export const LoteriasPerformanceQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  includeComparison: z.coerce.boolean().default(false).optional(),
}).strict();

export const SorteosAnalysisQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  loteriaId: z.string().uuid(), // Requerido
  status: z.enum(['SCHEDULED', 'OPEN', 'EVALUATED', 'CLOSED', 'all']).default('all').optional(),
}).strict();

export const MultipliersAnalysisQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).strict();

// ============================================================================
// REPORTE DE LISTEROS
// ============================================================================

export const VentanasRankingQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(50).default(10).optional(),
  sortBy: z.enum(['ventas', 'neto', 'margin', 'tickets']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).strict();

export const VentanasEfficiencyQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  ventanaId: z.string().uuid(), // Requerido
}).strict();

export const VentanasPaymentsControlQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  includeHistory: z.coerce.boolean().default(false).optional(),
}).strict();

// ============================================================================
// REPORTE DE VENDEDORES
// ============================================================================

export const VendedoresProductivityQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'commissions', 'winRate']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).strict();

export const VendedoresCommissionsChartQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  ventanaId: z.string().uuid(), // Requerido (sin valor por defecto)
  ticketStatus: z.string().optional(), // Ej: "ACTIVE,EVALUATED,RESTORED"
  excludeTicketStatus: z.string().optional(), // Ej: "CANCELLED"
}).strict();

export const VendedoresSalesBehaviorQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).strict();

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
export const ProfitabilityQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  includeComparison: z.coerce.boolean().default(false).optional(),
  groupBy: z.enum(['day', 'week', 'month']).optional(),
}).strict();

// Endpoint de Análisis por Horarios
export const TimeAnalysisQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  metric: z.enum(['ventas', 'tickets', 'cancelaciones']).default('ventas').optional(),
}).strict();

// Endpoint de Ranking de Vendedores
export const VendedoresRankingQuerySchema = DateRangeSchema.merge(EntityFiltersSchema).extend({
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'comisiones', 'margen']).default('ventas').optional(),
  includeInactive: z.coerce.boolean().default(false).optional(),
}).strict();

// Endpoint de Ganadores por Sorteo
export const WinnersListQuerySchema = z.object({
  vendedorId: z.string().uuid().optional(),
}).strict();

export const WinnersListParamsSchema = z.object({
  sorteoId: z.string().uuid('sorteoId inválido (UUID)'),
}).strict();

