import { TimeGranularity } from '../../../types/enums/timeGranularity.enum';
import { SortOrder } from '../../../types/enums/sortOrder.enum';
import { DateFilterOption } from '../../../types/enums/dateFilter.enum';
// src/api/v1/validators/venta.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";
import { ReportDimension, QueryScope } from "../../../types/enums/report.enum";
import { TicketStatus } from "../../../generated/prisma/client";

// Helper para validar UUIDs opcionales que pueden venir como "all", vacío o null desde el frontend
const OptionalUUIDOrAll = z.preprocess((val) => {
  if (val === 'all' || val === '' || val === null) {
    return undefined;
  }
  return val;
}, z.uuid().optional());

/**
 * Schema para listar ventas (detalle transaccional)
 * Fechas: date (today|yesterday|week|month|year|range) + fromDate/toDate (YYYY-MM-DD) cuando date=range
 */
export const ListVentasQuerySchema = z
  .object({
    // Paginación
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),

    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(QueryScope).optional(),

    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Filtros adicionales
    status: z.enum(TicketStatus).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: OptionalUUIDOrAll,
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,
    sorteoId: OptionalUUIDOrAll,
    multiplierId: OptionalUUIDOrAll,
    search: z.string().trim().min(1).max(100).optional(),
    orderBy: z.string().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para resumen ejecutivo (KPI)
 * Mismo filtrado pero sin paginación
 */
export const VentasSummaryQuerySchema = z
  .object({
    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(QueryScope).optional(),

    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(TicketStatus).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: OptionalUUIDOrAll,
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,
    sorteoId: OptionalUUIDOrAll,
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para breakdown por dimensión
 */
export const VentasBreakdownQuerySchema = z
  .object({
    // Dimension es requerida
    dimension: z.enum(ReportDimension),
    top: z.coerce.number().int().min(1).max(100).optional().default(10),

    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(QueryScope).optional(),

    // Filtros estándar
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(TicketStatus).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: OptionalUUIDOrAll,
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,
    sorteoId: OptionalUUIDOrAll,
    search: z.string().trim().min(1).max(100).optional(),
    orderBy: z.string().optional(),
    order: z.enum(SortOrder).optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para serie de tiempo (timeseries)
 */
export const VentasTimeseriesQuerySchema = z
  .object({
    granularity: z.enum(TimeGranularity).optional().default(TimeGranularity.DAY),

    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(QueryScope).optional(),

    // Filtros estándar
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(TicketStatus).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: OptionalUUIDOrAll,
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,
    sorteoId: OptionalUUIDOrAll,
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para facets
 */
export const FacetsQuerySchema = z
  .object({
    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(QueryScope).optional(),

    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

// Middlewares de validación
export const validateListVentasQuery = validateQuery(ListVentasQuerySchema);
export const validateVentasSummaryQuery = validateQuery(VentasSummaryQuerySchema);
export const validateVentasBreakdownQuery = validateQuery(VentasBreakdownQuerySchema);
export const validateVentasTimeseriesQuery = validateQuery(VentasTimeseriesQuerySchema);
export const validateFacetsQuery = validateQuery(FacetsQuerySchema);
