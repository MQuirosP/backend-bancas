// src/api/v1/validators/accounts.validator.ts
import { z } from "zod";
import { validateQuery, validateBody } from "../../../middlewares/validate.middleware";

/**
 * Schema para query parameters de GET /accounts/statement
 */
export const GetStatementQuerySchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser en formato YYYY-MM").optional(), // ✅ Opcional si se usa date
    // ✅ NUEVO: Filtros de período
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fromDate debe ser YYYY-MM-DD").optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "toDate debe ser YYYY-MM-DD").optional(),
    scope: z.enum(["mine", "ventana", "all"]),
    dimension: z.enum(["banca", "ventana", "vendedor"]), // ✅ NUEVO: Agregado 'banca'
    bancaId: z.string().uuid().optional(), // ✅ NUEVO: Filtro opcional por banca
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    sort: z.enum(["asc", "desc"]).optional().default("desc"),
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

    // Si date es 'range', fromDate y toDate son requeridos
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
      if (val.fromDate && val.toDate && val.fromDate > val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "toDate debe ser mayor o igual a fromDate",
        });
      }
    }
    // Si no se proporciona date ni month, usar mes actual por defecto
    // (esto se maneja en el servicio)
  });

/**
 * Schema para body de POST /accounts/payment
 * Nota: El validador permite que ambos campos sean opcionales porque el controller
 * maneja la lógica según el rol del usuario (VENTANA puede inferir ventanaId, ADMIN puede proporcionar cualquiera)
 */
export const CreatePaymentBodySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser en formato YYYY-MM-DD"),
    ventanaId: z.string().uuid().optional().nullable(),
    vendedorId: z.string().uuid().optional().nullable(),
    amount: z.number().positive("El monto debe ser positivo"),
    type: z.enum(["payment", "collection"]),
    method: z.enum(["cash", "transfer", "check", "other"]),
    notes: z.string().optional().nullable(),
    isFinal: z.boolean().optional().default(false),
    idempotencyKey: z.string().min(8, "idempotencyKey debe tener al menos 8 caracteres").max(100, "idempotencyKey máximo 100 caracteres").optional().nullable(),
  })
  .refine(
    (data) => {
      // Permitir que ambos sean null/undefined (el controller manejará según el rol)
      // Solo rechazar si ambos están presentes con valores válidos
      const hasVentanaId = data.ventanaId && data.ventanaId !== null && data.ventanaId !== undefined;
      const hasVendedorId = data.vendedorId && data.vendedorId !== null && data.vendedorId !== undefined;
      
      // Si ambos están presentes, rechazar
      if (hasVentanaId && hasVendedorId) {
        return false;
      }
      
      // Permitir cualquier otra combinación (ambos null, uno presente, etc.)
      return true;
    },
    {
      message: "No se pueden proporcionar ventanaId y vendedorId al mismo tiempo",
      path: ["ventanaId", "vendedorId"],
    }
  );

/**
 * Schema para query parameters de GET /accounts/payment-history
 */
export const GetPaymentHistoryQuerySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser en formato YYYY-MM-DD"),
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para body de POST /accounts/reverse-payment
 */
export const ReversePaymentBodySchema = z
  .object({
    paymentId: z.string().uuid("El ID del pago debe ser un UUID válido"),
    reason: z.string().min(5, "La razón debe tener al menos 5 caracteres").optional(),
  })
  .strict();

/**
 * Middleware de validación para GET /accounts/statement
 */
export const validateGetStatementQuery = validateQuery(GetStatementQuerySchema);

/**
 * Middleware de validación para POST /accounts/payment
 */
export const validateCreatePaymentBody = validateBody(CreatePaymentBodySchema);

/**
 * Middleware de validación para GET /accounts/payment-history
 */
export const validateGetPaymentHistoryQuery = validateQuery(GetPaymentHistoryQuerySchema);

/**
 * Middleware de validación para POST /accounts/reverse-payment
 */
export const validateReversePaymentBody = validateBody(ReversePaymentBodySchema);

/**
 * Schema para query parameters de GET /accounts/balance/current
 */
export const GetCurrentBalanceQuerySchema = z
  .object({
    scope: z.string(),
    dimension: z.string(),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .refine((data) => data.scope === "mine", {
    message: "Los parámetros scope y dimension son requeridos",
    path: ["scope"],
  })
  .refine((data) => data.dimension === "ventana", {
    message: "Los parámetros scope y dimension son requeridos",
    path: ["dimension"],
  });

/**
 * Middleware de validación para GET /accounts/balance/current
 */
export const validateGetCurrentBalanceQuery = validateQuery(GetCurrentBalanceQuerySchema);

/**
 * Schema para GET /api/v1/accounts/export
 * Exportación de estados de cuenta en CSV, Excel o PDF
 */
export const AccountStatementExportQuerySchema = z
  .object({
    // Formato de exportación (obligatorio)
    format: z.enum(["csv", "excel", "pdf"]),

    // Filtros de fecha (CR timezone, YYYY-MM-DD format)
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    date: z.enum(["today", "yesterday", "week", "month", "year", "range"]).optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

    // Scope y dimension
    scope: z.enum(["mine", "ventana", "all"]),
    dimension: z.enum(["banca", "ventana", "vendedor"]), // ✅ NUEVO: Agregado 'banca'

    // Filtros opcionales (según rol)
    bancaId: z.string().uuid().optional(), // ✅ NUEVO: Filtro opcional por banca
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),

    // Opciones de exportación
    includeBreakdown: z.coerce.boolean().optional().default(true),
    includeMovements: z.coerce.boolean().optional().default(true),
    sort: z.enum(["asc", "desc"]).optional().default("desc"),

    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict()
  .superRefine((val, ctx) => {
    // month y date son mutuamente exclusivos
    if (val.month && val.date) {
      ctx.addIssue({
        code: "custom",
        path: ["month"],
        message: "Los parámetros 'month' y 'date' son mutuamente exclusivos",
      });
    }

    // ✅ CRÍTICO: Validar que date=range cuando hay fromDate/toDate
    if ((val.fromDate || val.toDate) && val.date !== 'range') {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "date debe ser 'range' cuando se proporcionan fromDate o toDate",
      });
    }

    // Si date es 'range', fromDate y toDate son requeridos
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
      if (val.fromDate && val.toDate && val.fromDate > val.toDate) {
        ctx.addIssue({
          code: "custom",
          path: ["toDate"],
          message: "fromDate debe ser menor o igual a toDate",
        });
      }
    }
  });

/**
 * Middleware de validación para GET /accounts/export
 */
export const validateAccountStatementExportQuery = validateQuery(AccountStatementExportQuerySchema);
