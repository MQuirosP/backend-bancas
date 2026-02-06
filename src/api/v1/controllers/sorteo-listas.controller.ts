import { Response } from "express";
import { SorteoListasService } from "../services/sorteo-listas.service";
import { AuthenticatedRequest } from "../../../core/types";

export const SorteoListasController = {
    async getListas(req: AuthenticatedRequest, res: Response) {
        const includeExcluded = req.query.includeExcluded === 'true'; // Default false
        const vendedorId = req.query.vendedorId as string | undefined;
        const multiplierId = req.query.multiplierId as string | undefined;
        const mode = (req.query.mode as string) === 'compact' ? 'compact' : 'full';

        const response = await SorteoListasService.getListas(
            req.params.id,
            includeExcluded,
            vendedorId,
            multiplierId,
            mode
        );
        //  Cache corto porque los datos cambian poco mientras el sorteo está abierto
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
        //  Retornar estructura completa (no envuelto en "data")
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

    async getExcludedListas(req: AuthenticatedRequest, res: Response) {
        // Parse query parameters
        const filters: any = {};

        if (req.query.sorteoId) filters.sorteoId = req.query.sorteoId as string;
        if (req.query.ventanaId) filters.ventanaId = req.query.ventanaId as string;
        if (req.query.vendedorId) filters.vendedorId = req.query.vendedorId as string;
        if (req.query.multiplierId) filters.multiplierId = req.query.multiplierId as string;
        if (req.query.loteriaId) filters.loteriaId = req.query.loteriaId as string;

        // Parse date filters
        if (req.query.fromDate) {
            filters.fromDate = new Date(req.query.fromDate as string);
        }
        if (req.query.toDate) {
            filters.toDate = new Date(req.query.toDate as string);
        }

        const exclusions = await SorteoListasService.getExcludedListas(filters);
        res.json({ success: true, data: exclusions, total: exclusions.length });
    },
};
