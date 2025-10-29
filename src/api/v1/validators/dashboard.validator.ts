// src/api/v1/validators/dashboard.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

/**
 * Schema para Dashboard principal y subrutas
 * Fecha: date (today|yesterday|week|month|year|range) + fromDate/toDate (YYYY-MM-DD) cuando date=range
 */
export const DashboardQuerySchema = z
  .object({
    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope (ventana específica)
    ventanaId: z.string().uuid().optional(),
    scope: z.enum(["mine", "all"]).optional(),

    // Filtros adicionales
    loteriaId: z.string().uuid().optional(),
    betType: z.enum(["NUMERO", "REVENTADO"]).optional(),

    // Time series
    interval: z.enum(["day", "hour"]).optional(),
    granularity: z.enum(["day", "hour"]).optional(), // Alias para interval (frontend compatibility)

    // Exposure
    top: z.string().regex(/^\d+$/).transform(Number).optional(),

    // Vendedores
    dimension: z.enum(["ventana", "loteria", "vendedor"]).optional(),
    orderBy: z.enum(["sales", "commissions", "tickets", "winners", "avgTicket"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    pageSize: z.string().regex(/^\d+$/).transform(Number).optional(),

    // CxC
    aging: z.enum(["true", "false"]).transform(v => v === "true").optional(),

    // Export
    format: z.enum(["csv", "xlsx", "pdf"]).optional(),

    // Comparación
    compare: z.enum(["true", "false"]).transform(v => v === "true").optional(),

    // Cache
    refresh: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  })
  .strict();

// Middleware de validación
export const validateDashboardQuery = validateQuery(DashboardQuerySchema);
