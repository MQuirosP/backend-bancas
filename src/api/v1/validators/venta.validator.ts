// src/api/v1/validators/venta.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

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
    scope: z.enum(["mine", "all"]).optional(),

    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Filtros adicionales
    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
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
    scope: z.enum(["mine", "all"]).optional(),

    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para breakdown por dimensión
 */
export const VentasBreakdownQuerySchema = z
  .object({
    // Dimension es requerida
    dimension: z.enum(["ventana", "vendedor", "loteria", "sorteo", "numero"]),
    top: z.coerce.number().int().min(1).max(50).optional().default(10),

    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(["mine", "all"]).optional(),

    // Filtros estándar
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para serie de tiempo (timeseries)
 */
export const VentasTimeseriesQuerySchema = z
  .object({
    granularity: z.enum(["hour", "day", "week"]).optional().default("day"),

    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(["mine", "all"]).optional(),

    // Filtros estándar
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para facets
 */
export const FacetsQuerySchema = z
  .object({
    // Scope (aceptado pero ignorado; RBAC lo maneja automáticamente)
    scope: z.enum(["mine", "all"]).optional(),

    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
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
