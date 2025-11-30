import { SorteoStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import {
    ExcludeListaDTO,
    IncludeListaDTO,
    ListaSummaryItem,
    ListaExclusionResponse,
    ListasResponse,
    ListeroSummary,
    VendedorSummary,
    SorteoInfo
} from "../dto/sorteo-listas.dto";
import logger from "../../../core/logger";
import { formatIsoLocal } from "../../../utils/datetime";

export const SorteoListasService = {
    /**
     * Obtiene el resumen de listas (ventanas/vendedores) con su estado de exclusión
     * GET /api/v1/sorteos/:id/listas
     * ✅ NUEVA ESTRUCTURA: Agrupado por ventana con array de vendedores
     */
    async getListas(sorteoId: string): Promise<ListasResponse> {
        // 1. Obtener información completa del sorteo
        const sorteo = await prisma.sorteo.findUnique({
            where: { id: sorteoId },
            select: {
                id: true,
                name: true,
                status: true,
                scheduledAt: true,
                winningNumber: true,
                loteria: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });

        if (!sorteo) {
            throw new AppError("Sorteo no encontrado", 404);
        }

        // 2. Obtener todos los tickets del sorteo con comisiones
        const tickets = await prisma.ticket.findMany({
            where: {
                sorteoId,
                deletedAt: null,
            },
            select: {
                id: true,
                totalAmount: true,
                totalCommission: true,
                ventanaId: true,
                vendedorId: true,
                status: true,
                ventana: {
                    select: {
                        id: true,
                        name: true,
                        code: true,
                    },
                },
                vendedor: {
                    select: {
                        id: true,
                        name: true,
                        code: true,
                    },
                },
            },
        });

        // 3. Obtener todas las exclusiones del sorteo
        const exclusions = await prisma.sorteoListaExclusion.findMany({
            where: { sorteoId },
            select: {
                id: true,
                ventanaId: true,
                vendedorId: true,
                reason: true,
                excludedAt: true,
                excludedBy: true,
                excludedByUser: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        // 4. Crear mapa de exclusiones para búsqueda rápida
        const exclusionMap = new Map<string, {
            id: string;
            reason: string | null;
            excludedAt: Date;
            excludedBy: string;
            excludedByName: string;
        }>();

        for (const exclusion of exclusions) {
            const key = `${exclusion.ventanaId}:${exclusion.vendedorId || "null"}`;
            exclusionMap.set(key, {
                id: exclusion.id,
                reason: exclusion.reason,
                excludedAt: exclusion.excludedAt,
                excludedBy: exclusion.excludedBy,
                excludedByName: exclusion.excludedByUser.name,
            });
        }

        // 5. Agrupar tickets por ventana y vendedor
        const ventanasMap = new Map<string, {
            ventanaId: string;
            ventanaName: string;
            ventanaCode: string;
            vendedores: Map<string, {
                vendedorId: string | null;
                vendedorName: string | null;
                vendedorCode: string | null;
                totalSales: number;
                totalTickets: number;
                totalCommission: number;
            }>;
        }>();

        for (const ticket of tickets) {
            // Obtener o crear entrada de ventana
            if (!ventanasMap.has(ticket.ventanaId)) {
                ventanasMap.set(ticket.ventanaId, {
                    ventanaId: ticket.ventanaId,
                    ventanaName: ticket.ventana.name,
                    ventanaCode: ticket.ventana.code,
                    vendedores: new Map(),
                });
            }

            const ventanaEntry = ventanasMap.get(ticket.ventanaId)!;
            const vendedorKey = ticket.vendedorId || "null";

            // Obtener o crear entrada de vendedor
            if (!ventanaEntry.vendedores.has(vendedorKey)) {
                ventanaEntry.vendedores.set(vendedorKey, {
                    vendedorId: ticket.vendedorId,
                    vendedorName: ticket.vendedor?.name || null,
                    vendedorCode: ticket.vendedor?.code || null,
                    totalSales: 0,
                    totalTickets: 0,
                    totalCommission: 0,
                });
            }

            const vendedorEntry = ventanaEntry.vendedores.get(vendedorKey)!;
            vendedorEntry.totalSales += ticket.totalAmount;
            vendedorEntry.totalTickets += 1;
            vendedorEntry.totalCommission += ticket.totalCommission ?? 0;
        }

        // 6. Construir estructura de respuesta agrupada
        const listeros: ListeroSummary[] = [];
        let totalSalesGlobal = 0;
        let totalTicketsGlobal = 0;
        let totalCommissionGlobal = 0;
        let totalExcluded = 0;

        for (const [ventanaId, ventanaData] of ventanasMap.entries()) {
            // Construir array de vendedores para esta ventana
            const vendedores: VendedorSummary[] = [];
            let ventanaTotalSales = 0;
            let ventanaTotalTickets = 0;
            let ventanaTotalCommission = 0;

            for (const [vendedorKey, vendedorData] of ventanaData.vendedores.entries()) {
                const exclusionKey = `${ventanaId}:${vendedorKey}`;
                const exclusion = exclusionMap.get(exclusionKey);

                vendedores.push({
                    vendedorId: vendedorData.vendedorId,
                    vendedorName: vendedorData.vendedorName,
                    vendedorCode: vendedorData.vendedorCode,
                    totalSales: vendedorData.totalSales,
                    totalTickets: vendedorData.totalTickets,
                    totalCommission: vendedorData.totalCommission,
                    isExcluded: !!exclusion,
                    exclusionId: exclusion?.id || null,
                    exclusionReason: exclusion?.reason || null,
                    excludedAt: exclusion?.excludedAt.toISOString() || null,
                    excludedBy: exclusion?.excludedBy || null,
                    excludedByName: exclusion?.excludedByName || null,
                });

                ventanaTotalSales += vendedorData.totalSales;
                ventanaTotalTickets += vendedorData.totalTickets;
                ventanaTotalCommission += vendedorData.totalCommission;

                if (exclusion) totalExcluded++;
            }

            // Ordenar vendedores: sin vendedorId primero, luego por nombre
            vendedores.sort((a, b) => {
                if (a.vendedorId === null && b.vendedorId !== null) return -1;
                if (a.vendedorId !== null && b.vendedorId === null) return 1;
                return (a.vendedorName || "").localeCompare(b.vendedorName || "");
            });

            // Verificar si la ventana completa está excluida
            const ventanaExclusionKey = `${ventanaId}:null`;
            const ventanaExclusion = exclusionMap.get(ventanaExclusionKey);

            listeros.push({
                ventanaId: ventanaData.ventanaId,
                ventanaName: ventanaData.ventanaName,
                ventanaCode: ventanaData.ventanaCode,
                totalSales: ventanaTotalSales,
                totalTickets: ventanaTotalTickets,
                totalCommission: ventanaTotalCommission,
                isExcluded: !!ventanaExclusion,
                exclusionId: ventanaExclusion?.id || null,
                exclusionReason: ventanaExclusion?.reason || null,
                excludedAt: ventanaExclusion?.excludedAt.toISOString() || null,
                excludedBy: ventanaExclusion?.excludedBy || null,
                excludedByName: ventanaExclusion?.excludedByName || null,
                vendedores,
            });

            totalSalesGlobal += ventanaTotalSales;
            totalTicketsGlobal += ventanaTotalTickets;
            totalCommissionGlobal += ventanaTotalCommission;
        }

        // Ordenar listeros por nombre de ventana
        listeros.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName));

        // 7. Construir respuesta final
        const response: ListasResponse = {
            sorteo: {
                id: sorteo.id,
                name: sorteo.name,
                status: sorteo.status,
                scheduledAt: formatIsoLocal(sorteo.scheduledAt),
                winningNumber: sorteo.winningNumber,
                loteria: sorteo.loteria,
            },
            listeros,
            meta: {
                totalSales: totalSalesGlobal,
                totalTickets: totalTicketsGlobal,
                totalCommission: totalCommissionGlobal,
                totalExcluded,
            },
        };

        // Log para debugging
        logger.info({
            layer: "service",
            action: "SORTEO_LISTAS_GET",
            payload: {
                sorteoId,
                ticketsFound: tickets.length,
                exclusionsFound: exclusions.length,
                listerosResult: listeros.length,
                totalExcluded,
                message: "Resultado de getListas (nueva estructura)"
            }
        });

        return response;
    },

    /**
     * Excluye una lista (ventana completa o vendedor específico)
     * POST /api/v1/sorteos/:id/listas/exclude
     */
    async excludeLista(
        sorteoId: string,
        data: ExcludeListaDTO,
        userId: string
    ): Promise<ListaExclusionResponse> {
        // Verificar que el sorteo existe y está en estado OPEN
        const sorteo = await prisma.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true, status: true },
        });

        if (!sorteo) {
            throw new AppError("Sorteo no encontrado", 404);
        }

        if (sorteo.status !== SorteoStatus.OPEN) {
            throw new AppError(
                `Solo se puede excluir listas cuando el sorteo está en estado OPEN (actual: ${sorteo.status})`,
                400
            );
        }

        // Verificar que la ventana existe
        const ventana = await prisma.user.findUnique({
            where: { id: data.ventanaId },
            select: { id: true, role: true },
        });

        if (!ventana || ventana.role !== "VENTANA") {
            throw new AppError("Ventana no encontrada o usuario no es VENTANA", 404);
        }

        // Si se especifica vendedorId, verificar que existe y pertenece a la ventana
        if (data.vendedorId) {
            const vendedor = await prisma.user.findUnique({
                where: { id: data.vendedorId },
                select: { id: true, role: true, ventanaId: true },
            });

            if (!vendedor || vendedor.role !== "VENDEDOR") {
                throw new AppError("Vendedor no encontrado o usuario no es VENDEDOR", 404);
            }

            if (vendedor.ventanaId !== data.ventanaId) {
                throw new AppError("El vendedor no pertenece a la ventana especificada", 400);
            }
        }

        // Crear exclusión (upsert para evitar duplicados)
        const whereClause = {
            sorteoId,
            ventanaId: data.ventanaId,
            vendedorId: data.vendedorId || null,
        };

        const exclusion = await prisma.sorteoListaExclusion.upsert({
            where: {
                sorteoId_ventanaId_vendedorId: whereClause as any,
            },
            create: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId || null,
                excludedBy: userId,
                reason: data.reason || null,
            },
            update: {
                excludedBy: userId,
                reason: data.reason || null,
                excludedAt: new Date(),
            },
        });

        return {
            id: exclusion.id,
            sorteoId: exclusion.sorteoId,
            ventanaId: exclusion.ventanaId,
            vendedorId: exclusion.vendedorId,
            excludedAt: exclusion.excludedAt.toISOString(),
            excludedBy: exclusion.excludedBy,
            reason: exclusion.reason,
            createdAt: exclusion.createdAt.toISOString(),
            updatedAt: exclusion.updatedAt.toISOString(),
        };
    },

    /**
     * Revierte una exclusión (incluye nuevamente la lista)
     * POST /api/v1/sorteos/:id/listas/include
     */
    async includeLista(
        sorteoId: string,
        data: IncludeListaDTO,
        userId: string
    ): Promise<{ success: boolean; message: string }> {
        // Verificar que el sorteo existe y está en estado OPEN
        const sorteo = await prisma.sorteo.findUnique({
            where: { id: sorteoId },
            select: { id: true, status: true },
        });

        if (!sorteo) {
            throw new AppError("Sorteo no encontrado", 404);
        }

        if (sorteo.status !== SorteoStatus.OPEN) {
            throw new AppError(
                `Solo se puede revertir exclusiones cuando el sorteo está en estado OPEN (actual: ${sorteo.status})`,
                400
            );
        }

        // Eliminar exclusión
        const deleted = await prisma.sorteoListaExclusion.deleteMany({
            where: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId || null,
            },
        });

        if (deleted.count === 0) {
            throw new AppError("No se encontró la exclusión especificada", 404);
        }

        return {
            success: true,
            message: "Exclusión revertida exitosamente",
        };
    },
};

export default SorteoListasService;
