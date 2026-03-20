import { SorteoStatus, Prisma } from "@prisma/client";
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
    SorteoInfo,
    ListaMode,
    CompactListeroSummary,
    MultiplierTotalSummary,
} from "../dto/sorteo-listas.dto";
import logger from "../../../core/logger";
import { invalidateExclusionListCache } from "../../../core/exclusionListCache";
import { formatIsoLocal } from "../../../utils/datetime";
import { CacheService } from "../../../core/cache.service";

interface SorteoListasRawResult {
    ventanaId: string;
    ventanaName: string;
    ventanaCode: string;
    vendedorId: string | null;
    vendedorName: string | null;
    vendedorCode: string | null;
    multiplierId: string | null;
    multiplierName: string | null;
    multiplierValue: number | null;
    totalSales: number;
    totalCommission: number;
    commissionByNumber: number;
    commissionByReventado: number;
    ticketCount: number;
    isExcluded: boolean;
    excludedAt: Date | null;
    excludedBy: string | null;
    excludedReason: string | null;
    excludedByName: string | null;
}

export const SorteoListasService = {
    /**
     * Obtiene el resumen de listas (ventanas/vendedores) con su estado de exclusión
     * GET /api/v1/sorteos/:id/listas
     *  NUEVA ESTRUCTURA: Agrupado por ventana con array de vendedores
     *  FILTROS: vendedorId, multiplierId
     */
    async getListas(
        sorteoId: string,
        includeExcluded: boolean = true,
        vendedorIdFilter?: string,
        multiplierIdFilter?: string,
        mode: ListaMode = "full"
    ): Promise<ListasResponse> {
        const startTime = Date.now();

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

        // 2. Consulta SQL Consolidada ($queryRaw)
        // ⚠️ USAMOS SQL RAW PARA MÁXIMO RENDIMIENTO (delegamos agregación a DB)
        const rawResults = await prisma.$queryRaw<SorteoListasRawResult[]>`
            SELECT 
                v.id as "ventanaId", v.name as "ventanaName", v.code as "ventanaCode",
                u.id as "vendedorId", u.name as "vendedorName", u.code as "vendedorCode",
                m.id as "multiplierId", m.name as "multiplierName", m."valueX" as "multiplierValue",
                COALESCE(SUM(j.amount), 0)::FLOAT as "totalSales",
                COALESCE(SUM(j."listeroCommissionAmount"), 0)::FLOAT as "totalCommission",
                COALESCE(SUM(CASE WHEN j."type" = 'NUMERO' THEN j."listeroCommissionAmount" ELSE 0 END), 0)::FLOAT as "commissionByNumber",
                COALESCE(SUM(CASE WHEN j."type" = 'REVENTADO' THEN j."listeroCommissionAmount" ELSE 0 END), 0)::FLOAT as "commissionByReventado",
                COUNT(DISTINCT j."ticketId")::INT as "ticketCount",
                BOOL_OR(j."isExcluded") as "isExcluded",
                MAX(j."excludedAt") as "excludedAt",
                MAX(j."excludedBy"::text) as "excludedBy",
                MAX(j."excludedReason") as "excludedReason",
                MAX(u_ex.name) as "excludedByName"
            FROM "Jugada" j
            JOIN "Ticket" t ON j."ticketId" = t.id
            JOIN "Ventana" v ON t."ventanaId" = v.id
            LEFT JOIN "User" u ON t."vendedorId" = u.id
            LEFT JOIN "User" u_ex ON j."excludedBy" = u_ex.id
            -- Relación para encontrar el multiplicador base (importante para REVENTADO)
            LEFT JOIN "LoteriaMultiplier" m ON (
                CASE 
                    WHEN j."type" = 'NUMERO' THEN j."multiplierId"
                    WHEN j."type" = 'REVENTADO' THEN (
                        SELECT j2."multiplierId" 
                        FROM "Jugada" j2 
                        WHERE j2."ticketId" = j."ticketId" 
                          AND j2."number" = j."number" 
                          AND j2."type" = 'NUMERO'
                          AND j2."deletedAt" IS NULL
                        LIMIT 1
                    )
                END
            ) = m.id
            WHERE t."sorteoId" = CAST(${sorteoId} AS uuid)
              AND t."deletedAt" IS NULL
              AND j."deletedAt" IS NULL
              AND j."isActive" = TRUE
              AND (CAST(${includeExcluded} AS boolean) = TRUE OR j."isExcluded" = FALSE)
              AND (CAST(${vendedorIdFilter || null} AS uuid) IS NULL OR t."vendedorId" = CAST(${vendedorIdFilter} AS uuid))
              AND (CAST(${multiplierIdFilter || null} AS uuid) IS NULL OR j."multiplierId" = CAST(${multiplierIdFilter} AS uuid))
            GROUP BY 
                v.id, v.name, v.code,
                u.id, u.name, u.code,
                m.id, m.name, m."valueX"
        `;

        // 3. Cargar registros de exclusión de la tabla (fuente de verdad para exclusionScope)
        const exclusionRecords = await prisma.sorteoListaExclusion.findMany({
            where: { sorteoId },
            select: { id: true, ventanaId: true, vendedorId: true, multiplierId: true },
        });

        // 4. Liberación de conexión implícita (después de queries), proceso en memoria
        const ventanaLevelExclusions = new Map<string, { id: string; multiplierId: string | null }[]>();
        const vendedorLevelExclusions = new Map<string, { id: string; ventanaId: string; multiplierId: string | null }[]>();

        for (const rec of exclusionRecords) {
            if (rec.vendedorId === null) {
                if (!ventanaLevelExclusions.has(rec.ventanaId)) ventanaLevelExclusions.set(rec.ventanaId, []);
                ventanaLevelExclusions.get(rec.ventanaId)!.push({ id: rec.id, multiplierId: rec.multiplierId });
            } else {
                if (!vendedorLevelExclusions.has(rec.vendedorId)) vendedorLevelExclusions.set(rec.vendedorId, []);
                vendedorLevelExclusions.get(rec.vendedorId)!.push({ id: rec.id, ventanaId: rec.ventanaId, multiplierId: rec.multiplierId });
            }
        }

        // 5. Mapeo a estructura jerárquica (JSON Parity)
        const listeros: ListeroSummary[] = [];
        const listerosCompact: CompactListeroSummary[] = [];
        let totalSalesGlobal = 0;
        let totalTicketsGlobal = 0;
        let totalCommissionGlobal = 0;
        let totalExcluded = 0;

        // Agrupar resultados por ventana
        const ventanasMap = new Map<string, {
            ventanaId: string;
            ventanaName: string;
            ventanaCode: string;
            rows: SorteoListasRawResult[];
        }>();

        for (const row of rawResults) {
            if (!ventanasMap.has(row.ventanaId)) {
                ventanasMap.set(row.ventanaId, {
                    ventanaId: row.ventanaId,
                    ventanaName: row.ventanaName,
                    ventanaCode: row.ventanaCode,
                    rows: [],
                });
            }
            ventanasMap.get(row.ventanaId)!.rows.push(row);
        }

        for (const [ventanaId, ventanaData] of ventanasMap.entries()) {
            const vendedores: VendedorSummary[] = [];
            const multiplierTotals = new Map<string, MultiplierTotalSummary>();
            let ventanaTotalSales = 0;
            let ventanaTotalTickets = 0;
            let ventanaTotalCommission = 0;
            let ventanaCommissionByNumber = 0;
            let ventanaCommissionByReventado = 0;
            let ventanaExcludedCount = 0;

            // Agrupar filas por vendedor
            const entriesByVendor = new Map<string, SorteoListasRawResult[]>();
            for (const row of ventanaData.rows) {
                const vKey = row.vendedorId || "null";
                if (!entriesByVendor.has(vKey)) entriesByVendor.set(vKey, []);
                entriesByVendor.get(vKey)!.push(row);
            }

            for (const [vKey, entries] of entriesByVendor.entries()) {
                const allExcluded = entries.every(e => e.isExcluded);
                
                // Si no incluimos excluidos y todas están excluidas, saltar
                if (!includeExcluded && allExcluded) continue;

                // CASO 1: Vendedor totalmente excluido -> COLAPSAR
                if (allExcluded && includeExcluded) {
                    let collapsedSales = 0;
                    let collapsedCommission = 0;
                    let collapsedCommissionNumber = 0;
                    let collapsedCommissionReventado = 0;
                    let collapsedTicketsCount = 0;
                    const first = entries[0];

                    for (const entry of entries) {
                        collapsedSales += entry.totalSales;
                        collapsedCommission += entry.totalCommission;
                        collapsedCommissionNumber += entry.commissionByNumber;
                        collapsedCommissionReventado += entry.commissionByReventado;
                        collapsedTicketsCount += entry.ticketCount;
                    }

                    // Determinar exclusionScope
                    let collapsedScope: 'ventana' | 'vendedor' | null = null;
                    let collapsedRecordId: string | null = null;
                    const ventanaMatches = ventanaLevelExclusions.get(ventanaId) || [];
                    const ventanaMatch = ventanaMatches.find(e => e.multiplierId === null);
                    if (ventanaMatch) {
                        collapsedScope = 'ventana';
                        collapsedRecordId = ventanaMatch.id;
                    } else if (first.vendedorId) {
                        const vendedorMatches = vendedorLevelExclusions.get(first.vendedorId) || [];
                        const vendedorMatch = vendedorMatches.find(e => e.ventanaId === ventanaId && e.multiplierId === null);
                        if (vendedorMatch) {
                            collapsedScope = 'vendedor';
                            collapsedRecordId = vendedorMatch.id;
                        }
                    }

                    vendedores.push({
                        vendedorId: first.vendedorId,
                        vendedorName: first.vendedorName,
                        vendedorCode: first.vendedorCode,
                        multiplierId: null,
                        multiplierName: "Todos (Excluido)",
                        multiplierValue: null,
                        totalSales: collapsedSales,
                        totalTickets: collapsedTicketsCount,
                        totalCommission: collapsedCommission,
                        commissionByNumber: collapsedCommissionNumber,
                        commissionByReventado: collapsedCommissionReventado,
                        isExcluded: true,
                        exclusionId: null,
                        exclusionReason: first.excludedReason,
                        excludedAt: first.excludedAt ? first.excludedAt.toISOString() : null,
                        excludedBy: first.excludedBy,
                        excludedByName: first.excludedByName,
                        exclusionScope: collapsedScope,
                        exclusionRecordId: collapsedRecordId,
                    });

                    totalExcluded++;
                    ventanaExcludedCount++;

                    // Acumular totales compactos (por multiplicador original)
                    for (const entry of entries) {
                        const mKey = entry.multiplierId || "null";
                        if (!multiplierTotals.has(mKey)) {
                            multiplierTotals.set(mKey, {
                                multiplierId: entry.multiplierId,
                                multiplierName: entry.multiplierName,
                                multiplierValue: entry.multiplierValue,
                                totalSales: 0,
                                totalCommission: 0,
                                totalTickets: 0,
                                totalExcluded: 0,
                            });
                        }
                        const agg = multiplierTotals.get(mKey)!;
                        agg.totalSales += entry.totalSales;
                        agg.totalCommission += entry.totalCommission;
                        agg.totalExcluded += 1;
                    }
                    continue;
                }

                // CASO 2: Procesar individualmente
                for (const row of entries) {
                    if (!includeExcluded && row.isExcluded) continue;

                    let itemScope: 'ventana' | 'vendedor' | null = null;
                    let itemRecordId: string | null = null;
                    if (row.isExcluded) {
                        const ventanaMatches = ventanaLevelExclusions.get(ventanaId) || [];
                        const ventanaMatch = ventanaMatches.find(e => e.multiplierId === null || e.multiplierId === row.multiplierId);
                        if (ventanaMatch) {
                            itemScope = 'ventana';
                            itemRecordId = ventanaMatch.id;
                        } else if (row.vendedorId) {
                            const vendedorMatches = vendedorLevelExclusions.get(row.vendedorId) || [];
                            const vendedorMatch = vendedorMatches.find(e => e.ventanaId === ventanaId && (e.multiplierId === null || e.multiplierId === row.multiplierId));
                            if (vendedorMatch) {
                                itemScope = 'vendedor';
                                itemRecordId = vendedorMatch.id;
                            }
                        }
                    }

                    vendedores.push({
                        vendedorId: row.vendedorId,
                        vendedorName: row.vendedorName,
                        vendedorCode: row.vendedorCode,
                        multiplierId: row.multiplierId,
                        multiplierName: row.multiplierName,
                        multiplierValue: row.multiplierValue,
                        totalSales: row.totalSales,
                        totalTickets: row.ticketCount,
                        totalCommission: row.totalCommission,
                        commissionByNumber: row.commissionByNumber,
                        commissionByReventado: row.commissionByReventado,
                        isExcluded: row.isExcluded,
                        exclusionId: null,
                        exclusionReason: row.excludedReason,
                        excludedAt: row.excludedAt ? row.excludedAt.toISOString() : null,
                        excludedBy: row.excludedBy,
                        excludedByName: row.excludedByName,
                        exclusionScope: itemScope,
                        exclusionRecordId: itemRecordId,
                    });

                    if (!row.isExcluded) {
                        ventanaTotalSales += row.totalSales;
                        ventanaTotalTickets += row.ticketCount; 
                        ventanaTotalCommission += row.totalCommission;
                        ventanaCommissionByNumber += row.commissionByNumber;
                        ventanaCommissionByReventado += row.commissionByReventado;
                    } else {
                        totalExcluded++;
                        ventanaExcludedCount++;
                    }

                    // Acumular totales compactos
                    const mKey = row.multiplierId || "null";
                    if (!multiplierTotals.has(mKey)) {
                        multiplierTotals.set(mKey, {
                            multiplierId: row.multiplierId,
                            multiplierName: row.multiplierName,
                            multiplierValue: row.multiplierValue,
                            totalSales: 0,
                            totalCommission: 0,
                            totalTickets: 0,
                            totalExcluded: 0,
                        });
                    }
                    const agg = multiplierTotals.get(mKey)!;
                    agg.totalSales += row.totalSales;
                    agg.totalCommission += row.totalCommission;
                    if (row.isExcluded) agg.totalExcluded += 1;
                    else agg.totalTickets += row.ticketCount;
                }
            }

            if (vendedores.length === 0) continue;

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
                vendedores: vendedores.sort((a, b) => {
                    if (a.vendedorId === null && b.vendedorId !== null) return -1;
                    if (a.vendedorId !== null && b.vendedorId === null) return 1;
                    const nameCompare = (a.vendedorName || "").localeCompare(b.vendedorName || "");
                    if (nameCompare !== 0) return nameCompare;
                    return (a.multiplierName || "").localeCompare(b.multiplierName || "");
                }),
            });

            const totalsByMultiplier: MultiplierTotalSummary[] = Array.from(multiplierTotals.values())
                .sort((a, b) => {
                    if (a.multiplierValue !== null && b.multiplierValue !== null) return b.multiplierValue - a.multiplierValue;
                    if (a.multiplierName && b.multiplierName) return a.multiplierName.localeCompare(b.multiplierName);
                    return 0;
                });

            listerosCompact.push({
                ventanaId: ventanaData.ventanaId,
                ventanaName: ventanaData.ventanaName,
                ventanaCode: ventanaData.ventanaCode,
                totalSales: ventanaTotalSales,
                totalTickets: ventanaTotalTickets,
                totalCommission: ventanaTotalCommission,
                totalExcluded: ventanaExcludedCount,
                totalsByMultiplier,
            });

            totalSalesGlobal += ventanaTotalSales;
            totalTicketsGlobal += ventanaTotalTickets;
            totalCommissionGlobal += ventanaTotalCommission;
        }

        const response: ListasResponse = {
            sorteo: {
                id: sorteo.id,
                name: sorteo.name,
                status: sorteo.status,
                scheduledAt: formatIsoLocal(sorteo.scheduledAt),
                winningNumber: sorteo.winningNumber,
                loteria: sorteo.loteria,
            },
            listeros: mode === "compact" ? [] : listeros.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName)),
            ...(mode === "compact" ? { listerosCompact } : {}),
            mode,
            meta: {
                totalSales: totalSalesGlobal,
                totalTickets: totalTicketsGlobal,
                totalCommission: totalCommissionGlobal,
                totalExcluded,
            },
            refreshedAt: new Date().toISOString(),
        };

        const duration = Date.now() - startTime;
        logger.info({
            layer: "service",
            action: "SORTEO_LISTAS_GET_OPTIMIZED",
            payload: {
                sorteoId,
                durationMs: duration,
                aggregateRows: rawResults.length,
                totalSales: totalSalesGlobal,
                message: `getListas optimizado finalizado en ${duration}ms`
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

        //  PASO 1: Crear registro en sorteo_lista_exclusion (tabla de auditoría)
        // Buscar registro existente
        const existingRecord = await prisma.sorteoListaExclusion.findFirst({
            where: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId || null,
                multiplierId: data.multiplierId || null,
            },
        });

        let exclusionRecord;
        if (existingRecord) {
            // Actualizar registro existente
            exclusionRecord = await prisma.sorteoListaExclusion.update({
                where: { id: existingRecord.id },
                data: {
                    excludedAt: new Date(),
                    excludedBy: userId,
                    reason: data.reason || null,
                },
            });
        } else {
            // Crear nuevo registro
            exclusionRecord = await prisma.sorteoListaExclusion.create({
                data: {
                    sorteoId,
                    ventanaId: data.ventanaId,
                    vendedorId: data.vendedorId || null,
                    multiplierId: data.multiplierId || null,
                    excludedBy: userId,
                    reason: data.reason || null,
                },
            });
        }

        logger.info({
            layer: "service",
            action: "EXCLUDE_LISTA_TABLE_RECORD",
            payload: {
                exclusionRecordId: exclusionRecord.id,
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                multiplierId: data.multiplierId,
                message: "Registro creado/actualizado en sorteo_lista_exclusion"
            }
        });

        // Invalidar cache — la tabla ya no está vacía
        invalidateExclusionListCache();
        
        //  NUEVO: Invalidar cache de reportes de cierre para que reflejen el cambio
        CacheService.invalidateTag('cierre').catch(err => 
            logger.warn({ layer: 'service', action: 'CACHE_INVALIDATE_ERROR', payload: { tag: 'cierre', error: err.message } })
        );

        //  PASO 2: Actualizar jugadas Y tickets para marcarlos como excluidos (marcado denormalizado)
        // Construir el where para buscar las jugadas/tickets a excluir
        const ticketWhere: any = {
            sorteoId,
            ventanaId: data.ventanaId,
            deletedAt: null,
        };

        if (data.vendedorId) {
            ticketWhere.vendedorId = data.vendedorId;
        }

        //  CRÍTICO: Si hay filtro de multiplicador, NO marcamos tickets como EXCLUDED automáticamente
        // porque solo algunas jugadas se excluyen. Los tickets se actualizarán después si todas sus jugadas quedan excluidas.
        // Si NO hay filtro de multiplicador, excluimos todos los tickets del scope.
        let ticketResult = { count: 0 };

        if (!data.multiplierId) {
            // Sin filtro de multiplicador: excluir todos los tickets del scope
            ticketResult = await prisma.ticket.updateMany({
                where: {
                    ...ticketWhere,
                    status: { not: 'EXCLUDED' },
                },
                data: {
                    status: 'EXCLUDED',
                    isActive: false,
                },
            });
        }
        // Si hay multiplierId, no actualizamos tickets aquí, se hará después si todas las jugadas quedan excluidas

        // 2. Luego actualizar las jugadas
        //  CRÍTICO: Si se especifica multiplierId, debemos excluir:
        // - Jugadas NUMERO con ese multiplierId directamente
        // - Jugadas REVENTADO con ese multiplierId directamente (si el sorteo ya fue evaluado)
        // - Jugadas REVENTADO que heredan el multiplicador base (número base con jugada NUMERO del mismo ticket con ese multiplierId)
        let jugadaResult = { count: 0 };

        if (data.multiplierId) {
            // Buscar tickets afectados primero
            const affectedTickets = await prisma.ticket.findMany({
                where: {
                    sorteoId,
                    ventanaId: data.ventanaId,
                    vendedorId: data.vendedorId || undefined,
                    deletedAt: null,
                },
                select: {
                    id: true,
                    jugadas: {
                        where: {
                            deletedAt: null,
                            isActive: true,
                        },
                        select: {
                            id: true,
                            type: true,
                            number: true,
                            multiplierId: true,
                        },
                    },
                },
            });

            // Identificar jugadas a excluir:
            // 1. Jugadas NUMERO con multiplierId
            // 2. Jugadas REVENTADO con multiplierId directo
            // 3. Jugadas REVENTADO cuyo número base tiene una jugada NUMERO con ese multiplierId en el mismo ticket
            const jugadaIdsToExclude = new Set<string>();

            for (const ticket of affectedTickets) {
                // Crear mapa de número base -> multiplierId para jugadas NUMERO
                const numeroBaseMultiplierMap = new Map<string, string>();
                for (const jugada of ticket.jugadas) {
                    if (jugada.type === 'NUMERO' && jugada.number && jugada.multiplierId === data.multiplierId) {
                        numeroBaseMultiplierMap.set(jugada.number, jugada.multiplierId!);
                        jugadaIdsToExclude.add(jugada.id);
                    }
                }

                // Buscar jugadas REVENTADO que deben excluirse
                for (const jugada of ticket.jugadas) {
                    if (jugada.type === 'REVENTADO') {
                        // Caso 1: REVENTADO con multiplierId directo
                        if (jugada.multiplierId === data.multiplierId) {
                            jugadaIdsToExclude.add(jugada.id);
                        }
                        // Caso 2: REVENTADO que hereda el multiplicador base
                        else if (jugada.number && numeroBaseMultiplierMap.has(jugada.number)) {
                            jugadaIdsToExclude.add(jugada.id);
                        }
                    }
                }
            }

            // Actualizar todas las jugadas identificadas
            if (jugadaIdsToExclude.size > 0) {
                jugadaResult = await prisma.jugada.updateMany({
                    where: {
                        id: { in: Array.from(jugadaIdsToExclude) },
                    },
                    data: {
                        isExcluded: true,
                        isActive: false,
                        excludedAt: new Date(),
                        excludedBy: userId,
                        excludedReason: data.reason || null,
                    },
                });

                //  CRÍTICO: Si hay filtro de multiplicador, verificar tickets que quedaron con todas sus jugadas excluidas
                // y marcarlos como EXCLUDED
                const ticketIdsToCheck = new Set(affectedTickets.map(t => t.id));
                if (ticketIdsToCheck.size > 0) {
                    // Buscar tickets que tienen todas sus jugadas excluidas
                    const ticketsWithAllExcluded = await prisma.ticket.findMany({
                        where: {
                            id: { in: Array.from(ticketIdsToCheck) },
                            deletedAt: null,
                        },
                        select: {
                            id: true,
                            jugadas: {
                                where: {
                                    deletedAt: null,
                                    isActive: true,
                                    isExcluded: false,
                                },
                                select: { id: true },
                            },
                        },
                    });

                    // Tickets sin jugadas activas no excluidas = todas excluidas
                    const ticketIdsToExclude = ticketsWithAllExcluded
                        .filter(t => t.jugadas.length === 0)
                        .map(t => t.id);

                    if (ticketIdsToExclude.length > 0) {
                        await prisma.ticket.updateMany({
                            where: {
                                id: { in: ticketIdsToExclude },
                            },
                            data: {
                                status: 'EXCLUDED',
                                isActive: false,
                            },
                        });
                        ticketResult = { count: ticketIdsToExclude.length };
                    }
                }
            }
        } else {
            // Sin filtro de multiplicador: excluir todas las jugadas del scope
            const jugadaWhere: any = {
                deletedAt: null,
                isActive: true,
            };

            jugadaResult = await prisma.jugada.updateMany({
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
        }

        logger.info({
            layer: "service",
            action: "EXCLUDE_LISTA_SUCCESS",
            payload: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                multiplierId: data.multiplierId,
                exclusionRecordId: exclusionRecord.id,
                ticketsExcluidos: ticketResult.count,
                jugadasExcluidas: jugadaResult.count,
                message: `Exclusión completa: registro en tabla + ${ticketResult.count} tickets y ${jugadaResult.count} jugadas marcados`
            }
        });

        return {
            id: exclusionRecord.id, // Usar el ID real de la tabla
            sorteoId,
            ventanaId: data.ventanaId,
            vendedorId: data.vendedorId || null,
            multiplierId: data.multiplierId || null,
            excludedAt: exclusionRecord.excludedAt.toISOString(),
            excludedBy: userId,
            reason: data.reason || null,
            createdAt: exclusionRecord.createdAt.toISOString(),
            updatedAt: exclusionRecord.updatedAt.toISOString(),
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
        logger.info({
            layer: "service",
            action: "INCLUDE_LISTA_REQUEST",
            payload: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId ?? null,
                multiplierId: data.multiplierId ?? null,
            }
        });

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

        // Resolver ventanaId igual que en excludeLista: el cliente puede mandar
        // un Ventana.id o un User.id (listero); normalizamos a Ventana.id
        let ventanaInclude = await prisma.ventana.findUnique({
            where: { id: data.ventanaId },
            select: { id: true },
        });

        if (!ventanaInclude) {
            const user = await prisma.user.findUnique({
                where: { id: data.ventanaId },
                select: { role: true, ventana: { select: { id: true } } },
            });
            if (user?.role === 'VENTANA' && user.ventana) {
                ventanaInclude = user.ventana;
                data.ventanaId = user.ventana.id;
            }
        }

        if (!ventanaInclude) {
            throw new AppError("Ventana no encontrada", 404);
        }

        //  PASO 1: Eliminar registro de sorteo_lista_exclusion (tabla de auditoría)
        const deletedRecord = await prisma.sorteoListaExclusion.deleteMany({
            where: {
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId || null,
                multiplierId: data.multiplierId || null,
            },
        });

        if (deletedRecord.count === 0) {
            throw new AppError("No se encontró un registro de exclusión que coincida con los criterios", 404);
        }

        logger.info({
            layer: "service",
            action: "INCLUDE_LISTA_TABLE_RECORD",
            payload: {
                deletedCount: deletedRecord.count,
                sorteoId,
                ventanaId: data.ventanaId,
                vendedorId: data.vendedorId,
                multiplierId: data.multiplierId,
                message: "Registro eliminado de sorteo_lista_exclusion"
            }
        });

        // Invalidar cache — la tabla puede haber quedado vacía
        invalidateExclusionListCache();

        //  NUEVO: Invalidar cache de reportes de cierre para que reflejen el cambio
        CacheService.invalidateTag('cierre').catch(err => 
            logger.warn({ layer: 'service', action: 'CACHE_INVALIDATE_ERROR', payload: { tag: 'cierre', error: err.message } })
        );

        //  PASO 2: Actualizar jugadas Y tickets para desmarcarlos como excluidos (marcado denormalizado)
        const ticketWhere: any = {
            sorteoId,
            ventanaId: data.ventanaId,
            deletedAt: null,
        };

        if (data.vendedorId) {
            ticketWhere.vendedorId = data.vendedorId;
        }

        //  CRÍTICO: Si se especifica multiplierId, debemos incluir (revertir exclusión):
        // - Jugadas NUMERO con ese multiplierId directamente
        // - Jugadas REVENTADO con ese multiplierId directamente (si el sorteo ya fue evaluado)
        // - Jugadas REVENTADO que heredan el multiplicador base (número base con jugada NUMERO del mismo ticket con ese multiplierId)
        let jugadaResult = { count: 0 };

        if (data.multiplierId) {
            // Buscar tickets afectados primero
            const affectedTickets = await prisma.ticket.findMany({
                where: ticketWhere,
                select: {
                    id: true,
                    jugadas: {
                        where: {
                            deletedAt: null,
                            isExcluded: true, // Solo las excluidas
                        },
                        select: {
                            id: true,
                            type: true,
                            number: true,
                            multiplierId: true,
                        },
                    },
                },
            });

            // Identificar jugadas a incluir (revertir exclusión):
            // 1. Jugadas NUMERO con multiplierId
            // 2. Jugadas REVENTADO con multiplierId directo
            // 3. Jugadas REVENTADO cuyo número base tiene una jugada NUMERO con ese multiplierId en el mismo ticket
            const jugadaIdsToInclude = new Set<string>();

            for (const ticket of affectedTickets) {
                // Crear mapa de número base -> multiplierId para jugadas NUMERO
                const numeroBaseMultiplierMap = new Map<string, string>();
                for (const jugada of ticket.jugadas) {
                    if (jugada.type === 'NUMERO' && jugada.number && jugada.multiplierId === data.multiplierId) {
                        numeroBaseMultiplierMap.set(jugada.number, jugada.multiplierId!);
                        jugadaIdsToInclude.add(jugada.id);
                    }
                }

                // Buscar jugadas REVENTADO que deben incluirse
                for (const jugada of ticket.jugadas) {
                    if (jugada.type === 'REVENTADO') {
                        // Caso 1: REVENTADO con multiplierId directo
                        if (jugada.multiplierId === data.multiplierId) {
                            jugadaIdsToInclude.add(jugada.id);
                        }
                        // Caso 2: REVENTADO que hereda el multiplicador base
                        else if (jugada.number && numeroBaseMultiplierMap.has(jugada.number)) {
                            jugadaIdsToInclude.add(jugada.id);
                        }
                    }
                }
            }

            // Actualizar todas las jugadas identificadas
            if (jugadaIdsToInclude.size > 0) {
                jugadaResult = await prisma.jugada.updateMany({
                    where: {
                        id: { in: Array.from(jugadaIdsToInclude) },
                    },
                    data: {
                        isExcluded: false,
                        isActive: true,
                        excludedAt: null,
                        excludedBy: null,
                        excludedReason: null,
                    },
                });
            }
        } else {
            // Sin filtro de multiplicador: incluir todas las jugadas excluidas del scope
            const jugadaWhere: any = {
                deletedAt: null,
                isExcluded: true, // Solo actualizar las que están excluidas
            };

            jugadaResult = await prisma.jugada.updateMany({
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
        }

        // Nota: No lanzamos error si jugadaResult.count === 0 porque el registro puede haber sido
        // eliminado antes de que hubiera jugadas (por ejemplo, exclusión preventiva)

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
     *
     * Lee directamente de sorteo_lista_exclusion (fuente de verdad de las reglas).
     * El vendedorId de cada registro refleja exactamente lo que se debe mandar en /include:
     *   null    → la ventana completa fue excluida
     *   UUID    → un vendedor específico fue excluido
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
        // Construir WHERE sobre la tabla de exclusiones
        const exclusionWhere: any = {};

        if (filters.sorteoId) {
            exclusionWhere.sorteoId = filters.sorteoId;
        }

        if (filters.ventanaId) {
            exclusionWhere.ventanaId = filters.ventanaId;
        }

        if (filters.vendedorId) {
            exclusionWhere.vendedorId = filters.vendedorId;
        }

        if (filters.multiplierId) {
            exclusionWhere.multiplierId = filters.multiplierId;
        }

        if (filters.loteriaId) {
            exclusionWhere.sorteo = { loteriaId: filters.loteriaId };
        }

        // fromDate/toDate se aplican sobre excludedAt del registro
        if (filters.fromDate || filters.toDate) {
            exclusionWhere.excludedAt = {};
            if (filters.fromDate) exclusionWhere.excludedAt.gte = filters.fromDate;
            if (filters.toDate)   exclusionWhere.excludedAt.lte = filters.toDate;
        }

        const exclusionRecords = await prisma.sorteoListaExclusion.findMany({
            where: exclusionWhere,
            select: {
                id: true,
                sorteoId: true,
                ventanaId: true,
                vendedorId: true,
                multiplierId: true,
                excludedAt: true,
                excludedBy: true,
                reason: true,
                createdAt: true,
                updatedAt: true,
                sorteo: {
                    select: {
                        name: true,
                        loteriaId: true,
                        loteria: { select: { name: true } },
                    },
                },
                ventana: {
                    select: { name: true, code: true },
                },
                vendedor: {
                    select: { name: true, code: true },
                },
                multiplier: {
                    select: { name: true, valueX: true },
                },
                excludedByUser: {
                    select: { name: true },
                },
            },
            orderBy: { excludedAt: 'desc' },
        });

        if (exclusionRecords.length === 0) {
            return [];
        }

        // Calcular totalJugadas / totalAmount agrupando las jugadas excluidas del sorteo
        // Clave: ventanaId:vendedorId|null:multiplierId|null
        const jugadaTotals = new Map<string, { totalJugadas: number; totalAmount: number }>();

        const jugadaTicketWhere: any = { deletedAt: null };
        if (filters.sorteoId) jugadaTicketWhere.sorteoId = filters.sorteoId;
        if (filters.ventanaId) jugadaTicketWhere.ventanaId = filters.ventanaId;
        if (filters.vendedorId) jugadaTicketWhere.vendedorId = filters.vendedorId;

        const rawJugadas = await prisma.jugada.findMany({
            where: {
                ticket: jugadaTicketWhere,
                isExcluded: true,
                deletedAt: null,
                ...(filters.multiplierId ? { multiplierId: filters.multiplierId } : {}),
            },
            select: {
                amount: true,
                multiplierId: true,
                ticket: { select: { ventanaId: true, vendedorId: true } },
            },
        });

        for (const j of rawJugadas) {
            // Clave para exclusiones de vendedor específico
            const keyVendedor = `${j.ticket.ventanaId}:${j.ticket.vendedorId || 'null'}:${j.multiplierId || 'null'}`;
            // Clave para exclusiones de ventana completa (vendedorId null)
            const keyVentana = `${j.ticket.ventanaId}:null:${j.multiplierId || 'null'}`;

            for (const key of [keyVendedor, keyVentana]) {
                const existing = jugadaTotals.get(key);
                if (existing) {
                    existing.totalJugadas++;
                    existing.totalAmount += j.amount;
                } else {
                    jugadaTotals.set(key, { totalJugadas: 1, totalAmount: j.amount });
                }
            }
        }

        return exclusionRecords.map((ex) => {
            // La clave de lookup depende del registro: si vendedorId es null → clave de ventana
            const lookupKey = `${ex.ventanaId}:${ex.vendedorId || 'null'}:${ex.multiplierId || 'null'}`;
            const totals = jugadaTotals.get(lookupKey) || { totalJugadas: 0, totalAmount: 0 };

            return {
                id: ex.id,
                sorteoId: ex.sorteoId,
                sorteoName: ex.sorteo.name,
                loteriaId: ex.sorteo.loteriaId,
                loteriaName: ex.sorteo.loteria.name,
                ventanaId: ex.ventanaId,
                ventanaName: ex.ventana.name,
                ventanaCode: ex.ventana.code,
                vendedorId: ex.vendedorId,
                vendedorName: ex.vendedor?.name || null,
                vendedorCode: ex.vendedor?.code || null,
                multiplierId: ex.multiplierId,
                multiplierName: ex.multiplier?.name || null,
                multiplierValue: ex.multiplier?.valueX || null,
                totalJugadas: totals.totalJugadas,
                totalAmount: totals.totalAmount,
                excludedAt: ex.excludedAt.toISOString(),
                excludedBy: ex.excludedBy,
                excludedByName: ex.excludedByUser?.name || null,
                reason: ex.reason,
                createdAt: ex.createdAt.toISOString(),
                updatedAt: ex.updatedAt.toISOString(),
            };
        });
    },
};

export default SorteoListasService;
