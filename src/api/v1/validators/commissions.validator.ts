import { DateFilterOption } from '../../../types/enums/dateFilter.enum';
// src/api/v1/validators/commissions.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";
import { ReportDimension, QueryScope } from "../../../types/enums/report.enum";
import { ExportFormat } from "../../../types/enums/export.enum";

// Helper para validar UUIDs opcionales que pueden venir como "all", vacío o null desde el frontend
const OptionalUUIDOrAll = z.preprocess((val) => {
  if (val === 'all' || val === '' || val === null) {
    return undefined;
  }
  return val;
}, z.uuid().optional());

/**
 * Schema para GET /api/v1/commissions
 * Lista de comisiones por periodo
 */
export const CommissionsListQuerySchema = z
  .object({
    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope y dimension
    scope: z.enum(QueryScope),
    dimension: z.enum(ReportDimension),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .superRefine((val, ctx) => {
    //  CRÍTICO: Validar que date=range cuando hay fromDate/toDate
    if ((val.fromDate || val.toDate) && val.date !== 'range') {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "date debe ser 'range' cuando se proporcionan fromDate o toDate",
      });
    }

    // Si date=range, fromDate y toDate son requeridos
    if (val.date === DateFilterOption.RANGE) {
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

      //  Validar fromDate ≤ toDate
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
    scope: z.enum(QueryScope),
    dimension: z.enum(ReportDimension),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
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
    loteriaId: z.uuid(),
    multiplierId: z.union([z.uuid(), z.literal("unknown")]),

    // Scope y dimension
    scope: z.enum(QueryScope),
    dimension: z.enum(ReportDimension),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,

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
    format: z.enum(ExportFormat),

    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope y dimension
    scope: z.enum(QueryScope),
    dimension: z.enum(ReportDimension),

    // Filtros opcionales (solo para ADMIN)
    ventanaId: OptionalUUIDOrAll,
    vendedorId: OptionalUUIDOrAll,
    loteriaId: OptionalUUIDOrAll,

    // Opciones de exportación
    includeBreakdown: z.coerce.boolean().optional().default(true),
    includeWarnings: z.coerce.boolean().optional().default(true),

    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .superRefine((val, ctx) => {
    //  CRÍTICO: Validar que date=range cuando hay fromDate/toDate
    if ((val.fromDate || val.toDate) && val.date !== 'range') {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "date debe ser 'range' cuando se proporcionan fromDate o toDate",
      });
    }

    // Si date=range, fromDate y toDate son requeridos
    if (val.date === DateFilterOption.RANGE) {
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

      //  Validar fromDate ≤ toDate
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

/**
 * Schema para GET /api/v1/commissions/:date/breakdown
 */
export const CommissionsBreakdownParamsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const CommissionsBreakdownQuerySchema = z.object({
  scope: z.enum(QueryScope),
  dimension: z.enum(ReportDimension),
  ventanaId: OptionalUUIDOrAll,
  vendedorId: OptionalUUIDOrAll,
  _: z.string().optional(),
}).strict();

import { validateParams } from "../../../middlewares/validate.middleware";

export const validateCommissionsBreakdown = [
  validateParams(CommissionsBreakdownParamsSchema),
  validateQuery(CommissionsBreakdownQuerySchema),
];

