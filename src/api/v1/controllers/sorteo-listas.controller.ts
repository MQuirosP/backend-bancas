import { Response } from "express";
import { SorteoListasService } from "../services/sorteo-listas.service";
import { AuthenticatedRequest } from "../../../core/types";

export const SorteoListasController = {
    async getListas(req: AuthenticatedRequest, res: Response) {
        const response = await SorteoListasService.getListas(req.params.id);
        // ✅ Retornar estructura completa (no envuelto en "data")
        res.json({ success: true, ...response });
    },

    async excludeLista(req: AuthenticatedRequest, res: Response) {
        const exclusion = await SorteoListasService.excludeLista(
            req.params.id,
            req.body,
            req.user!.id
        );
        res.status(201).json({ success: true, data: exclusion });
    },

    async includeLista(req: AuthenticatedRequest, res: Response) {
        const result = await SorteoListasService.includeLista(
            req.params.id,
            req.body,
            req.user!.id
        );
        res.json({ success: true, data: result });
    },
};
