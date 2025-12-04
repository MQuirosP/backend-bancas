// src/api/v1/validators/commissions.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

/**
 * Schema para GET /api/v1/commissions
 * Lista de comisiones por periodo
 */
export const CommissionsListQuerySchema = z
  .object({
    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope y dimension
    scope: z.enum(["mine", "all"]),
    dimension: z.enum(["ventana", "vendedor"]),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .refine(
    (data) => {
      // Si date=range, fromDate y toDate son requeridos
      if (data.date === "range") {
        return !!data.fromDate && !!data.toDate;
      }
      return true;
    },
    {
      message: "fromDate and toDate are required when date=range",
      path: ["date"],
    }
  );

/**
 * Schema para GET /api/v1/commissions/detail
 * Detalle de comisiones por lotería
 */
export const CommissionsDetailQuerySchema = z
  .object({
    // Fecha específica (YYYY-MM-DD)
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

    // Scope y dimension
    scope: z.enum(["mine", "all"]),
    dimension: z.enum(["ventana", "vendedor"]),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para GET /api/v1/commissions/tickets
 * Tickets con comisiones (con paginación)
 */
export const CommissionsTicketsQuerySchema = z
  .object({
    // Fecha específica (YYYY-MM-DD)
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

    // Filtros requeridos
    loteriaId: z.string().uuid(),
    multiplierId: z.union([z.string().uuid(), z.literal("unknown")]),

    // Scope y dimension
    scope: z.enum(["mine", "all"]),
    dimension: z.enum(["ventana", "vendedor"]),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),

    // Paginación
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para GET /api/v1/commissions/export
 * Exportación de comisiones en CSV, Excel o PDF
 */
export const CommissionsExportQuerySchema = z
  .object({
    // Formato de exportación (obligatorio)
    format: z.enum(["csv", "excel", "pdf"]),

    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional().default("today"),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope y dimension
    scope: z.enum(["mine", "all"]),
    dimension: z.enum(["ventana", "vendedor"]),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),

    // Opciones de exportación
    includeBreakdown: z.coerce.boolean().optional().default(true),
    includeWarnings: z.coerce.boolean().optional().default(true),

    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .refine(
    (data) => {
      // Si date=range, fromDate y toDate son requeridos
      if (data.date === "range") {
        return !!data.fromDate && !!data.toDate;
      }
      return true;
    },
    {
      message: "fromDate and toDate are required when date=range",
      path: ["date"],
    }
  );

// Middlewares de validación
export const validateCommissionsListQuery = validateQuery(CommissionsListQuerySchema);
export const validateCommissionsDetailQuery = validateQuery(CommissionsDetailQuerySchema);
export const validateCommissionsTicketsQuery = validateQuery(CommissionsTicketsQuerySchema);
export const validateCommissionsExportQuery = validateQuery(CommissionsExportQuerySchema);

