import { TimeGranularity } from '../../../types/enums/timeGranularity.enum';
import { DateFilterOption } from '../../../types/enums/dateFilter.enum';
import { z } from 'zod';
import { BetTypeFilter, QueryScope, SorteoStatusFilter } from '../../../types/enums/report.enum';

// Schema común para parámetros de fecha
export const DateTokenSchema = z.enum(DateFilterOption).default(DateFilterOption.TODAY);

export const DateRangeSchemaBase = z.object({
  date: DateTokenSchema,
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate debe ser YYYY-MM-DD').optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate debe ser YYYY-MM-DD').optional(),
});

export const dateRangeRefine = (data: any) => {
  if (data.date === DateFilterOption.RANGE) {
    return !!data.fromDate && !!data.toDate;
  }
  return true;
};

export const dateRangeRefineOptions = {
  message: 'fromDate y toDate son requeridos cuando date=range',
  path: ['fromDate'],
};

export const DateRangeSchema = DateRangeSchemaBase.refine(dateRangeRefine, dateRangeRefineOptions);

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20).optional(),
});

const OptionalUUIDOrAll = z.preprocess((val) => {
  if (val === 'all' || val === '' || val === null) {
    return undefined;
  }
  return val;
}, z.uuid().optional());

export const EntityFiltersSchema = z.object({
  ventanaId: OptionalUUIDOrAll,
  vendedorId: OptionalUUIDOrAll,
  loteriaId: OptionalUUIDOrAll,
  sorteoId: OptionalUUIDOrAll,
});

// ============================================================================
// REPORTE DE TICKETS
// ============================================================================

export const WinnersPaymentsQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...PaginationSchema.shape,
  ...EntityFiltersSchema.shape,
  paymentStatus: z.enum(['all', 'paid', 'partial', 'unpaid']).default('all').optional(),
  expiredOnly: z.coerce.boolean().default(false).optional(),
  minPayout: z.coerce.number().min(0).optional(),
  maxPayout: z.coerce.number().min(0).optional(),
  betType: z.enum(BetTypeFilter).default(BetTypeFilter.ALL).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const NumbersAnalysisQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  betType: z.enum(BetTypeFilter).default(BetTypeFilter.ALL).optional(),
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
  includeWinners: z.coerce.boolean().default(false).optional(),
  includeExposure: z.coerce.boolean().default(false).optional(),
  scope: z.enum(QueryScope).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const CancelledTicketsQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...PaginationSchema.shape,
  ...EntityFiltersSchema.shape,
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE LOTERÍAS
// ============================================================================

export const LoteriasPerformanceQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const SorteosAnalysisQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  loteriaId: z.uuid(),
  status: z.enum(SorteoStatusFilter).default(SorteoStatusFilter.ALL).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const MultipliersAnalysisQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE LISTEROS
// ============================================================================

export const VentanasRankingQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  top: z.coerce.number().int().min(1).max(50).default(10).optional(),
  sortBy: z.enum(['ventas', 'neto', 'margin', 'tickets']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VentanasEfficiencyQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  ventanaId: z.uuid(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VentanasPaymentsControlQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  includeHistory: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// REPORTE DE VENDEDORES
// ============================================================================

export const VendedoresProductivityQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'commissions', 'winRate']).default('ventas').optional(),
  includeComparison: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VendedoresCommissionsChartQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  ventanaId: z.uuid(),
  ticketStatus: z.string().optional(),
  excludeTicketStatus: z.string().optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VendedoresSalesBehaviorQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

// ============================================================================
// NUEVOS ENDPOINTS
// ============================================================================

export const ExposureQuerySchema = EntityFiltersSchema.extend({
  sorteoId: z.uuid(),
  loteriaId: z.uuid().optional(),
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  minExposure: z.coerce.number().min(0).optional(),
}).strict();

export const ProfitabilityQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  includeComparison: z.coerce.boolean().default(false).optional(),
  groupBy: z.enum(TimeGranularity).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const TimeAnalysisQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  metric: z.enum(['ventas', 'tickets', 'cancelaciones']).default('ventas').optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const VendedoresRankingQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  top: z.coerce.number().int().min(1).max(100).default(20).optional(),
  sortBy: z.enum(['ventas', 'tickets', 'comisiones', 'margen']).default('ventas').optional(),
  includeInactive: z.coerce.boolean().default(false).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const WinnersListQuerySchema = z.object({
  vendedorId: z.uuid().optional(),
}).strict();

export const WinnersListParamsSchema = z.object({
  sorteoId: z.uuid('sorteoId inválido (UUID)'),
}).strict();

export const NumbersAnalysisDetailQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  number: z.string().min(1, 'Número es requerido'),
  loteriaId: z.uuid('loteriaId inválido (UUID)'),
  betType: z.enum(BetTypeFilter).default(BetTypeFilter.ALL).optional(),
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();

export const TicketsSummaryQuerySchema = z.object({
  ...DateRangeSchemaBase.shape,
  ...EntityFiltersSchema.shape,
  loteriaId: OptionalUUIDOrAll,
}).refine(dateRangeRefine, dateRangeRefineOptions).strict();