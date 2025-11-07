// src/api/v1/validators/accounts.validator.ts
import { z } from "zod";
import { validateQuery, validateBody } from "../../../middlewares/validate.middleware";

/**
 * Schema para query parameters de GET /accounts/statement
 */
export const GetStatementQuerySchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/, "El mes debe ser en formato YYYY-MM"),
    scope: z.enum(["mine", "ventana", "all"]),
    dimension: z.enum(["ventana", "vendedor"]),
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    sort: z.enum(["asc", "desc"]).optional().default("desc"),
    _: z.string().optional(), // Para evitar caché del navegador (ignorado)
  })
  .strict();

/**
 * Schema para body de POST /accounts/payment
 */
export const CreatePaymentBodySchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe ser en formato YYYY-MM-DD"),
    ventanaId: z.string().uuid().optional(),
    vendedorId: z.string().uuid().optional(),
    amount: z.number().positive("El monto debe ser positivo"),
    type: z.enum(["payment", "collection"]),
    method: z.enum(["cash", "transfer", "check", "other"]),
    notes: z.string().optional(),
    isFinal: z.boolean().optional().default(false),
    idempotencyKey: z.string().uuid().optional(),
  })
  .refine(
    (data) => {
      // Debe tener ventanaId o vendedorId, pero no ambos
      return (data.ventanaId && !data.vendedorId) || (!data.ventanaId && data.vendedorId);
    },
    {
      message: "Debe proporcionar ventanaId o vendedorId, pero no ambos",
    }
  )
  .strict();

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
