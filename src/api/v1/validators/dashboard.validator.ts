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
  })
  .strict();

// Middleware de validación
export const validateDashboardQuery = validateQuery(DashboardQuerySchema);
