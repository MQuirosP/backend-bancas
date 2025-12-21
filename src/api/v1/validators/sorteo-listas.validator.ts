import { z } from "zod";
import { Request, Response, NextFunction } from "express";
import { validateBody, validateParams } from "../../../middlewares/validate.middleware";

const IdParamSchema = z.object({
    id: z.uuid("sorteoId inválido (UUID)")
}).strict();

export const ExcludeListaSchema = z.object({
    ventanaId: z.uuid("ventanaId inválido"),
    vendedorId: z.uuid("vendedorId inválido").nullable().optional(),
    multiplierId: z.uuid("multiplierId inválido").nullable().optional(),
    reason: z.string().trim().min(3, "reason debe tener al menos 3 caracteres").max(500, "reason no puede exceder 500 caracteres").optional(),
}).strict();

export const IncludeListaSchema = z.object({
    ventanaId: z.uuid("ventanaId inválido"),
    vendedorId: z.uuid("vendedorId inválido").nullable().optional(),
    multiplierId: z.uuid("multiplierId inválido").nullable().optional(),
}).strict();

export const validateIdParam = (req: Request, res: Response, next: NextFunction) =>
    validateParams(IdParamSchema)(req, res, next);

export const validateExcludeLista = (req: Request, res: Response, next: NextFunction) =>
    validateBody(ExcludeListaSchema)(req, res, next);

export const validateIncludeLista = (req: Request, res: Response, next: NextFunction) =>
    validateBody(IncludeListaSchema)(req, res, next);
