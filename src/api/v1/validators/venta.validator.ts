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

// Middlewares de validación
export const validateListVentasQuery = validateQuery(ListVentasQuerySchema);
export const validateVentasSummaryQuery = validateQuery(VentasSummaryQuerySchema);
export const validateVentasBreakdownQuery = validateQuery(VentasBreakdownQuerySchema);
export const validateVentasTimeseriesQuery = validateQuery(VentasTimeseriesQuerySchema);
