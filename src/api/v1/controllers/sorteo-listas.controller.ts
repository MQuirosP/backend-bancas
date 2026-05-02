import { Response } from "express";
import { SorteoListasService } from "../services/sorteo-listas.service";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "@prisma/client";

export const SorteoListasController = {
    async getListas(req: AuthenticatedRequest, res: Response) {
        const includeExcluded = req.query.includeExcluded === 'true'; // Default false
        let vendedorId = req.query.vendedorId as string | undefined;
        const multiplierId = req.query.multiplierId as string | undefined;
        const mode = (req.query.mode as string) === 'compact' ? 'compact' : 'full';
        
        const me = req.user!;
        
        // Aplicar RBAC: Si es VENDEDOR, forzar ver solo sus propias listas
        if (me.role === Role.VENDEDOR) {
            vendedorId = me.id;
        }

        const response = await SorteoListasService.getListas(
            req.params.id,
            includeExcluded,
            vendedorId,
            multiplierId,
            mode
        );

        // Si es rol VENTANA, filtrar los resultados en memoria para mostrar solo su ventana
        // Nota: SorteoListasService.getListas no tiene filtro de ventanaId interno,
        // devuelve todas las ventanas si no se filtra por vendedor.
        if (me.role === Role.VENTANA) {
            if (response.listeros) {
                response.listeros = response.listeros.filter(l => l.ventanaId === me.ventanaId);
            }
            if (response.listerosCompact) {
                response.listerosCompact = response.listerosCompact.filter(l => l.ventanaId === me.ventanaId);
            }
            
            // Recalcular totales globales basados solo en esta ventana
            let totalSales = 0;
            let totalTickets = 0;
            let totalCommission = 0;
            let totalExcluded = 0;
            
            response.listeros.forEach(l => {
                totalSales += l.totalSales;
                totalTickets += l.totalTickets;
                totalCommission += l.totalCommission;
                // Sumar vendedores excluidos individualmente
                totalExcluded += l.vendedores.filter(v => v.isExcluded).length;
            });
            
            // Si hay listerosCompact, también debemos sumar de ahí
            if (response.listerosCompact && response.listerosCompact.length > 0) {
                response.listerosCompact.forEach(l => {
                    totalExcluded += l.totalExcluded; 
                });
            }
            response.meta.totalTickets = totalTickets;
            response.meta.totalCommission = totalCommission;
            response.meta.totalExcluded = totalExcluded;
        }

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
