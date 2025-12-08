import { SorteoStatus } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import {
    ExcludeListaDTO,
    IncludeListaDTO,
    ListaSummaryItem,
    ListaExclusionResponse,
    ExcludeIncludeResponse,
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
     * ✅ FILTROS: vendedorId, multiplierId
     */
    async getListas(
        sorteoId: string,
        includeExcluded: boolean = true,
        vendedorIdFilter?: string,
        multiplierIdFilter?: string
    ): Promise<ListasResponse> {
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

        // 2. Obtener todos los tickets del sorteo con comisiones y jugadas
        // ✅ NUEVO: Filtrar jugadas por isExcluded según includeExcluded
        const jugadaWhere: any = {
            deletedAt: null,
            isActive: true,
        };

        // Aplicar filtro de exclusión
        if (!includeExcluded) {
            jugadaWhere.isExcluded = false;
        }

        // Aplicar filtro de multiplierId si se proporciona
        if (multiplierIdFilter) {
            jugadaWhere.multiplierId = multiplierIdFilter;
        }

        // Construir where para tickets
        const ticketWhere: any = {
            sorteoId,
            deletedAt: null,
        };

        // Aplicar filtro de vendedorId si se proporciona
        if (vendedorIdFilter) {
            ticketWhere.vendedorId = vendedorIdFilter;
        }

        const tickets = await prisma.ticket.findMany({
            where: ticketWhere,
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
                // ✅ NUEVO: Incluir jugadas con filtros de exclusión
                jugadas: {
                    where: jugadaWhere,
                    select: {
                        id: true,
                        type: true,  // NUMERO o REVENTADO
                        number: true,  // ✅ CRÍTICO: Número base (para REVENTADO, apunta al número base)
                        amount: true,
                        listeroCommissionAmount: true,  // Comisión del listero
                        multiplierId: true,
                        multiplier: {
                            select: {
                                id: true,
                                name: true,
                                valueX: true,
                                kind: true,  // ✅ CRÍTICO: 'NUMERO' o 'REVENTADO'
                            }
                        },
                        // ✅ NUEVO: Campos de exclusión
                        isExcluded: true,
                        excludedAt: true,
                        excludedBy: true,
                        excludedReason: true,
                        excludedByUser: {
                            select: {
                                name: true,
                            }
                        }
                    },
                },
            },
        });

        // 3. Agrupar tickets por ventana, vendedor y multiplicador
        // ✅ NUEVO: La exclusión ahora viene a nivel de jugada, no hay tabla separada
        const ventanasMap = new Map<string, {
            ventanaId: string;
            ventanaName: string;
            ventanaCode: string;
            vendedores: Map<string, {
                vendedorId: string | null;
                vendedorName: string | null;
                vendedorCode: string | null;
                multiplierId: string | null;
                multiplierName: string | null;
                multiplierValue: number | null;
                totalSales: number;
                ticketIds: Set<string>; // Para contar tickets únicos
                totalCommission: number;
                commissionByNumber: number;
                commissionByReventado: number;
                // ✅ NUEVO: Campos de exclusión
                isExcluded: boolean;
                excludedAt: Date | null;
                excludedBy: string | null;
                excludedReason: string | null;
                excludedByName: string | null;
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

            // ✅ CRÍTICO: Separar jugadas NUMERO y REVENTADO para encontrar el multiplicador base
            const jugadasNumero = ticket.jugadas.filter(j => j.type === 'NUMERO');
            const jugadasReventado = ticket.jugadas.filter(j => j.type === 'REVENTADO');

            // Crear mapa de número base -> multiplicador base (NUMERO)
            const numeroBaseMultiplierMap = new Map<string, {
                multiplierId: string | null;
                multiplierName: string | null;
                multiplierValue: number | null;
            }>();

            for (const jugadaNumero of jugadasNumero) {
                if (jugadaNumero.number && jugadaNumero.multiplierId) {
                    numeroBaseMultiplierMap.set(jugadaNumero.number, {
                        multiplierId: jugadaNumero.multiplierId,
                        multiplierName: jugadaNumero.multiplier?.name || null,
                        multiplierValue: jugadaNumero.multiplier?.valueX || null,
                    });
                }
            }

            // Iterar sobre jugadas para agrupar por multiplicador base
            for (const jugada of ticket.jugadas) {
                const vendedorId = ticket.vendedorId;
                const vendedorKey = vendedorId || "null";
                
                // ✅ CRÍTICO: Determinar multiplicador base según tipo de jugada
                let multiplierId: string | null = null;
                let multiplierName: string | null = null;
                let multiplierValue: number | null = null;

                if (jugada.type === 'NUMERO') {
                    // Para NUMERO, usar su propio multiplicador
                    multiplierId = jugada.multiplierId;
                    multiplierName = jugada.multiplier?.name || null;
                    multiplierValue = jugada.multiplier?.valueX || null;
                } else if (jugada.type === 'REVENTADO') {
                    // ✅ CRÍTICO: Para REVENTADO, buscar el multiplicador base (NUMERO) del número base
                    // El campo jugada.number en REVENTADO apunta al número base
                    const baseMultiplier = jugada.number ? numeroBaseMultiplierMap.get(jugada.number) : null;
                    if (baseMultiplier) {
                        multiplierId = baseMultiplier.multiplierId;
                        multiplierName = baseMultiplier.multiplierName;
                        multiplierValue = baseMultiplier.multiplierValue;
                    } else {
                        // Fallback: si no se encuentra el multiplicador base, usar null
                        // Esto puede pasar si el REVENTADO no tiene un NUMERO asociado (caso edge)
                        multiplierId = null;
                        multiplierName = null;
                        multiplierValue = null;
                    }
                }

                const multiplierKey = multiplierId || "null";
                // Clave compuesta para agrupación: vendedor:multiplicador base
                const groupKey = `${vendedorKey}:${multiplierKey}`;

                if (!ventanaEntry.vendedores.has(groupKey)) {
                    ventanaEntry.vendedores.set(groupKey, {
                        vendedorId: ticket.vendedorId,
                        vendedorName: ticket.vendedor?.name || null,
                        vendedorCode: ticket.vendedor?.code || null,
                        multiplierId: multiplierId,
                        multiplierName: multiplierName,
                        multiplierValue: multiplierValue,
                        totalSales: 0,
                        ticketIds: new Set(),
                        totalCommission: 0,
                        commissionByNumber: 0,
                        commissionByReventado: 0,
                        // ✅ NUEVO: Campos de exclusión desde jugadas
                        isExcluded: jugada.isExcluded,
                        excludedAt: jugada.excludedAt,
                        excludedBy: jugada.excludedBy,
                        excludedReason: jugada.excludedReason,
                        excludedByName: jugada.excludedByUser?.name || null,
                    });
                }

                const entry = ventanaEntry.vendedores.get(groupKey)!;
                entry.totalSales += jugada.amount;
                entry.ticketIds.add(ticket.id);

                const commission = jugada.listeroCommissionAmount || 0;
                entry.totalCommission += commission;

                if (jugada.type === 'NUMERO') {
                    entry.commissionByNumber += commission;
                } else if (jugada.type === 'REVENTADO') {
                    entry.commissionByReventado += commission;
                }
            }
        }

        // 6. Construir estructura de respuesta agrupada
        const listeros: ListeroSummary[] = [];
        let totalSalesGlobal = 0;
        let totalTicketsGlobal = 0;
        let totalCommissionGlobal = 0;
        let totalExcluded = 0;

        for (const [ventanaId, ventanaData] of ventanasMap.entries()) {
            // ✅ NUEVO: La exclusión ya está filtrada en las jugadas, solo necesitamos agrupar
            // Construir array de vendedores (agrupados por multiplicador) para esta ventana
            const vendedores: VendedorSummary[] = [];
            let ventanaTotalSales = 0;
            let ventanaTotalTickets = 0;
            let ventanaTotalCommission = 0;
            let ventanaCommissionByNumber = 0;
            let ventanaCommissionByReventado = 0;

            // Agrupar entradas por vendedor
            const entriesByVendor = new Map<string, typeof ventanaData.vendedores extends Map<any, infer V> ? V[] : never>();

            for (const data of ventanaData.vendedores.values()) {
                const vKey = data.vendedorId || "null";
                if (!entriesByVendor.has(vKey)) {
                    entriesByVendor.set(vKey, []);
                }
                entriesByVendor.get(vKey)!.push(data);
            }

            for (const [vKey, entries] of entriesByVendor.entries()) {
                // Verificar si todas las entradas del vendedor están excluidas
                const allExcluded = entries.every(e => e.isExcluded);
                const anyExcluded = entries.some(e => e.isExcluded);

                // Si no incluimos excluidos y todas están excluidas, saltar
                if (!includeExcluded && allExcluded) {
                    continue;
                }

                // CASO 1: Vendedor totalmente excluido -> COLAPSAR
                if (allExcluded && includeExcluded) {

                    // Colapsar todas las entradas de este vendedor
                    let collapsedSales = 0;
                    let collapsedTickets = new Set<string>();
                    let collapsedCommission = 0;
                    let collapsedCommissionNumber = 0;
                    let collapsedCommissionReventado = 0;

                    // Usar datos del primer entry para nombres/códigos y exclusión
                    const first = entries[0];

                    for (const entry of entries) {
                        collapsedSales += entry.totalSales;
                        entry.ticketIds.forEach(id => collapsedTickets.add(id));
                        collapsedCommission += entry.totalCommission;
                        collapsedCommissionNumber += entry.commissionByNumber;
                        collapsedCommissionReventado += entry.commissionByReventado;
                    }

                    vendedores.push({
                        vendedorId: first.vendedorId,
                        vendedorName: first.vendedorName,
                        vendedorCode: first.vendedorCode,
                        multiplierId: null,
                        multiplierName: "Todos (Excluido)",
                        multiplierValue: null,
                        totalSales: collapsedSales,
                        totalTickets: collapsedTickets.size,
                        totalCommission: collapsedCommission,
                        commissionByNumber: collapsedCommissionNumber,
                        commissionByReventado: collapsedCommissionReventado,
                        isExcluded: true,
                        exclusionId: null, // No hay un ID único cuando se colapsa
                        exclusionReason: first.excludedReason,
                        excludedAt: first.excludedAt ? first.excludedAt.toISOString() : null,
                        excludedBy: first.excludedBy,
                        excludedByName: first.excludedByName,
                    });

                    totalExcluded++;
                    // NO sumamos a los totales de ventana porque está excluido
                    continue;
                }

                // CASO 2: Procesar individualmente
                for (const data of entries) {
                    const isExcludedItem = data.isExcluded;

                    // Si no incluimos excluidos y está excluido, saltar
                    if (!includeExcluded && isExcludedItem) {
                        continue;
                    }

                    vendedores.push({
                        vendedorId: data.vendedorId,
                        vendedorName: data.vendedorName,
                        vendedorCode: data.vendedorCode,
                        multiplierId: data.multiplierId,
                        multiplierName: data.multiplierName,
                        multiplierValue: data.multiplierValue,
                        totalSales: data.totalSales,
                        totalTickets: data.ticketIds.size,
                        totalCommission: data.totalCommission,
                        commissionByNumber: data.commissionByNumber,
                        commissionByReventado: data.commissionByReventado,
                        isExcluded: isExcludedItem,
                        exclusionId: null, // No hay un ID único, la exclusión está distribuida en jugadas
                        exclusionReason: data.excludedReason,
                        excludedAt: data.excludedAt ? data.excludedAt.toISOString() : null,
                        excludedBy: data.excludedBy,
                        excludedByName: data.excludedByName,
                    });

                    // Solo sumar a los totales si NO está excluido
                    if (!isExcludedItem) {
                        ventanaTotalSales += data.totalSales;
                        ventanaTotalTickets += data.ticketIds.size;
                        ventanaTotalCommission += data.totalCommission;
                        ventanaCommissionByNumber += data.commissionByNumber;
                        ventanaCommissionByReventado += data.commissionByReventado;
                    }

                    if (isExcludedItem) totalExcluded++;
                }
            }

            // Ordenar vendedores: sin vendedorId primero, luego por nombre, luego por multiplicador
            vendedores.sort((a, b) => {
                if (a.vendedorId === null && b.vendedorId !== null) return -1;
                if (a.vendedorId !== null && b.vendedorId === null) return 1;
                const nameCompare = (a.vendedorName || "").localeCompare(b.vendedorName || "");
                if (nameCompare !== 0) return nameCompare;
                return (a.multiplierName || "").localeCompare(b.multiplierName || "");
            });

            // Si la ventana no tiene items (porque fueron filtrados), saltar
            if (vendedores.length === 0) {
                continue;
            }

            // Verificar si toda la ventana está excluida
            const ventanaExcluded = vendedores.every(v => v.isExcluded);

            listeros.push({
                ventanaId: ventanaData.ventanaId,
                ventanaName: ventanaData.ventanaName,
                ventanaCode: ventanaData.ventanaCode,
                totalSales: ventanaTotalSales,
                totalTickets: ventanaTotalTickets,
                totalCommission: ventanaTotalCommission,
                commissionByNumber: ventanaCommissionByNumber,
                commissionByReventado: ventanaCommissionByReventado,
                isExcluded: ventanaExcluded,
                exclusionId: null,
                exclusionReason: vendedores[0]?.exclusionReason || null,
                excludedAt: vendedores[0]?.excludedAt || null,
                excludedBy: vendedores[0]?.excludedBy || null,
                excludedByName: vendedores[0]?.excludedByName || null,
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
                listerosResult: listeros.length,
                totalExcluded,
                includeExcluded,
                vendedorIdFilter,
                multiplierIdFilter,
                message: "Resultado de getListas (con exclusión a nivel de jugada)"
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
    ): Promise<ExcludeIncludeResponse> {
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
        logger.info({
            layer: "service",
            action: "EXCLUDE_LISTA_VALIDATION",
            payload: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                message: "Validando ventanaId antes de exclusión"
            }
        });

        let ventana = await prisma.ventana.findUnique({
            where: { id: data.ventanaId },
            select: { id: true, name: true, isActive: true },
        });

        // Fallback: Si no se encuentra como ventana, buscar como usuario (Listero)
        if (!ventana) {
            logger.info({
                layer: "service",
                action: "EXCLUDE_LISTA_RETRY_USER",
                payload: {
                    ventanaId: data.ventanaId,
                    message: "Ventana no encontrada por ID, intentando buscar como Usuario (Listero)"
                }
            });

            const user = await prisma.user.findUnique({
                where: { id: data.ventanaId },
                select: {
                    id: true,
                    role: true,
                    ventanaId: true,
                    ventana: {
                        select: { id: true, name: true, isActive: true }
                    }
                }
            });

            if (user && user.role === 'VENTANA' && user.ventana) {
                ventana = user.ventana;
                // Actualizamos el ID para que el resto del flujo use el ID correcto de la ventana
                // IMPORTANTE: Esto asegura que la exclusión se guarde con el ID correcto de la ventana
                data.ventanaId = user.ventana.id;

                logger.info({
                    layer: "service",
                    action: "EXCLUDE_LISTA_RESOLVED_FROM_USER",
                    payload: {
                        originalId: user.id,
                        resolvedVentanaId: ventana.id,
                        message: "ID resuelto exitosamente desde usuario listero"
                    }
                });
            }
        }

        logger.info({
            layer: "service",
            action: "EXCLUDE_LISTA_VENTANA_FOUND",
            payload: {
                ventanaId: data.ventanaId,
                found: !!ventana,
                ventanaData: ventana,
                message: "Resultado de búsqueda de ventana (final)"
            }
        });

        if (!ventana) {
            logger.warn({
                layer: "service",
                action: "OPERATIONAL_ERROR",
                payload: {
                    message: "Ventana no encontrada (ni como ventana ni como usuario listero)",
                    ventanaId: data.ventanaId,
                    sorteoId
                }
            });
            throw new AppError("Ventana no encontrada", 404);
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

        // ✅ NUEVO: Actualizar jugadas Y tickets para marcarlos como excluidos
        // Construir el where para buscar las jugadas/tickets a excluir
        const ticketWhere: any = {
            sorteoId,
            ventanaId: data.ventanaId,
            deletedAt: null,
        };

        if (data.vendedorId) {
            ticketWhere.vendedorId = data.vendedorId;
        }

        // Si hay filtro de multiplicador, solo excluir tickets que tengan ese multiplicador
        if (data.multiplierId) {
            ticketWhere.jugadas = {
                some: {
                    multiplierId: data.multiplierId,
                    deletedAt: null,
                }
            };
        }

        // 1. Primero actualizar los tickets
        const ticketResult = await prisma.ticket.updateMany({
            where: {
                ...ticketWhere,
                status: { not: 'EXCLUDED' },
            },
            data: {
                status: 'EXCLUDED',
                isActive: false,
            },
        });

        // 2. Luego actualizar las jugadas
        const jugadaWhere: any = {
            deletedAt: null,
            isActive: true,
        };

        if (data.multiplierId) {
            jugadaWhere.multiplierId = data.multiplierId;
        }

        const jugadaResult = await prisma.jugada.updateMany({
            where: {
                ticket: {
                    sorteoId,
                    ventanaId: data.ventanaId,
                    vendedorId: data.vendedorId || undefined,
                    deletedAt: null,
                },
                ...jugadaWhere,
            },
            data: {
                isExcluded: true,
                isActive: false,
                excludedAt: new Date(),
                excludedBy: userId,
                excludedReason: data.reason || null,
            },
        });

        logger.info({
            layer: "service",
            action: "EXCLUDE_LISTA_SUCCESS",
            payload: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                multiplierId: data.multiplierId,
                ticketsExcluidos: ticketResult.count,
                jugadasExcluidas: jugadaResult.count,
                message: `${ticketResult.count} tickets y ${jugadaResult.count} jugadas marcados como excluidos`
            }
        });

        return {
            id: `excluded-${sorteoId}-${data.ventanaId}-${data.vendedorId || 'all'}-${data.multiplierId || 'all'}`,
            sorteoId,
            ventanaId: data.ventanaId,
            vendedorId: data.vendedorId || null,
            multiplierId: data.multiplierId || null,
            excludedAt: new Date().toISOString(),
            excludedBy: userId,
            reason: data.reason || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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

        // ✅ NUEVO: Actualizar jugadas Y tickets para desmarcarlos como excluidos
        const ticketWhere: any = {
            sorteoId,
            ventanaId: data.ventanaId,
            deletedAt: null,
        };

        if (data.vendedorId) {
            ticketWhere.vendedorId = data.vendedorId;
        }

        const jugadaWhere: any = {
            deletedAt: null,
            isExcluded: true, // Solo actualizar las que están excluidas
        };

        if (data.multiplierId) {
            jugadaWhere.multiplierId = data.multiplierId;
        }

        // 1. Actualizar jugadas
        const jugadaResult = await prisma.jugada.updateMany({
            where: {
                ticket: ticketWhere,
                ...jugadaWhere,
            },
            data: {
                isExcluded: false,
                isActive: true,
                excludedAt: null,
                excludedBy: null,
                excludedReason: null,
            },
        });

        if (jugadaResult.count === 0) {
            throw new AppError("No se encontraron jugadas excluidas que coincidan con los criterios", 404);
        }

        // 2. Buscar tickets que fueron afectados y restaurarlos si ya no tienen jugadas excluidas
        // Construir where para buscar tickets afectados
        const ticketRestoreWhere: any = {
            sorteoId,
            ventanaId: data.ventanaId,
            deletedAt: null,
            status: 'EXCLUDED',
        };

        if (data.vendedorId) {
            ticketRestoreWhere.vendedorId = data.vendedorId;
        }

        // Buscar tickets EXCLUDED que ya NO tienen jugadas excluidas
        const ticketsToRestore = await prisma.ticket.findMany({
            where: ticketRestoreWhere,
            select: {
                id: true,
                jugadas: {
                    where: {
                        deletedAt: null,
                        isExcluded: true,
                    },
                    select: { id: true }
                }
            }
        });

        // Filtrar solo los tickets que NO tienen jugadas excluidas restantes
        const ticketIdsToRestore = ticketsToRestore
            .filter(t => t.jugadas.length === 0)
            .map(t => t.id);

        let ticketResult = { count: 0 };
        if (ticketIdsToRestore.length > 0) {
            ticketResult = await prisma.ticket.updateMany({
                where: {
                    id: { in: ticketIdsToRestore },
                },
                data: {
                    status: 'ACTIVE',
                    isActive: true,
                },
            });
        }

        logger.info({
            layer: "service",
            action: "INCLUDE_LISTA_SUCCESS",
            payload: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                multiplierId: data.multiplierId,
                jugadasIncluidas: jugadaResult.count,
                ticketsRestaurados: ticketResult.count,
                message: `${jugadaResult.count} jugadas incluidas, ${ticketResult.count} tickets restaurados`
            }
        });

        return {
            success: true,
            message: `Exclusión revertida exitosamente (${jugadaResult.count} jugadas, ${ticketResult.count} tickets restaurados)`,
        };
    },

    /**
     * Obtiene todas las listas excluidas con filtros
     * GET /api/v1/listas-excluidas
     * ✅ NUEVO: Consulta jugadas excluidas agrupadas con información completa
     */
    async getExcludedListas(filters: {
        sorteoId?: string;
        ventanaId?: string;
        vendedorId?: string;
        multiplierId?: string;
        fromDate?: Date;
        toDate?: Date;
        loteriaId?: string;
    }): Promise<ListaExclusionResponse[]> {
        // Construir WHERE dinámico
        const ticketWhere: any = {
            deletedAt: null,
        };

        if (filters.sorteoId) {
            ticketWhere.sorteoId = filters.sorteoId;
        }

        if (filters.ventanaId) {
            ticketWhere.ventanaId = filters.ventanaId;
        }

        if (filters.vendedorId) {
            ticketWhere.vendedorId = filters.vendedorId;
        }

        if (filters.loteriaId) {
            ticketWhere.sorteo = {
                loteriaId: filters.loteriaId,
            };
        }

        // Filtro de fechas
        if (filters.fromDate || filters.toDate) {
            ticketWhere.createdAt = {};
            if (filters.fromDate) {
                ticketWhere.createdAt.gte = filters.fromDate;
            }
            if (filters.toDate) {
                ticketWhere.createdAt.lte = filters.toDate;
            }
        }

        const jugadaWhere: any = {
            deletedAt: null,
            isExcluded: true,
        };

        if (filters.multiplierId) {
            jugadaWhere.multiplierId = filters.multiplierId;
        }

        // Obtener jugadas excluidas con toda la información
        const excludedJugadas = await prisma.jugada.findMany({
            where: {
                ticket: ticketWhere,
                ...jugadaWhere,
            },
            select: {
                id: true,
                amount: true,
                multiplierId: true,
                excludedAt: true,
                excludedBy: true,
                excludedReason: true,
                ticket: {
                    select: {
                        sorteoId: true,
                        vendedorId: true,
                        ventanaId: true,
                        createdAt: true,
                        sorteo: {
                            select: {
                                name: true,
                                loteriaId: true,
                                loteria: {
                                    select: {
                                        name: true,
                                    },
                                },
                            },
                        },
                        ventana: {
                            select: {
                                name: true,
                                code: true,
                            },
                        },
                        vendedor: {
                            select: {
                                name: true,
                                code: true,
                            },
                        },
                    },
                },
                multiplier: {
                    select: {
                        id: true,
                        name: true,
                        valueX: true,
                    },
                },
                excludedByUser: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        // Agrupar por sorteo + ventana + vendedor + multiplier
        const grouped = new Map<string, {
            sorteoId: string;
            sorteoName: string;
            loteriaId: string;
            loteriaName: string;
            ventanaId: string;
            ventanaName: string;
            ventanaCode: string;
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null;
            multiplierId: string | null;
            multiplierName: string | null;
            multiplierValue: number | null;
            excludedAt: Date | null;
            excludedBy: string | null;
            excludedByName: string | null;
            reason: string | null;
            createdAt: Date | null;
            totalJugadas: number;
            totalAmount: number;
        }>();

        for (const jugada of excludedJugadas) {
            const key = `${jugada.ticket.sorteoId}:${jugada.ticket.ventanaId}:${jugada.ticket.vendedorId || 'null'}:${jugada.multiplierId || 'null'}`;

            if (!grouped.has(key)) {
                grouped.set(key, {
                    sorteoId: jugada.ticket.sorteoId,
                    sorteoName: jugada.ticket.sorteo.name,
                    loteriaId: jugada.ticket.sorteo.loteriaId,
                    loteriaName: jugada.ticket.sorteo.loteria.name,
                    ventanaId: jugada.ticket.ventanaId,
                    ventanaName: jugada.ticket.ventana.name,
                    ventanaCode: jugada.ticket.ventana.code,
                    vendedorId: jugada.ticket.vendedorId,
                    vendedorName: jugada.ticket.vendedor?.name || null,
                    vendedorCode: jugada.ticket.vendedor?.code || null,
                    multiplierId: jugada.multiplierId,
                    multiplierName: jugada.multiplier?.name || null,
                    multiplierValue: jugada.multiplier?.valueX || null,
                    excludedAt: jugada.excludedAt,
                    excludedBy: jugada.excludedBy,
                    excludedByName: jugada.excludedByUser?.name || null,
                    reason: jugada.excludedReason,
                    createdAt: jugada.ticket.createdAt,
                    totalJugadas: 0,
                    totalAmount: 0,
                });
            }

            const group = grouped.get(key)!;
            group.totalJugadas++;
            group.totalAmount += jugada.amount;
        }

        // Convertir a array de respuestas
        return Array.from(grouped.values()).map((ex) => ({
            id: `excluded-${ex.sorteoId}-${ex.ventanaId}-${ex.vendedorId || 'all'}-${ex.multiplierId || 'all'}`,
            sorteoId: ex.sorteoId,
            sorteoName: ex.sorteoName,
            loteriaId: ex.loteriaId,
            loteriaName: ex.loteriaName,
            ventanaId: ex.ventanaId,
            ventanaName: ex.ventanaName,
            ventanaCode: ex.ventanaCode,
            vendedorId: ex.vendedorId,
            vendedorName: ex.vendedorName,
            vendedorCode: ex.vendedorCode,
            multiplierId: ex.multiplierId,
            multiplierName: ex.multiplierName,
            multiplierValue: ex.multiplierValue,
            totalJugadas: ex.totalJugadas,
            totalAmount: ex.totalAmount,
            excludedAt: ex.excludedAt ? ex.excludedAt.toISOString() : null,
            excludedBy: ex.excludedBy,
            excludedByName: ex.excludedByName,
            reason: ex.reason,
            createdAt: ex.createdAt ? ex.createdAt.toISOString() : null,
            updatedAt: ex.excludedAt ? ex.excludedAt.toISOString() : null,
        }));
    },
};

export default SorteoListasService;
