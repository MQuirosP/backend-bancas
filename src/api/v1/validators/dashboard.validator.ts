import { TimeGranularity } from '../../../types/enums/timeGranularity.enum';
import { SortOrder } from '../../../types/enums/sortOrder.enum';
import { DateFilterOption } from '../../../types/enums/dateFilter.enum';
// src/api/v1/validators/dashboard.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";
import { ReportDimension, QueryScope } from "../../../types/enums/report.enum";
import { ExportFormat } from "../../../types/enums/export.enum";
import { BetType } from "../../../generated/prisma/client";

// Helper para validar UUIDs opcionales que pueden venir como "all", vacío o null desde el frontend
const OptionalUUIDOrAll = z.preprocess((val) => {
  if (val === 'all' || val === '' || val === null) {
    return undefined;
  }
  return val;
}, z.uuid().optional());

/**
 * Schema para Dashboard principal y subrutas
 * Fecha: date (today|yesterday|week|month|year|range) + fromDate/toDate (YYYY-MM-DD) cuando date=range
 */
export const DashboardQuerySchema = z
  .object({
    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    date: z.enum(DateFilterOption).optional().default(DateFilterOption.TODAY),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope (ventana específica)
    ventanaId: OptionalUUIDOrAll,
    scope: z.enum(QueryScope).optional(),

    // Filtros adicionales
    loteriaId: OptionalUUIDOrAll,
    betType: z.enum(BetType).optional(),

    // Time series
    interval: z.enum(TimeGranularity).optional(),
    granularity: z.enum(TimeGranularity).optional(), // Alias para interval (frontend compatibility)

    // Exposure
    top: z.string().regex(/^\d+$/).transform(Number).optional(),

    // Vendedores
    dimension: z.enum(ReportDimension).optional(),
    orderBy: z.enum(["sales", "commissions", "tickets", "winners", "avgTicket"]).optional(),
    order: z.enum(SortOrder).optional(),
    page: z.string().regex(/^\d+$/).transform(Number).optional(),
    pageSize: z.string().regex(/^\d+$/).transform(Number).optional(),

    // CxC
    aging: z.coerce.boolean().optional(),

    // Export
    format: z.enum(ExportFormat).optional(),
    sections: z.string().optional(), // Secciones a incluir en export (kpis,ventanas,loterias,vendedores)

    // Comparación
    compare: z.coerce.boolean().optional(),

    // Cache
    refresh: z.coerce.boolean().optional(),

    // Para evitar caché del navegador (ignorado)
    _: z.string().optional(),
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

// Middleware de validación
export const validateDashboardQuery = validateQuery(DashboardQuerySchema);

/**
 * Schema para saldos acumulados en lote
 */
export const AccumulatedBalancesSchema = z.object({
  dimension: z.enum(ReportDimension),
  entityIds: z.array(z.string()), // Relajamos de uuid() a string() para diagnosticar
});

export const validateAccumulatedBalances = (req: any, res: any, next: any) => {
  try {
    console.log("Validating accumulated-balances body:", JSON.stringify(req.body));
    AccumulatedBalancesSchema.parse(req.body);
    next();
  } catch (error: any) {
    console.error("Validation error for accumulated-balances:", error.errors);
    console.error("Request body was:", req.body);
    res.status(400).json({
      error: "Validation failed",
      details: error.errors,
      received: req.body
    });
  }
};
