// src/domain/accounts/engine/day-statement.calculator.ts

import { Role } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import logger from "../../../core/logger";
import { crDateService } from "../../../utils/crDateService";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { AccountStatementRepository } from "../../../repositories/accountStatement.repository";
import { getPreviousMonthFinalBalance } from "../accounts.balances";
import { calculateIsSettled } from "../accounts.commissions";
import { buildTicketDateFilter } from "../accounts.dates.utils";
import { getCachedDayStatement, setCachedDayStatement } from "../../../utils/accountStatementCache";
import { getAccountStatementIfExists } from "../accounts.statement-reader";
import { DayStatement } from "./types/statement.types";
import { getExcludedTicketIdsForDate } from "./settled-statements.helper";

export async function calculateDayStatement(
    date: Date,
    month: string,
    dimension: "banca" | "ventana" | "vendedor", //  NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: Role //  CRÍTICO: Rol del usuario para calcular balance correctamente
): Promise<DayStatement> {
    //  OPTIMIZACIÓN: Intentar obtener del caché primero
    const dateStr = crDateService.postgresDateToCRString(date);
    const cacheKey = {
        date: dateStr,
        dimension,
        ventanaId: ventanaId || null,
        vendedorId: vendedorId || null,
        bancaId: bancaId || null,
        userRole: userRole || "ADMIN",
    };

    const cached = await getCachedDayStatement<DayStatement>(cacheKey);
    if (cached) {
        return cached;
    }

    //  OPTIMIZACIÓN: Confiar en AccountStatement si existe
    // La tabla se mantiene sincronizada en tiempo real por:
    // - Evaluación de sorteos (syncSorteoStatements)
    // - Registro/reversión de pagos (registerPayment/reversePayment)
    // Solo recalculamos si el registro NO existe
    const existingStatement = await getAccountStatementIfExists(
        date,
        dimension,
        bancaId,
        ventanaId,
        vendedorId
    );

    if (existingStatement) {
        // Mapear de AccountStatement (Prisma) a DayStatement (Frontend)

        // Obtener total de pagos y cobros combinados
        const totalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(existingStatement.id);

        //  OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
        let ventanaName: string | null = null;
        let vendedorName: string | null = null;

        const [ventana, vendedor] = await Promise.all([
            existingStatement.ventanaId
                ? prisma.ventana.findUnique({
                    where: { id: existingStatement.ventanaId },
                    select: { name: true },
                })
                : Promise.resolve(null),
            existingStatement.vendedorId
                ? prisma.user.findUnique({
                    where: { id: existingStatement.vendedorId },
                    select: { name: true },
                })
                : Promise.resolve(null),
        ]);

        ventanaName = ventana?.name || null;
        vendedorName = vendedor?.name || null;

        const result: DayStatement = {
            id: existingStatement.id,
            date: existingStatement.date,
            month: existingStatement.month,
            bancaId: existingStatement.bancaId,
            ventanaId: existingStatement.ventanaId,
            vendedorId: existingStatement.vendedorId,
            ventanaName,
            vendedorName,
            totalSales: Number(existingStatement.totalSales),
            totalPayouts: Number(existingStatement.totalPayouts),
            listeroCommission: Number(existingStatement.listeroCommission),
            vendedorCommission: Number(existingStatement.vendedorCommission),
            balance: Number(existingStatement.balance),
            totalPaid: Number(existingStatement.totalPaid),
            totalCollected: Number(existingStatement.totalCollected),
            totalPaymentsCollections: parseFloat((Number(existingStatement.totalPaid) - Number(existingStatement.totalCollected)).toFixed(2)),
            remainingBalance: Number(existingStatement.remainingBalance),
            isSettled: existingStatement.isSettled,
            canEdit: existingStatement.canEdit,
            ticketCount: existingStatement.ticketCount,
            createdAt: existingStatement.createdAt,
            updatedAt: existingStatement.updatedAt,
        };

        // Cachear y retornar
        await setCachedDayStatement(cacheKey, result);
        return result;
    }

    // Construir WHERE clause
    // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
    const dateFilter = buildTicketDateFilter(date);

    //  NUEVO: Obtener tickets excluidos para esta fecha
    const excludedTicketIds = await getExcludedTicketIdsForDate(date);

    const where: any = {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["EVALUATED", "PAID", "PAGADO"] }, // Excluir ACTIVE
        sorteo: {
            status: "EVALUATED",
            deletedAt: null,
        },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}), //  NUEVO: Excluir tickets bloqueados
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    //  NUEVO: Validación defensiva según dimensión
    if (dimension === "banca" && bancaId) {
        // Filtrar por banca (ya aplicado arriba con where.ventana.bancaId)
    } else if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    //  CRÍTICO: Si se busca por vendedorId sin ventanaId, pero los tickets tienen ventanaId,
    // debemos corregir el ventanaId desde los tickets reales para evitar crear statements incorrectos
    // Esto soluciona el problema de statements con ventanaId: null cuando deberían tenerlo
    let correctedVentanaId = ventanaId;
    if (dimension === "vendedor" && vendedorId && !ventanaId) {
        // Buscar un ticket de ejemplo para obtener el ventanaId real de ese día
        // Usamos la misma query where pero solo necesitamos el primer ticket que tenga ventanaId
        const sampleTicket = await prisma.ticket.findFirst({
            where: {
                ...where,
            },
            select: {
                ventanaId: true,
            },
        });

        if (sampleTicket?.ventanaId) {
            correctedVentanaId = sampleTicket.ventanaId;
            logger.info({
                layer: 'service',
                action: 'CORRECT_VENTANA_ID_FROM_TICKETS',
                payload: {
                    date: dateStr,
                    vendedorId,
                    inferredVentanaId: correctedVentanaId,
                    note: 'Corrected ventanaId from actual tickets for the day',
                },
            });
        }
    }

    // Usar agregaciones de Prisma para calcular totales directamente en la base de datos
    // Esto es mucho más eficiente que traer todos los tickets y jugadas a memoria
    const [ticketAgg, ticketAggWinners, jugadaAggVendor, jugadaAggListero] = await Promise.all([
        // Agregaciones de tickets (TODOS los tickets para ventas)
        prisma.ticket.aggregate({
            where,
            _sum: {
                totalAmount: true,
            },
            _count: {
                id: true,
            },
        }),
        //  CORRECCIÓN: Agregaciones de tickets SOLO con jugadas ganadoras para payouts
        // Esto asegura que solo contamos totalPayout de tickets que realmente tienen jugadas ganadoras
        prisma.ticket.aggregate({
            where: {
                ...where,
                jugadas: {
                    some: {
                        isWinner: true,
                        deletedAt: null,
                    },
                },
            },
            _sum: {
                totalPayout: true, //  CORRECCIÓN: Usar totalPayout del ticket (una vez por ticket, solo si tiene jugadas ganadoras)
            },
        }),
    // Agrega comisión del vendedor desde Jugada (commissionOrigin USER)
        prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
                commissionOrigin: "USER",
            },
            _sum: {
                commissionAmount: true,
            },
        }),
        //  Agrega comisión del listero directamente desde el snapshot en Ticket.
        // Eliminada dependencia de Jugada.listeroCommissionAmount.
        prisma.ticket.aggregate({
            where,
            _sum: { totalListeroCommission: true },
        }),
    ]);

    // Calcular totales básicos desde agregaciones
    const totalSales = ticketAgg._sum.totalAmount || 0;
    //  CORRECCIÓN: totalPayouts debe ser la suma de totalPayout de tickets con jugadas ganadoras
    const totalPayouts = ticketAggWinners._sum.totalPayout || 0;
    const ticketCount = ticketAgg._count.id || 0;
    // FIX: Solo sumar comisiones del vendedor (commissionOrigin === "USER")
    const totalVendedorCommission = jugadaAggVendor._sum.commissionAmount || 0;
    //  Comisión del listero desde snapshot en Ticket (sin fallback a Jugada)
    const totalListeroCommission = Number(jugadaAggListero._sum.totalListeroCommission) || 0;

    // FIX: No crear fechas nuevas cada vez para mantener consistencia
    if (ticketCount === 0) {
        //  CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
        // Intentar obtener statement existente si existe
        const existingStatement = await AccountStatementRepository.findByDate(date, {
            ventanaId: correctedVentanaId ?? ventanaId,
            vendedorId,
        });

        if (existingStatement) {
            //  FIX: Recalcular totalPaid y totalCollected desde movimientos activos
            // Esto asegura que los valores reflejen los movimientos actuales
            const recalculatedTotalPaid = await AccountPaymentRepository.getTotalPaid(existingStatement.id);
            const recalculatedTotalCollected = await AccountPaymentRepository.getTotalCollected(existingStatement.id);
            //  NUEVO: Recalcular totalPaymentsCollections
            const recalculatedTotalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(existingStatement.id);
            //  NUEVO: Balance incluye movimientos
            // Como no hay tickets (totalSales = 0, totalPayouts = 0, comisiones = 0)
            // balance = 0 - 0 - 0 + totalPaid - totalCollected = totalPaid - totalCollected
            const recalculatedBalance = recalculatedTotalPaid - recalculatedTotalCollected;

            //  FIX: Recalcular previousAccumulated para obtener remainingBalance correcto
            let previousAccumulated = 0;
            const [year, monthVal, day] = dateStr.split('-').map(Number);

            if (day === 1) {
                // Primer día del mes: Usar cierre del mes anterior
                // Usar month (param) o calcularlo
                const currentMonth = month || `${year}-${String(monthVal).padStart(2, '0')}`;
                // IMPORTANTE: Para vendedores, NO pasar ventanaId para evitar conflictos con cierres de ventana
                previousAccumulated = await getPreviousMonthFinalBalance(
                    currentMonth,
                    dimension,
                    dimension === "vendedor" ? undefined : (correctedVentanaId ?? ventanaId),
                    vendedorId,
                    bancaId
                );
            } else {
                // Otros días: Buscar el statement más reciente en el mismo mes antes de hoy (maneja huecos)
                const prevStmtWhere: any = {
                    date: { lt: date, gte: new Date(Date.UTC(year, monthVal - 1, 1)) },
                };

                if (dimension === "vendedor" && vendedorId) {
                    prevStmtWhere.vendedorId = vendedorId;
                } else if (dimension === "ventana" && correctedVentanaId) {
                    prevStmtWhere.ventanaId = correctedVentanaId;
                    prevStmtWhere.vendedorId = null;
                } else if (dimension === "banca" && bancaId) {
                    prevStmtWhere.bancaId = bancaId;
                    prevStmtWhere.ventanaId = null;
                    prevStmtWhere.vendedorId = null;
                }

                const prevStmt = await prisma.accountStatement.findFirst({
                    where: prevStmtWhere,
                    orderBy: { date: 'desc' },
                    select: { remainingBalance: true }
                });

                if (prevStmt) {
                    previousAccumulated = Number(prevStmt.remainingBalance || 0);
                }
            }

            //  NUEVO: remainingBalance = previousAccumulated + balance (ya incluye movimientos)
            const recalculatedRemainingBalance = previousAccumulated + recalculatedBalance;

            //  FIX: Actualizar el statement con los valores recalculados
            await AccountStatementRepository.update(existingStatement.id, {
                balance: recalculatedBalance,
                totalPaid: recalculatedTotalPaid,
                totalCollected: recalculatedTotalCollected,
                remainingBalance: recalculatedRemainingBalance,
            });

            //  OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
            let ventanaName: string | null = null;
            let vendedorName: string | null = null;

            const [ventana, vendedor] = await Promise.all([
                existingStatement.ventanaId
                    ? prisma.ventana.findUnique({
                        where: { id: existingStatement.ventanaId },
                        select: { name: true },
                    })
                    : Promise.resolve(null),
                existingStatement.vendedorId
                    ? prisma.user.findUnique({
                        where: { id: existingStatement.vendedorId },
                        select: { name: true },
                    })
                    : Promise.resolve(null),
            ]);

            ventanaName = ventana?.name || null;
            vendedorName = vendedor?.name || null;

            // Si existe, retornar el existente con valores recalculados
            return {
                ...existingStatement,
                totalSales: 0,
                totalPayouts: 0,
                listeroCommission: 0,
                vendedorCommission: 0,
                balance: recalculatedBalance,
                totalPaid: recalculatedTotalPaid,
                totalCollected: recalculatedTotalCollected,
                totalPaymentsCollections: parseFloat((recalculatedTotalPaid - recalculatedTotalCollected).toFixed(2)), //  CORREGIDO: totalPaid - totalCollected
                remainingBalance: recalculatedRemainingBalance,
                isSettled: false,
                canEdit: true,
                ticketCount: 0,
                ventanaName,
                vendedorName,
            };
        }

        // Si no existe, crear statement para tener un id
        //  Calcular month desde la fecha si no está disponible
        //  CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
        const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        const newStatement = await AccountStatementRepository.findOrCreate({
            date,
            month: monthForStatement,
            ventanaId: correctedVentanaId ?? ventanaId,
            vendedorId,
        });

        //  OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
        let ventanaName: string | null = null;
        let vendedorName: string | null = null;

        const [ventana, vendedor] = await Promise.all([
            newStatement.ventanaId
                ? prisma.ventana.findUnique({
                    where: { id: newStatement.ventanaId },
                    select: { name: true },
                })
                : Promise.resolve(null),
            newStatement.vendedorId
                ? prisma.user.findUnique({
                    where: { id: newStatement.vendedorId },
                    select: { name: true },
                })
                : Promise.resolve(null),
        ]);

        ventanaName = ventana?.name || null;
        vendedorName = vendedor?.name || null;

        //  FIX: Calcular previousAccumulated para el nuevo statement
        let previousAccumulated = 0;
        const [year, monthVal, day] = dateStr.split('-').map(Number);

        if (day === 1) {
            previousAccumulated = await getPreviousMonthFinalBalance(
                monthForStatement,
                dimension,
                dimension === "vendedor" ? undefined : (correctedVentanaId ?? ventanaId),
                vendedorId,
                bancaId
            );
        } else {
            // Otros días: Buscar el statement más reciente en el mismo mes antes de hoy (maneja huecos)
            const prevStmtWhere: any = {
                date: { lt: date, gte: new Date(Date.UTC(year, monthVal - 1, 1)) },
            };
            if (dimension === "vendedor" && vendedorId) prevStmtWhere.vendedorId = vendedorId;
            else if (dimension === "ventana" && correctedVentanaId) { prevStmtWhere.ventanaId = correctedVentanaId; prevStmtWhere.vendedorId = null; }
            else if (dimension === "banca" && bancaId) { prevStmtWhere.bancaId = bancaId; prevStmtWhere.ventanaId = null; prevStmtWhere.vendedorId = null; }

            const prevStmt = await prisma.accountStatement.findFirst({
                where: prevStmtWhere,
                orderBy: { date: 'desc' },
                select: { remainingBalance: true }
            });

            if (prevStmt) previousAccumulated = Number(prevStmt.remainingBalance || 0);
        }

        const remainingBalance = previousAccumulated + 0; // balance is 0

        return {
            ...newStatement,
            totalSales: 0,
            totalPayouts: 0,
            listeroCommission: 0,
            vendedorCommission: 0,
            balance: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalPaymentsCollections: 0, //  NUEVO
            remainingBalance: parseFloat(remainingBalance.toFixed(2)),
            isSettled: false, // No está saldado si no hay tickets
            canEdit: true,
            ticketCount: 0,
            ventanaName,
            vendedorName,
        };
    }

    //  ACTUALIZADO: Permitir ambos campos cuando hay vendedorId
    // El constraint _one_relation_check ha sido eliminado
    // findOrCreate ahora maneja la inferencia de ventanaId y bancaId automáticamente
    //  CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
    let targetBancaId = bancaId ?? undefined;
    let targetVentanaId = correctedVentanaId ?? undefined;
    let targetVendedorId = vendedorId ?? undefined;

    // Crear o actualizar estado de cuenta primero con los valores correctos
    //  Calcular month desde la fecha si no está disponible
    //  findOrCreate ahora infiere automáticamente ventanaId y bancaId cuando es necesario
    const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const statement = await AccountStatementRepository.findOrCreate({
        date,
        month: monthForStatement,
        bancaId: targetBancaId,
        ventanaId: targetVentanaId,
        vendedorId: targetVendedorId,
    });

    //  CRÍTICO: Si el statement encontrado tiene ventanaId: null pero debería tenerlo (corregido desde tickets),
    // actualizarlo para evitar que quede con datos incorrectos
    // ventanaId is now immutable after creation; do not update it here

    //  ACTUALIZADO: Ya no necesitamos verificar el tipo porque ambos campos pueden estar presentes
    // findOrCreate ya maneja correctamente la búsqueda y creación
    const finalStatement = statement;

    // Obtener total pagado y cobrado después de crear el statement
    const totalPaid = await AccountPaymentRepository.getTotalPaid(finalStatement.id);
    const totalCollected = await AccountPaymentRepository.getTotalCollected(finalStatement.id);
    //  NUEVO: Obtener total de pagos y cobros combinados (no revertidos)
    const totalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(finalStatement.id);

    //  CORRECCIÓN: Calcular balance según dimensión + movimientos
    // - Vendedor: balance = totalSales - totalPayouts - vendedorCommission + totalPaid - totalCollected
    // - Ventana/Banca: balance = totalSales - totalPayouts - listeroCommission + totalPaid - totalCollected
    const balance = dimension === "vendedor"
        ? totalSales - totalPayouts - totalVendedorCommission + totalPaid - totalCollected
        : totalSales - totalPayouts - totalListeroCommission + totalPaid - totalCollected;

    //  FIX: Calcular previousAccumulated antes de calcular remainingBalance
    let previousAccumulated = 0;
    const [year, monthVal, day] = dateStr.split('-').map(Number);

    if (day === 1) {
        previousAccumulated = await getPreviousMonthFinalBalance(
            monthForStatement,
            dimension,
            dimension === "vendedor" ? undefined : (targetVentanaId), // NO pasar ventanaId para vendedores
            targetVendedorId,
            targetBancaId
        );
    } else {
        // Otros días: Buscar el statement más reciente en el mismo mes antes de hoy (maneja huecos)
        const prevStmtWhere: any = {
            date: { lt: date, gte: new Date(Date.UTC(year, monthVal - 1, 1)) },
        };
        if (dimension === "vendedor" && targetVendedorId) prevStmtWhere.vendedorId = targetVendedorId;
        else if (dimension === "ventana" && targetVentanaId) { prevStmtWhere.ventanaId = targetVentanaId; prevStmtWhere.vendedorId = null; }
        else if (dimension === "banca" && targetBancaId) { prevStmtWhere.bancaId = targetBancaId; prevStmtWhere.ventanaId = null; prevStmtWhere.vendedorId = null; }

        const prevStmt = await prisma.accountStatement.findFirst({
            where: prevStmtWhere,
            orderBy: { date: 'desc' },
            select: { remainingBalance: true }
        });

        if (prevStmt) previousAccumulated = Number(prevStmt.remainingBalance || 0);
    }

    //  NUEVO: remainingBalance = previousAccumulated + balance (acumulado progresivo)
    const remainingBalance = previousAccumulated + balance;

    // FIX: Usar helper para cálculo consistente de isSettled
    const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);
    const canEdit = !isSettled;

    //  FIX: Guardar también totalCollected en el statement
    await AccountStatementRepository.update(finalStatement.id, {
        totalSales,
        totalPayouts,
        listeroCommission: totalListeroCommission,
        vendedorCommission: totalVendedorCommission,
        balance,
        totalPaid,
        totalCollected, //  NUEVO: Guardar totalCollected
        remainingBalance,
        isSettled,
        canEdit,
        ticketCount,
        // No cambiar ventanaId/vendedorId aquí - ya están correctos en finalStatement
    });

    //  OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
    let ventanaName: string | null = null;
    let vendedorName: string | null = null;

    const [ventana, vendedor] = await Promise.all([
        finalStatement.ventanaId
            ? prisma.ventana.findUnique({
                where: { id: finalStatement.ventanaId },
                select: { name: true },
            })
            : Promise.resolve(null),
        finalStatement.vendedorId
            ? prisma.user.findUnique({
                where: { id: finalStatement.vendedorId },
                select: { name: true },
            })
            : Promise.resolve(null),
    ]);

    ventanaName = ventana?.name || null;
    vendedorName = vendedor?.name || null;

    const result: DayStatement = {
        ...finalStatement,
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalPayouts: parseFloat(totalPayouts.toFixed(2)),
        listeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
        vendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
        balance: parseFloat(balance.toFixed(2)),
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        totalCollected: parseFloat(totalCollected.toFixed(2)), // Agregar totalCollected al objeto retornado
        totalPaymentsCollections: parseFloat((totalPaid - totalCollected).toFixed(2)), //  CORREGIDO: totalPaid - totalCollected (no revertidos)
        remainingBalance: parseFloat(remainingBalance.toFixed(2)),
        isSettled,
        canEdit,
        ticketCount,
        ventanaId: finalStatement.ventanaId,
        vendedorId: finalStatement.vendedorId,
        ventanaName,
        vendedorName,
    };

    //  OPTIMIZACIÓN: Guardar en caché (no esperar, hacerlo en background)
    setCachedDayStatement(cacheKey, result).catch(() => {
        // Ignorar errores de caché
    });

    return result;
}

/**
 *  NUEVO: Calcula estado de cuenta directamente desde tickets/jugadas
 * Usa EXACTAMENTE la misma lógica que commissions.service.ts
 * Calcula jugada por jugada desde el principio, igual que commissions
 */
