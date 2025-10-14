import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { AppError } from "../../../core/errors";
import { CreateVentanaDto, UpdateVentanaDto } from "../dto/ventana.dto";

const IdParamDto = z.object({ id: z.uuid("id inválido (UUID)") }).strict();

function normalizeIssues(issues: any[]) {
  return issues.map((i: any) => {
    const field = i.path?.length ? i.path.join(".") : "(root)";
    const code  = i.code as string;

    if (code === "invalid_type") {
      const expected = i.expected;
      const received = i.received;
      // 👇 si la clave falta, Zod marca received: "undefined"
      const message =
        received === "undefined"
          ? `${field} es obligatorio`
          : `Tipo inválido. Esperado: ${expected}. Recibido: ${received}.`;

      return { field, code, message, expected, received };
    }

    if (code === "unrecognized_keys") {
      const keys = i.keys || [];
      return { field, code, message: `Claves no permitidas: ${keys.join(", ")}`, keys };
    }

    if (code === "invalid_string") {
      return { field, code, message: `String inválida (${i.validation}).`, validation: i.validation };
    }

    // too_small / too_big / etc. -> usa el message de Zod (ya es específico)
    return { field, code, message: i.message };
  });
}

const ALLOWED_KEYS = ["bancaId","name","code","commissionMarginX","address","phone","email"];

export const validateCreateVentana = (req: Request, _res: Response, next: NextFunction) => {
  const parsed = CreateVentanaDto.safeParse(req.body);
  if (!parsed.success) {
    const details = normalizeIssues(parsed.error.issues);
    throw new AppError("Validation error en Ventana (create)", 400, { issues: details, allowedKeys: ALLOWED_KEYS });
  }
  req.body = parsed.data;
  next();
};

export const validateUpdateVentana = (req: Request, _res: Response, next: NextFunction) => {
  const parsed = UpdateVentanaDto.safeParse(req.body);
  if (!parsed.success) {
    const details = normalizeIssues(parsed.error.issues);
    throw new AppError("Validation error en Ventana (update)", 400, { issues: details, allowedKeys: ALLOWED_KEYS });
  }
  req.body = parsed.data;
  next();
};

export const validateIdParam = (req: Request, _res: Response, next: NextFunction) => {
  const parsed = IdParamDto.safeParse(req.params);
  if (!parsed.success) {
    const details = normalizeIssues(parsed.error.issues);
    throw new AppError("Validation error en Ventana (params)", 400, { issues: details });
  }
  req.params = parsed.data as any;
  next();
};
