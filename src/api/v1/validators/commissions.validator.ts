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
  .superRefine((val, ctx) => {
    // ✅ CRÍTICO: Validar que date=range cuando hay fromDate/toDate
    if ((val.fromDate || val.toDate) && val.date !== 'range') {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "date debe ser 'range' cuando se proporcionan fromDate o toDate",
      });
    }

    // Si date=range, fromDate y toDate son requeridos
    if (val.date === "range") {
      if (!val.fromDate) {
        ctx.addIssue({
          code: "custom",
          path: ["fromDate"],
          message: "fromDate es requerido cuando date='range'",
        });
      }
      if (!val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "toDate es requerido cuando date='range'",
        });
      }
      
      // ✅ Validar fromDate ≤ toDate
      if (val.fromDate && val.toDate && val.fromDate > val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "toDate debe ser mayor o igual a fromDate",
        });
      }
    }
  });

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
  .superRefine((val, ctx) => {
    // ✅ CRÍTICO: Validar que date=range cuando hay fromDate/toDate
    if ((val.fromDate || val.toDate) && val.date !== 'range') {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "date debe ser 'range' cuando se proporcionan fromDate o toDate",
      });
    }

    // Si date=range, fromDate y toDate son requeridos
    if (val.date === "range") {
      if (!val.fromDate) {
        ctx.addIssue({
          code: "custom",
          path: ["fromDate"],
          message: "fromDate es requerido cuando date='range'",
        });
      }
      if (!val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "toDate es requerido cuando date='range'",
        });
      }
      
      // ✅ Validar fromDate ≤ toDate
      if (val.fromDate && val.toDate && val.fromDate > val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "toDate debe ser mayor o igual a fromDate",
        });
      }
    }
  });

// Middlewares de validación
export const validateCommissionsListQuery = validateQuery(CommissionsListQuerySchema);
export const validateCommissionsDetailQuery = validateQuery(CommissionsDetailQuerySchema);
export const validateCommissionsTicketsQuery = validateQuery(CommissionsTicketsQuerySchema);
export const validateCommissionsExportQuery = validateQuery(CommissionsExportQuerySchema);

