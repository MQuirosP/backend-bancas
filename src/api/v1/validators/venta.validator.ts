// src/api/v1/validators/venta.validator.ts
import { z } from "zod";
import { validateQuery } from "../../../middlewares/validate.middleware";

/**
 * Schema para listar ventas (detalle transaccional)
 * Reutiliza la misma semántica que tickets: scope, date, from, to
 */
export const ListVentasQuerySchema = z
  .object({
    // Paginación
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),

    // Filtros de scope y fecha (semántica igual que tickets)
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),

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
  })
  .strict();

/**
 * Schema para resumen ejecutivo (KPI)
 * Mismo filtrado pero sin paginación
 */
export const VentasSummaryQuerySchema = z
  .object({
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
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

    // Filtros estándar
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
  })
  .strict();

/**
 * Schema para serie de tiempo (timeseries)
 */
export const VentasTimeseriesQuerySchema = z
  .object({
    granularity: z.enum(["hour", "day", "week"]).optional().default("day"),
    dimension: z.enum(["ventana", "vendedor", "loteria", "sorteo"]).optional(),

    // Filtros estándar
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Validar rango de fechas según granularidad
    if (val.date === "range" && val.from && val.to) {
      const fromDate = new Date(val.from);
      const toDate = new Date(val.to);
      const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));

      if (val.granularity === "hour" && diffDays > 30) {
        ctx.addIssue({
          code: "custom",
          path: ["granularity"],
          message: "Para granularidad 'hour', el rango máximo es 30 días",
        });
      }

      if (val.granularity === "day" && diffDays > 90) {
        ctx.addIssue({
          code: "custom",
          path: ["granularity"],
          message: "Para granularidad 'day', el rango máximo es 90 días",
        });
      }
    }
  });

/**
 * Schema para exportación async
 */
export const ExportVentasBodySchema = z
  .object({
    format: z.enum(["csv", "xlsx", "json"]).default("csv"),
    filters: z.object({
      scope: z.enum(["mine", "all"]).optional(),
      date: z.enum(["today", "yesterday", "range"]).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
      winnersOnly: z.coerce.boolean().optional(),
      ventanaId: z.uuid().optional(),
      vendedorId: z.uuid().optional(),
      loteriaId: z.uuid().optional(),
      sorteoId: z.uuid().optional(),
    }),
  })
  .strict();

/**
 * Schema para crear/actualizar reporte guardado
 */
export const CreateSavedReportSchema = z
  .object({
    name: z.string().min(1).max(100),
    filters: z.record(z.string(), z.any()), // JSON dinámico
    schedule: z
      .object({
        frequency: z.enum(["daily", "weekly", "monthly"]),
        recipients: z.array(z.string().email()).min(1),
      })
      .optional(),
  })
  .strict();

export const UpdateSavedReportSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    filters: z.record(z.string(), z.any()).optional(),
    schedule: z
      .object({
        frequency: z.enum(["daily", "weekly", "monthly"]),
        recipients: z.array(z.string().email()).min(1),
      })
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * Schema para crear alerta
 */
export const CreateAlertSchema = z
  .object({
    name: z.string().min(1).max(100),
    dimension: z.enum(["ventana", "vendedor", "loteria", "sorteo"]),
    targetId: z.uuid().optional(),
    condition: z.object({
      type: z.enum(["threshold", "spike", "drop"]),
      operator: z.enum(["gt", "lt", "gte", "lte", "eq"]),
      value: z.number(),
    }),
    notifyEmail: z.string().email().optional(),
    notifyWebhook: z.string().url().optional(),
  })
  .strict();

export const UpdateAlertSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    condition: z
      .object({
        type: z.enum(["threshold", "spike", "drop"]),
        operator: z.enum(["gt", "lt", "gte", "lte", "eq"]),
        value: z.number(),
      })
      .optional(),
    notifyEmail: z.string().email().optional(),
    notifyWebhook: z.string().url().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/**
 * Schema para facets
 */
export const FacetsQuerySchema = z
  .object({
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

/**
 * Schema para reconciliación
 */
export const ReconciliationQuerySchema = z
  .object({
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    scope: z.enum(["mine", "all"]).optional().default("mine"),
  })
  .strict();

/**
 * Schema para anomalías
 */
export const AnomaliesQuerySchema = z
  .object({
    dimension: z.enum(["ventana", "vendedor", "loteria", "sorteo"]),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    threshold: z.coerce.number().min(1).max(5).optional().default(2), // Z-score threshold
  })
  .strict();

/**
 * Schema para timeseries comparativas
 */
export const VentasTimeseriesCompareQuerySchema = z
  .object({
    granularity: z.enum(["hour", "day", "week"]).optional().default("day"),
    dimension: z.enum(["ventana", "vendedor", "loteria", "sorteo"]).optional(),
    compare: z.enum(["prev_period", "prev_year"]).optional(),

    // Filtros estándar
    scope: z.enum(["mine", "all"]).optional().default("mine"),
    date: z.enum(["today", "yesterday", "range"]).optional().default("today"),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),

    status: z.enum(["ACTIVE", "EVALUATED", "CANCELLED", "RESTORED"]).optional(),
    winnersOnly: z.coerce.boolean().optional(),
    bancaId: z.uuid().optional(),
    ventanaId: z.uuid().optional(),
    vendedorId: z.uuid().optional(),
    loteriaId: z.uuid().optional(),
    sorteoId: z.uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Validar rango de fechas según granularidad
    if (val.date === "range" && val.from && val.to) {
      const fromDate = new Date(val.from);
      const toDate = new Date(val.to);
      const diffDays = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));

      if (val.granularity === "hour" && diffDays > 30) {
        ctx.addIssue({
          code: "custom",
          path: ["granularity"],
          message: "Para granularidad 'hour', el rango máximo es 30 días",
        });
      }

      if (val.granularity === "day" && diffDays > 90) {
        ctx.addIssue({
          code: "custom",
          path: ["granularity"],
          message: "Para granularidad 'day', el rango máximo es 90 días",
        });
      }
    }
  });

/**
 * Schema para crear goal
 */
export const CreateGoalSchema = z
  .object({
    name: z.string().min(1).max(100),
    dimension: z.enum(["ventana", "vendedor", "global"]),
    targetId: z.uuid().optional(),
    targetValue: z.number().positive(),
    period: z.enum(["day", "week", "month", "year"]),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  })
  .strict();

// Middlewares de validación
export const validateListVentasQuery = validateQuery(ListVentasQuerySchema);
export const validateVentasSummaryQuery = validateQuery(VentasSummaryQuerySchema);
export const validateVentasBreakdownQuery = validateQuery(VentasBreakdownQuerySchema);
export const validateVentasTimeseriesQuery = validateQuery(VentasTimeseriesQuerySchema);
export const validateVentasTimeseriesCompareQuery = validateQuery(VentasTimeseriesCompareQuerySchema);
export const validateFacetsQuery = validateQuery(FacetsQuerySchema);
export const validateReconciliationQuery = validateQuery(ReconciliationQuerySchema);
export const validateAnomaliesQuery = validateQuery(AnomaliesQuerySchema);
