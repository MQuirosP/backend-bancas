import { Request, Response, NextFunction } from "express";
import { z, ZodError, ZodType } from "zod";
import { AppError } from "../core/errors";
import { normalizeDateCR } from "../utils/datetime";

/** Mapea ZodError.issues -> detalles trazables y legibles */
function toDetails(error: ZodError) {
  return error.issues.map((i: any) => {
    const field = i.path?.length ? i.path.join(".") : "(root)";
    const code = i.code as string;

    if (code === "invalid_type") {
      const expected = i.expected;
      const received = i.received;
      // Si falta la clave, Zod marca received="undefined"
      const issue =
        received === "undefined"
          ? `${field} es obligatorio`
          : `Tipo inválido. Esperado: ${expected}. Recibido: ${received}.`;
      return { field, code, issue, expected, received };
    }

    if (code === "unrecognized_keys") {
      const keys = i.keys || [];
      return { field, code, issue: `Claves no permitidas: ${keys.join(", ")}`, unexpectedKeys: keys };
    }

    if (code === "invalid_string") {
      return { field, code, issue: `String inválida (${i.validation}).`, validation: i.validation };
    }

    // too_small / too_big / etc. -> deja el message de Zod (ya es útil)
    return { field, code, issue: i.message };
  });
}

/** Construye un resumen compacto para el message */
function buildSummary(details: Array<any>, source: "body" | "query" | "params") {
  const missing = details
    .filter(d => d.code === "invalid_type" && d.received === "undefined")
    .map(d => d.field);

  const extras = details.flatMap(d => d.unexpectedKeys ?? []);

  const parts: string[] = [];
  if (missing.length) parts.push(`faltantes: ${missing.join(", ")}`);
  if (extras.length) parts.push(`no permitidas: ${extras.join(", ")}`);

  return parts.length
    ? `Hay errores de validación en ${source} (${parts.join(" | ")})`
    : `Hay errores de validación en ${source}`;
}

/** Fuerza .strict() y emite AppError con meta {context, details} */
function validateWith(schema: ZodType<any>, source: "body" | "query" | "params") {
  // Si el schema tiene .strict(), lo aplicamos aquí para rechazar claves extra
  const strictSchema = typeof (schema as any).strict === "function" ? (schema as any).strict() : schema;

  return (req: Request, _res: Response, next: NextFunction) => {
    let data = (req as any)[source];

    // Para body, si es undefined o null, convertir a {} para schemas que lo permiten
    if (source === "body" && (data === undefined || data === null)) {
      data = {};
    }

    const result = strictSchema.safeParse(data);

    if (result.success) {
      (req as any)[source] = result.data; // normaliza con lo que el schema haya coaccionado
      return next();
    }

    const details = toDetails(result.error);
    const message = buildSummary(details, source);
    const context = {
      method: req.method,
      path: (req as any).originalUrl || req.url,
      source,
      requestId: (req as any).requestId,
      userId: (req as any)?.user?.id,
    };

    throw new AppError(message, 400, { context, details });
  };
}

export const validateBody = (schema: ZodType<any>) => validateWith(schema, "body");
export const validateParams = (schema: ZodType<any>) => validateWith(schema, "params");
export const validateQuery = (schema: ZodType<any>) => validateWith(schema, "query");

// ============================================================================
// 🛡️ SCHEMA ZOD PERSONALIZADO PARA FECHAS CR
// ============================================================================

/**
 * Schema Zod personalizado para fechas que normaliza a CR timezone.
 * Acepta: Date, ISO string, timestamp number
 * Retorna: Date normalizado y validado
 * 
 * Uso:
 * ```typescript
 * const schema = z.object({
 *   scheduledAt: zodDateCR(),
 *   createdAt: zodDateCR().optional(),
 * });
 * ```
 */
export function zodDateCR() {
  return z.union([
    z.date(),
    z.string(),
    z.number(),
  ]).transform((val) => {
    try {
      // Intentar normalizar sin nombre de campo específico
      return normalizeDateCR(val, 'date');
    } catch (err: any) {
      // Si falla, Zod manejará el error en la validación
      throw new Error(err.message || 'Fecha inválida');
    }
  });
}
