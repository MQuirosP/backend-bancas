import { Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { resolveCommission } from "../../../../services/commission.resolver";
import { resolveCommissionFromPolicy } from "../../../../services/commission/commission.resolver";
import { toCRDateString, buildTicketDateFilter } from "./accounts.dates.utils";

/**
 * ✅ OPTIMIZACIÓN: Lee resúmenes diarios de la vista materializada
 * Retorna un Map<dateKey, { ventanaId, vendedorId, ticket_count, total_sales, ... }>
 */
export async function getDailySummariesFromMaterializedView(
    startDate: Date,
    endDate: Date,
    dimension: "ventana" | "vendedor",
    ventanaId: string | undefined,
    vendedorId: string | undefined,
    sort: "asc" | "desc" = "desc"
): Promise<Map<string, {
    date: Date;
    ventanaId: string | null;
    vendedorId: string | null;
    ticket_count: number;
    total_sales: number;
    total_payouts: number;
    vendedor_commission: number;
    listero_commission: number;
    balance: number;
}>> {
    try {
        // ⚠️ CRÍTICO: Convertir fechas UTC a fechas CR antes de usar en SQL
        // startDate y endDate son instantes UTC que representan días en CR
        // NO usar toISOString().split('T')[0] directamente (extrae fecha UTC, no CR)
        const startDateCR = toCRDateString(startDate);
        const endDateCR = toCRDateString(endDate);

        // ⚠️ CRÍTICO: Usar límite exclusivo para excluir el inicio del día siguiente
        // endDate representa el fin del último día incluido (ej: 2025-11-20T05:59:59.999Z = fin del 19 en CR)
        // Para excluir datos del día siguiente, usar el día siguiente (exclusivo) en SQL
        // Si endDateCR es '2025-11-19', queremos excluir '2025-11-20', entonces usamos date < '2025-11-20'::date
        const [endYear, endMonth, endDay] = endDateCR.split('-').map(Number);
        const endDateObj = new Date(Date.UTC(endYear, endMonth - 1, endDay));
        endDateObj.setUTCDate(endDateObj.getUTCDate() + 1); // Día siguiente
        const endDateNextDayCR = `${endDateObj.getUTCFullYear()}-${String(endDateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(endDateObj.getUTCDate()).padStart(2, '0')}`;

        // Construir condiciones WHERE dinámicamente
        const conditions: string[] = [
            `date >= '${startDateCR}'::date`,
            `date < '${endDateNextDayCR}'::date`, // ⚠️ CRÍTICO: Exclusivo para no incluir datos del día siguiente
        ];

        if (dimension === "ventana" && ventanaId) {
            conditions.push(`"ventanaId" = '${ventanaId}'::uuid`);
            conditions.push(`"vendedorId" IS NULL`);
        } else if (dimension === "vendedor" && vendedorId) {
            conditions.push(`"vendedorId" = '${vendedorId}'::uuid`);
            conditions.push(`"ventanaId" IS NULL`);
        } else if (dimension === "ventana") {
            conditions.push(`"ventanaId" IS NOT NULL`);
            conditions.push(`"vendedorId" IS NULL`);
        } else if (dimension === "vendedor") {
            conditions.push(`"vendedorId" IS NOT NULL`);
            conditions.push(`"ventanaId" IS NULL`);
        }

        const whereClause = conditions.join(' AND ');
        const orderClause = sort === "desc" ? "DESC" : "ASC";

        // Query la vista materializada
        const summaries = await prisma.$queryRawUnsafe<Array<{
            date: Date;
            ventanaId: string | null;
            vendedorId: string | null;
            ticket_count: bigint;
            total_sales: number;
            total_payouts: number;
            vendedor_commission: number;
            listero_commission: number;
            balance: number;
        }>>(`
      SELECT 
        date,
        "ventanaId",
        "vendedorId",
        ticket_count,
        total_sales,
        total_payouts,
        vendedor_commission,
        listero_commission,
        balance
      FROM mv_daily_account_summary
      WHERE ${whereClause}
      ORDER BY date ${orderClause}
    `);

        // Convertir a Map por dateKey
        const resultMap = new Map<string, {
            date: Date;
            ventanaId: string | null;
            vendedorId: string | null;
            ticket_count: number;
            total_sales: number;
            total_payouts: number;
            vendedor_commission: number;
            listero_commission: number;
            balance: number;
        }>();

        for (const summary of summaries) {
            // ⚠️ CRÍTICO: summary.date viene de la BD como DATE (sin hora), representando un día calendario en CR
            // Usar toCRDateString para obtener la fecha CR correcta (aunque summary.date ya debería estar en CR)
            // Esto asegura consistencia con el resto del código
            const dateKey = toCRDateString(summary.date);
            resultMap.set(dateKey, {
                date: summary.date,
                ventanaId: summary.ventanaId,
                vendedorId: summary.vendedorId,
                ticket_count: Number(summary.ticket_count),
                total_sales: summary.total_sales,
                total_payouts: summary.total_payouts,
                vendedor_commission: summary.vendedor_commission,
                listero_commission: summary.listero_commission,
                balance: summary.balance,
            });
        }

        return resultMap;
    } catch (error: any) {
        // Si la vista materializada no existe o hay error, retornar Map vacío
        // El código fallback usará calculateDayStatement
        logger.warn({
            layer: "service",
            action: "MATERIALIZED_VIEW_QUERY_FAILED",
            payload: { error: error.message },
        });
        return new Map();
    }
}

/**
 * ✅ OPTIMIZACIÓN: Obtiene el desglose por sorteo para múltiples días en batch
 * Retorna un Map<dateKey, Array<{...}>>
 */
export async function getSorteoBreakdownBatch(
    dates: Date[],
    dimension: "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" // ✅ CRÍTICO: Rol del usuario para calcular balance
): Promise<Map<string, Array<{
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
}>>> {
    if (dates.length === 0) {
        return new Map();
    }

    // Construir filtro de fechas combinado
    const dateFilters = dates.map(date => buildTicketDateFilter(date));
    const where: any = {
        OR: dateFilters,
        deletedAt: null,
        status: { not: "CANCELLED" },
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    // ✅ OPTIMIZACIÓN: Una sola query para todos los días
    const tickets = await prisma.ticket.findMany({
        where,
        select: {
            id: true,
            totalAmount: true,
            sorteoId: true,
            businessDate: true,
            createdAt: true,
            ventanaId: true,
            vendedorId: true,
            loteriaId: true,
            sorteo: {
                select: {
                    id: true,
                    name: true,
                    scheduledAt: true,
                    loteria: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                },
            },
            jugadas: {
                where: { deletedAt: null },
                select: {
                    payout: true,
                    isWinner: true,
                    amount: true,
                    type: true,
                    finalMultiplierX: true,
                    commissionAmount: true,
                    commissionOrigin: true,
                    listeroCommissionAmount: true, // ✅ Snapshot (puede ser 0)
                },
            },
            ventana: {
                select: {
                    commissionPolicyJson: true,
                    banca: {
                        select: {
                            commissionPolicyJson: true,
                        },
                    },
                },
            },
        },
    });

    // ✅ CRÍTICO: Obtener usuarios VENTANA con sus políticas (igual que getSorteoBreakdown)
    const ventanaIds = Array.from(new Set(tickets.map(t => t.ventanaId).filter((id): id is string => id !== null)));
    const ventanaUsers = ventanaIds.length > 0
        ? await prisma.user.findMany({
            where: {
                role: Role.VENTANA,
                isActive: true,
                deletedAt: null,
                ventanaId: { in: ventanaIds },
            },
            select: {
                id: true,
                ventanaId: true,
                commissionPolicyJson: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
        })
        : [];

    // Mapa de políticas de usuario VENTANA por ventana (tomar el más reciente)
    const userPolicyByVentana = new Map<string, any>();
    const ventanaUserIdByVentana = new Map<string, string>();
    for (const user of ventanaUsers) {
        if (!user.ventanaId) continue;
        if (!userPolicyByVentana.has(user.ventanaId)) {
            userPolicyByVentana.set(user.ventanaId, user.commissionPolicyJson ?? null);
            ventanaUserIdByVentana.set(user.ventanaId, user.id);
        }
    }

    // Crear Map por fecha
    const resultMap = new Map<string, Map<string, {
        sorteoId: string;
        sorteoName: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: Date;
        sales: number;
        payouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        ticketCount: number;
    }>>();

    // Inicializar mapas por fecha
    for (const date of dates) {
        const dateKey = date.toISOString().split("T")[0];
        resultMap.set(dateKey, new Map());
    }

    // Agrupar tickets por fecha y sorteo
    for (const ticket of tickets) {
        if (!ticket.sorteoId || !ticket.sorteo) continue;

        // Determinar la fecha del ticket
        const ticketDate = ticket.businessDate !== null
            ? new Date(ticket.businessDate as Date)
            : new Date(ticket.createdAt);
        ticketDate.setUTCHours(0, 0, 0, 0);
        const dateKey = ticketDate.toISOString().split("T")[0];

        const sorteoMap = resultMap.get(dateKey);
        if (!sorteoMap) continue; // Skip si la fecha no está en el rango

        const sorteoId = ticket.sorteo.id;
        let entry = sorteoMap.get(sorteoId);

        if (!entry) {
            entry = {
                sorteoId,
                sorteoName: ticket.sorteo.name,
                loteriaId: ticket.sorteo.loteria.id,
                loteriaName: ticket.sorteo.loteria.name,
                scheduledAt: ticket.sorteo.scheduledAt,
                sales: 0,
                payouts: 0,
                listeroCommission: 0,
                vendedorCommission: 0,
                ticketCount: 0,
            };
            sorteoMap.set(sorteoId, entry);
        }

        entry.sales += ticket.totalAmount || 0;
        entry.ticketCount += 1;

        // ✅ CRÍTICO: Calcular comisiones usando el snapshot inmutable en Jugada
        for (const jugada of ticket.jugadas) {
            // Payouts
            if (jugada.isWinner) {
                entry.payouts += jugada.payout || 0;
            }

            // Comisión del vendedor (usar snapshot)
            if (jugada.commissionOrigin === "USER") {
                entry.vendedorCommission += jugada.commissionAmount || 0;
            }

            // Comisión del listero (usar snapshot)
            entry.listeroCommission += jugada.listeroCommissionAmount || 0;
        }
    }

    // Convertir a formato de respuesta
    const finalMap = new Map<string, Array<{
        sorteoId: string;
        sorteoName: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: string;
        sales: number;
        payouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        balance: number;
        ticketCount: number;
    }>>();

    for (const [dateKey, sorteoMap] of resultMap.entries()) {
        const result = Array.from(sorteoMap.values())
            .map((entry) => ({
                sorteoId: entry.sorteoId,
                sorteoName: entry.sorteoName,
                loteriaId: entry.loteriaId,
                loteriaName: entry.loteriaName,
                scheduledAt: entry.scheduledAt.toISOString(),
                sales: entry.sales,
                payouts: entry.payouts,
                listeroCommission: entry.listeroCommission,
                vendedorCommission: entry.vendedorCommission,
                // ✅ CRÍTICO: Calcular balance según ROL del usuario, NO según dimensión
                // ADMIN siempre resta listeroCommission (independiente de dimensión)
                // VENTANA siempre resta vendedorCommission
                balance: userRole === "ADMIN"
                    ? entry.sales - entry.payouts - entry.listeroCommission
                    : entry.sales - entry.payouts - entry.vendedorCommission,
                ticketCount: entry.ticketCount,
            }))
            .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

        finalMap.set(dateKey, result);
    }

    return finalMap;
}

/**
 * Obtiene el desglose por sorteo para un día específico (mantener para compatibilidad)
 */
export async function getSorteoBreakdown(
    date: Date,
    dimension: "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" // ✅ CRÍTICO: Rol del usuario para calcular balance
): Promise<Array<{
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
}>> {
    const dateFilter = buildTicketDateFilter(date);
    const where: any = {
        ...dateFilter,
        deletedAt: null,
        status: { not: "CANCELLED" },
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    // Obtener tickets con sus sorteos, loterías y jugadas
    const tickets = await prisma.ticket.findMany({
        where,
        select: {
            id: true,
            totalAmount: true,
            sorteoId: true,
            ventanaId: true,
            loteriaId: true,
            sorteo: {
                select: {
                    id: true,
                    name: true,
                    scheduledAt: true,
                    loteria: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                },
            },
            jugadas: {
                where: { deletedAt: null },
                select: {
                    payout: true,
                    isWinner: true,
                    amount: true,
                    type: true,
                    finalMultiplierX: true,
                    commissionAmount: true,
                    commissionOrigin: true,
                    listeroCommissionAmount: true, // ✅ Snapshot (puede ser 0)
                },
            },
            ventana: {
                select: {
                    commissionPolicyJson: true,
                    banca: {
                        select: {
                            commissionPolicyJson: true,
                        },
                    },
                },
            },
        },
    });

    // ✅ CRÍTICO: Obtener usuarios VENTANA con sus políticas (igual que commissions.service.ts)
    const ventanaIds = Array.from(new Set(tickets.map(t => t.ventanaId).filter((id): id is string => id !== null)));
    const ventanaUsers = ventanaIds.length > 0
        ? await prisma.user.findMany({
            where: {
                role: Role.VENTANA,
                isActive: true,
                deletedAt: null,
                ventanaId: { in: ventanaIds },
            },
            select: {
                id: true,
                ventanaId: true,
                commissionPolicyJson: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
        })
        : [];

    // Mapa de políticas de usuario VENTANA por ventana (tomar el más reciente)
    const userPolicyByVentana = new Map<string, any>();
    const ventanaUserIdByVentana = new Map<string, string>();
    for (const user of ventanaUsers) {
        if (!user.ventanaId) continue;
        if (!userPolicyByVentana.has(user.ventanaId)) {
            userPolicyByVentana.set(user.ventanaId, user.commissionPolicyJson ?? null);
            ventanaUserIdByVentana.set(user.ventanaId, user.id);
        }
    }

    // Agrupar por sorteo
    const sorteoMap = new Map<string, {
        sorteoId: string;
        sorteoName: string;
        loteriaId: string;
        loteriaName: string;
        scheduledAt: Date;
        sales: number;
        payouts: number;
        listeroCommission: number;
        vendedorCommission: number;
        ticketCount: number;
    }>();

    for (const ticket of tickets) {
        if (!ticket.sorteoId || !ticket.sorteo) continue;

        const sorteoId = ticket.sorteo.id;
        let entry = sorteoMap.get(sorteoId);

        if (!entry) {
            entry = {
                sorteoId,
                sorteoName: ticket.sorteo.name,
                loteriaId: ticket.sorteo.loteria.id,
                loteriaName: ticket.sorteo.loteria.name,
                scheduledAt: ticket.sorteo.scheduledAt,
                sales: 0,
                payouts: 0,
                listeroCommission: 0,
                vendedorCommission: 0,
                ticketCount: 0,
            };
            sorteoMap.set(sorteoId, entry);
        }

        entry.sales += ticket.totalAmount || 0;
        entry.ticketCount += 1;

        // ✅ CRÍTICO: Calcular comisiones usando el snapshot inmutable en Jugada
        for (const jugada of ticket.jugadas) {
            // Payouts
            if (jugada.isWinner) {
                entry.payouts += jugada.payout || 0;
            }

            // Comisión del vendedor (usar snapshot)
            if (jugada.commissionOrigin === "USER") {
                entry.vendedorCommission += jugada.commissionAmount || 0;
            }

            // Comisión del listero (usar snapshot)
            entry.listeroCommission += jugada.listeroCommissionAmount || 0;
        }
    }

    // Calcular balance para cada sorteo y convertir a formato de respuesta
    const result = Array.from(sorteoMap.values())
        .map((entry) => ({
            sorteoId: entry.sorteoId,
            sorteoName: entry.sorteoName,
            loteriaId: entry.loteriaId,
            loteriaName: entry.loteriaName,
            scheduledAt: entry.scheduledAt.toISOString(),
            sales: entry.sales,
            payouts: entry.payouts,
            listeroCommission: entry.listeroCommission,
            vendedorCommission: entry.vendedorCommission,
            // ✅ CRÍTICO: Calcular balance según ROL del usuario, NO según dimensión
            // ADMIN siempre resta listeroCommission (independiente de dimensión)
            // VENTANA siempre resta vendedorCommission
            balance: userRole === "ADMIN"
                ? entry.sales - entry.payouts - entry.listeroCommission
                : entry.sales - entry.payouts - entry.vendedorCommission,
            ticketCount: entry.ticketCount,
        }))
        .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()); // Ordenar por scheduledAt ascendente

    return result;
}

/**
 * Obtiene los movimientos (pagos/cobros) de un statement para un día específico
 * Los movimientos se ordenan por createdAt (ascendente) para reflejar el orden cronológico
 * según lo especificado en BE_CUENTAS_REGISTRO_PAGO_COBRO.md
 */
export async function getMovementsForDay(
    statementId: string
): Promise<Array<{
    id: string;
    accountStatementId: string;
    date: string;
    amount: number;
    type: "payment" | "collection";
    method: "cash" | "transfer" | "check" | "other";
    notes: string | null;
    isFinal: boolean;
    isReversed: boolean;
    reversedAt: Date | null;
    reversedBy: string | null;
    paidById: string;
    paidByName: string;
    createdAt: string;
    updatedAt: string;
}>> {
    const payments = await AccountPaymentRepository.findByStatementId(statementId);

    return payments
        // ✅ CORREGIDO: Retornar TODOS los movimientos (activos y reversados)
        // El FE los separa en "Activos" y "Revertidos" para mostrar en historial de auditoria
        // Los cálculos en el backend filtran !isReversed cuando es necesario
        .map((p) => ({
            id: p.id,
            accountStatementId: p.accountStatementId,
            date: p.date.toISOString().split("T")[0],
            amount: p.amount,
            type: p.type as "payment" | "collection",
            method: p.method as "cash" | "transfer" | "check" | "other",
            notes: p.notes,
            isFinal: p.isFinal,
            isReversed: p.isReversed,
            reversedAt: p.reversedAt,
            reversedBy: p.reversedBy,
            paidById: p.paidById,
            paidByName: p.paidByName,
            createdAt: p.createdAt.toISOString(),
            updatedAt: p.updatedAt.toISOString(),
        }))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()); // Ordenar por createdAt ascendente
}
