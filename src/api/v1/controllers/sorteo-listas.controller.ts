import { Response } from "express";
import { SorteoListasService } from "../services/sorteo-listas.service";
import { AuthenticatedRequest } from "../../../core/types";
import { Role } from "../../../generated/prisma/client";
import { validateVentanaUser } from "../../../utils/rbac";

export const SorteoListasController = {
    async getListas(req: AuthenticatedRequest, res: Response) {
        const includeExcluded = req.query.includeExcluded === 'true'; // Default false
        let vendedorId = req.query.vendedorId as string | undefined;
        const multiplierId = req.query.multiplierId as string | undefined;
        const mode = (req.query.mode as string) === 'compact' ? 'compact' : 'full';
        
        const me = req.user!;
        // bancaId puede ser undefined para ADMIN global viendo datos históricos sin banca seleccionada
        const bancaId = req.bancaContext?.bancaId ?? undefined;
        
        // Aplicar RBAC: Si es VENDEDOR, forzar ver solo sus propias listas
        if (me.role === Role.VENDEDOR) {
            vendedorId = me.id;
        }

        //  FIX: Si es rol VENTANA y el vendedorId enviado es el mismo ID del usuario (Ventana),
        // limpiamos el vendedorId para que devuelva el resumen de toda su ventana.
        if (me.role === Role.VENTANA && (!vendedorId || vendedorId === me.id)) {
            vendedorId = undefined;
        }

        const response = await SorteoListasService.getListas(
            req.params.id,
            bancaId,
            includeExcluded,
            vendedorId,
            multiplierId,
            mode
        );

        // Si es rol VENTANA, el servicio ya filtró por bancaId en SQL.
        // Pero el servicio devuelve TODAS las ventanas de la banca.
        // Debemos filtrar para que el Listero solo vea SU propia ventana.
        if (me.role === Role.VENTANA) {
            const myVentanaId = await validateVentanaUser(me.role, me.ventanaId, me.id);
            
            if (response.listeros) {
                response.listeros = response.listeros.filter(l => l.ventanaId === myVentanaId);
            }
            if (response.listerosCompact) {
                response.listerosCompact = response.listerosCompact.filter(l => l.ventanaId === myVentanaId);
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
                totalExcluded += l.vendedores.filter(v => v.isExcluded).length;
            });
            
            if (response.listerosCompact && response.listerosCompact.length > 0) {
                response.listerosCompact.forEach(l => {
                    totalExcluded += l.totalExcluded || 0; 
                });
            }
            response.meta.totalSales = totalSales;
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
        const bancaId = req.bancaContext?.bancaId ?? undefined;
        if (!bancaId) {
            return res.status(400).json({ success: false, error: "BANCA_CONTEXT_REQUIRED" });
        }

        const exclusion = await SorteoListasService.excludeLista(
            req.params.id,
            req.body,
            req.user!.id,
            bancaId!
        );
        res.status(201).json({ success: true, data: exclusion });
    },

    async includeLista(req: AuthenticatedRequest, res: Response) {
        const bancaId = req.bancaContext?.bancaId ?? undefined;
        if (!bancaId) {
            return res.status(400).json({ success: false, error: "BANCA_CONTEXT_REQUIRED" });
        }

        const result = await SorteoListasService.includeLista(
            req.params.id,
            req.body,
            req.user!.id,
            bancaId!
        );
        res.json({ success: true, data: result });
    },

    async getExcludedListas(req: AuthenticatedRequest, res: Response) {
        // bancaId puede ser undefined para ADMIN global viendo datos históricos sin banca seleccionada
        const bancaId = req.bancaContext?.bancaId ?? undefined;

        // Parse query parameters
        const filters: any = {};
        if (bancaId) filters.bancaId = bancaId;

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

        // Si es rol VENTANA, filtrar resultados para mostrar solo su ventana
        let finalExclusions = exclusions;
        if (req.user!.role === Role.VENTANA) {
            const myVentanaId = await validateVentanaUser(req.user!.role, req.user!.ventanaId, req.user!.id);
            finalExclusions = exclusions.filter(ex => ex.ventanaId === myVentanaId);
        }

        res.json({ success: true, data: finalExclusions, total: finalExclusions.length });
    },
};
