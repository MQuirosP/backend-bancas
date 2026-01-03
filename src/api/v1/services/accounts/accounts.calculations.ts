import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { AppError } from "../../../../core/errors";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { calculateIsSettled } from "./accounts.commissions";
import { buildTicketDateFilter } from "./accounts.dates.utils";
import { crDateService } from "../../../../utils/crDateService";
import { AccountsFilters, DayStatement, StatementTotals } from "./accounts.types";
import { resolveCommissionFromPolicy } from "../../../../services/commission/commission.resolver";
import { resolveCommission } from "../../../../services/commission.resolver";
import { getSorteoBreakdownBatch } from "./accounts.queries";
import { getCachedDayStatement, setCachedDayStatement, getCachedBySorteo, setCachedBySorteo, getCachedPreviousMonthBalance, setCachedPreviousMonthBalance } from "../../../../utils/accountStatementCache";
import { intercalateSorteosAndMovements, SorteoOrMovement } from "./accounts.intercalate";

/**
 * ============================================================================
 * MÓDULO: ACCOUNTS - CÁLCULOS DE ESTADOS DE CUENTA
 * ============================================================================
 * 
 * Este módulo maneja el cálculo de estados de cuenta diarios y mensuales,
 * incluyendo la intercalación de sorteos y movimientos (pagos/cobros).
 * 
 * CONCEPTOS CLAVE:
 * 
 * 1. DIMENSIONES:
 *    - "banca": Agrupa por banca (puede incluir múltiples ventanas/vendedores)
 *    - "ventana": Agrupa por ventana (puede incluir múltiples vendedores)
 *    - "vendedor": Agrupa por vendedor específico
 * 
 * 2. AGRUPACIÓN (shouldGroupByDate):
 *    - true: Agrupa múltiples entidades por fecha (ej: todas las bancas del día)
 *    - false: Separa por entidad específica (ej: una ventana específica)
 * 
 * 3. FILTRADO DE MOVIMIENTOS:
 *    - findMovementsByDateRange filtra en la BD según dimension y filtros
 *    - Cuando dimension='ventana' y hay ventanaId: incluye TODOS los movimientos
 *      de esa ventana (consolidados + de vendedores específicos)
 *    - Cuando dimension='ventana' sin ventanaId: solo movimientos consolidados
 *      (vendedorId = null)
 * 
 * 4. INTERCALACIÓN:
 *    - Los sorteos y movimientos se intercalan cronológicamente por scheduledAt
 *    - Los movimientos usan el campo 'time' (HH:MM) si está disponible
 *    - El accumulated se calcula progresivamente sumando balances
 * 
 * 5. ACUMULADOS PROGRESIVOS:
 *    - Se calculan desde el inicio del mes hasta cada día
 *    - NO dependen del filtro de fecha aplicado
 *    - El acumulado del día anterior se suma al acumulado interno del día actual
 * 
 * ============================================================================
 */

/**
 * Calcula y actualiza el estado de cuenta para un día específico
 * 
 * @param date - Fecha del día a calcular
 * @param month - Mes en formato YYYY-MM
 * @param dimension - Dimensión de agrupación: "banca" | "ventana" | "vendedor"
 * @param ventanaId - ID de ventana (opcional, según dimension)
 * @param vendedorId - ID de vendedor (opcional, según dimension)
 * @param bancaId - ID de banca (opcional, según dimension)
 * @param userRole - Rol del usuario para calcular balance correctamente
 * @returns Estado de cuenta del día con todos los totales y bySorteo
 */
export async function calculateDayStatement(
    date: Date,
    month: string,
    dimension: "banca" | "ventana" | "vendedor", // ✅ NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR" // ✅ CRÍTICO: Rol del usuario para calcular balance correctamente
): Promise<DayStatement> {
    // ✅ OPTIMIZACIÓN: Intentar obtener del caché primero
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

    // Construir WHERE clause
    // FIX: Usar businessDate en lugar de createdAt para agrupar correctamente por día de negocio
    const dateFilter = buildTicketDateFilter(date);

    // ✅ NUEVO: Obtener tickets excluidos para esta fecha
    const excludedTicketIds = await getExcludedTicketIdsForDate(date);

    const where: any = {
        ...dateFilter,
        deletedAt: null,
        isActive: true,
        status: { in: ["ACTIVE", "EVALUATED", "PAID", "PAGADO"] },
        ...(excludedTicketIds.length > 0 ? { id: { notIn: excludedTicketIds } } : {}), // ✅ NUEVO: Excluir tickets bloqueados
    };

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        where.ventana = {
            bancaId: bancaId,
        };
    }

    // ✅ NUEVO: Validación defensiva según dimensión
    if (dimension === "banca" && bancaId) {
        // Filtrar por banca (ya aplicado arriba con where.ventana.bancaId)
    } else if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
    } else if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    }

    // ✅ CRÍTICO: Si se busca por vendedorId sin ventanaId, pero los tickets tienen ventanaId,
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
        // ✅ CORRECCIÓN: Agregaciones de tickets SOLO con jugadas ganadoras para payouts
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
                totalPayout: true, // ✅ CORRECCIÓN: Usar totalPayout del ticket (una vez por ticket, solo si tiene jugadas ganadoras)
            },
        }),
        // Agregaciones de jugadas - TODAS las jugadas para comisiones
        // IMPORTANTE: Para comisiones, incluir TODAS las jugadas (no solo ganadoras)
        // Las comisiones se aplican a todas las jugadas, no solo a las ganadoras
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
        // ✅ NUEVO: Agregación de comisiones del listero desde snapshot
        // Nota: Si la columna no existe aún (migración pendiente), usar fallback desde commissionOrigin
        prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
            },
            _sum: {
                listeroCommissionAmount: true, // ✅ Usar snapshot en lugar de calcular desde políticas
            },
        }).catch((error: any) => {
            // Fallback si la columna no existe aún (migración pendiente)
            if (error?.message?.includes('listeroCommissionAmount')) {
                return { _sum: { listeroCommissionAmount: null } };
            }
            throw error;
        }),
    ]);

    // Calcular totales básicos desde agregaciones
    const totalSales = ticketAgg._sum.totalAmount || 0;
    // ✅ CORRECCIÓN: totalPayouts debe ser la suma de totalPayout de tickets que tienen jugadas ganadoras
    // NO debe sumar el payout de cada jugada individualmente porque un ticket puede tener múltiples jugadas ganadoras
    // El campo totalPayout del ticket ya contiene la suma correcta de todos los payouts de las jugadas ganadoras de ese ticket
    // IMPORTANTE: Solo sumar totalPayout de tickets que tienen al menos una jugada ganadora
    const totalPayouts = ticketAggWinners._sum.totalPayout || 0;
    const ticketCount = ticketAgg._count.id || 0;
    // FIX: Solo sumar comisiones del vendedor (commissionOrigin === "USER")
    const totalVendedorCommission = jugadaAggVendor._sum.commissionAmount || 0;

    // ✅ NUEVO: Usar snapshot de comisión del listero en lugar de calcular desde políticas
    // Esto es mucho más rápido y preciso
    // Fallback: Si el snapshot es 0 (tickets creados antes de los cambios), calcular desde commissionOrigin
    let totalListeroCommission = jugadaAggListero?._sum?.listeroCommissionAmount || 0;

    // Si el snapshot es 0, puede ser porque:
    // 1. Realmente no hay comisión del listero
    // 2. Los tickets fueron creados antes de los cambios (tienen listeroCommissionAmount: 0 por defecto)
    // En el caso 2, necesitamos calcular desde commissionOrigin como fallback
    // ✅ OPTIMIZACIÓN: Usar agregación en lugar de findMany para mejor rendimiento
    if (totalListeroCommission === 0 && ticketCount > 0) {
        // Verificar si hay tickets con commissionOrigin VENTANA/BANCA que no tienen snapshot
        // Esto indica que fueron creados antes de los cambios
        // ✅ OPTIMIZACIÓN: Usar agregación en lugar de findMany para evitar traer todas las jugadas
        const fallbackAgg = await prisma.jugada.aggregate({
            where: {
                ticket: where,
                deletedAt: null,
                commissionOrigin: { in: ["VENTANA", "BANCA"] },
                listeroCommissionAmount: 0, // Tickets antiguos tienen 0 por defecto
            },
            _sum: {
                commissionAmount: true,
            },
            _count: {
                id: true,
            },
        });

        const fallbackTotal = fallbackAgg._sum.commissionAmount || 0;
        if (fallbackTotal > 0) {
            totalListeroCommission = fallbackTotal;
            logger.warn({
                layer: 'service',
                action: 'LISTERO_COMMISSION_FALLBACK_FROM_ORIGIN',
                payload: {
                    fallbackTotal,
                    jugadasCount: fallbackAgg._count.id || 0,
                    note: 'Using commissionOrigin as fallback for old tickets',
                },
            });
        }
    }

    // Si no hay tickets, retornar valores por defecto sin crear statement
    // FIX: No crear fechas nuevas cada vez para mantener consistencia
    if (ticketCount === 0) {
        // ✅ CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
        // Intentar obtener statement existente si existe
        const existingStatement = await AccountStatementRepository.findByDate(date, {
            ventanaId: correctedVentanaId ?? ventanaId,
            vendedorId,
        });

        if (existingStatement) {
            // ✅ FIX: Recalcular totalPaid y totalCollected desde movimientos activos
            // Esto asegura que los valores reflejen los movimientos actuales
            const recalculatedTotalPaid = await AccountPaymentRepository.getTotalPaid(existingStatement.id);
            const recalculatedTotalCollected = await AccountPaymentRepository.getTotalCollected(existingStatement.id);
            // ✅ NUEVO: Recalcular totalPaymentsCollections
            const recalculatedTotalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(existingStatement.id);
            // ✅ NUEVO: Balance incluye movimientos
            // Como no hay tickets (totalSales = 0, totalPayouts = 0, comisiones = 0)
            // balance = 0 - 0 - 0 + totalPaid - totalCollected = totalPaid - totalCollected
            const recalculatedBalance = recalculatedTotalPaid - recalculatedTotalCollected;
            // ✅ NUEVO: remainingBalance = balance (ya incluye movimientos)
            const recalculatedRemainingBalance = recalculatedBalance;

            // ✅ FIX: Actualizar el statement con los valores recalculados
            await AccountStatementRepository.update(existingStatement.id, {
                balance: recalculatedBalance,
                totalPaid: recalculatedTotalPaid,
                totalCollected: recalculatedTotalCollected,
                remainingBalance: recalculatedRemainingBalance,
            });

            // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
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
                totalPaymentsCollections: recalculatedTotalPaymentsCollections, // ✅ NUEVO
                remainingBalance: recalculatedRemainingBalance,
                isSettled: false,
                canEdit: true,
                ticketCount: 0,
                ventanaName,
                vendedorName,
            };
        }

        // Si no existe, crear statement para tener un id
        // ✅ Calcular month desde la fecha si no está disponible
        // ✅ CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
        const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        const newStatement = await AccountStatementRepository.findOrCreate({
            date,
            month: monthForStatement,
            ventanaId: correctedVentanaId ?? ventanaId,
            vendedorId,
        });

        // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
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

        return {
            ...newStatement,
            totalSales: 0,
            totalPayouts: 0,
            listeroCommission: 0,
            vendedorCommission: 0,
            balance: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalPaymentsCollections: 0, // ✅ NUEVO
            remainingBalance: 0,
            isSettled: false, // No está saldado si no hay tickets
            canEdit: true,
            ticketCount: 0,
            ventanaName,
            vendedorName,
        };
    }

    // ✅ ACTUALIZADO: Permitir ambos campos cuando hay vendedorId
    // El constraint _one_relation_check ha sido eliminado
    // findOrCreate ahora maneja la inferencia de ventanaId y bancaId automáticamente
    // ✅ CRÍTICO: Usar correctedVentanaId si fue corregido desde los tickets
    let targetBancaId = bancaId ?? undefined;
    let targetVentanaId = correctedVentanaId ?? undefined;
    let targetVendedorId = vendedorId ?? undefined;

    // Crear o actualizar estado de cuenta primero con los valores correctos
    // ✅ Calcular month desde la fecha si no está disponible
    // ✅ findOrCreate ahora infiere automáticamente ventanaId y bancaId cuando es necesario
    const monthForStatement = month || `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const statement = await AccountStatementRepository.findOrCreate({
        date,
        month: monthForStatement,
        bancaId: targetBancaId,
        ventanaId: targetVentanaId,
        vendedorId: targetVendedorId,
    });
    
    // ✅ CRÍTICO: Si el statement encontrado tiene ventanaId: null pero debería tenerlo (corregido desde tickets),
    // actualizarlo para evitar que quede con datos incorrectos
    if (statement.ventanaId === null && correctedVentanaId) {
        await AccountStatementRepository.update(statement.id, {
            ventanaId: correctedVentanaId,
        });
        // Refrescar el statement para tener los datos actualizados
        const updatedStatement = await AccountStatementRepository.findById(statement.id);
        if (updatedStatement) {
            Object.assign(statement, updatedStatement);
        }
    }

    // ✅ ACTUALIZADO: Ya no necesitamos verificar el tipo porque ambos campos pueden estar presentes
    // findOrCreate ya maneja correctamente la búsqueda y creación
    const finalStatement = statement;

    // Obtener total pagado y cobrado después de crear el statement
    const totalPaid = await AccountPaymentRepository.getTotalPaid(finalStatement.id);
    const totalCollected = await AccountPaymentRepository.getTotalCollected(finalStatement.id);
    // ✅ NUEVO: Obtener total de pagos y cobros combinados (no revertidos)
    const totalPaymentsCollections = await AccountPaymentRepository.getTotalPaymentsCollections(finalStatement.id);

    // ✅ CORRECCIÓN: Calcular balance según dimensión + movimientos
    // - Vendedor: balance = totalSales - totalPayouts - vendedorCommission + totalPaid - totalCollected
    // - Ventana/Banca: balance = totalSales - totalPayouts - listeroCommission + totalPaid - totalCollected
    const balance = dimension === "vendedor"
        ? totalSales - totalPayouts - totalVendedorCommission + totalPaid - totalCollected
        : totalSales - totalPayouts - totalListeroCommission + totalPaid - totalCollected;

    // ✅ NUEVO: remainingBalance = balance (ya incluye movimientos, no volver a aplicarlos)
    const remainingBalance = balance;

    // FIX: Usar helper para cálculo consistente de isSettled
    const isSettled = calculateIsSettled(ticketCount, remainingBalance, totalPaid, totalCollected);
    const canEdit = !isSettled;

    // ✅ FIX: Guardar también totalCollected en el statement
    await AccountStatementRepository.update(finalStatement.id, {
        totalSales,
        totalPayouts,
        listeroCommission: totalListeroCommission,
        vendedorCommission: totalVendedorCommission,
        balance,
        totalPaid,
        totalCollected, // ✅ NUEVO: Guardar totalCollected
        remainingBalance,
        isSettled,
        canEdit,
        ticketCount,
        // No cambiar ventanaId/vendedorId aquí - ya están correctos en finalStatement
    });

    // ✅ OPTIMIZACIÓN: Obtener nombres de ventana/vendedor en paralelo si existen
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
        totalPaymentsCollections: parseFloat(totalPaymentsCollections.toFixed(2)), // ✅ NUEVO: Total de pagos y cobros combinados (no revertidos)
        remainingBalance: parseFloat(remainingBalance.toFixed(2)),
        isSettled,
        canEdit,
        ticketCount,
        ventanaId: finalStatement.ventanaId,
        vendedorId: finalStatement.vendedorId,
        ventanaName,
        vendedorName,
    };

    // ✅ OPTIMIZACIÓN: Guardar en caché (no esperar, hacerlo en background)
    setCachedDayStatement(cacheKey, result).catch(() => {
        // Ignorar errores de caché
    });

    return result;
}

/**
 * ✅ NUEVO: Calcula estado de cuenta directamente desde tickets/jugadas
 * Usa EXACTAMENTE la misma lógica que commissions.service.ts
 * Calcula jugada por jugada desde el principio, igual que commissions
 */
export async function getStatementDirect(
    filters: AccountsFilters,
    startDate: Date,
    endDate: Date,
    daysInMonth: number,
    effectiveMonth: string,
    dimension: "banca" | "ventana" | "vendedor", // ✅ NUEVO: Agregado 'banca'
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string,
    userRole: "ADMIN" | "VENTANA" | "VENDEDOR" = "ADMIN",
    sort: "asc" | "desc" = "desc"
) {
    // ✅ CORRECCIÓN: Usar servicio centralizado para conversión de fechas
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(startDate, endDate);

    // ✅ CRÍTICO: Calcular inicio del mes para siempre consultar desde ahí
    // Esto permite calcular el acumulado correcto incluso cuando se filtra por un día específico
    const [yearForMonth, monthForMonth] = effectiveMonth.split("-").map(Number);
    const monthStartDateForQuery = new Date(Date.UTC(yearForMonth, monthForMonth - 1, 1));
    const monthStartDateCRStrForQuery = crDateService.dateUTCToCRString(monthStartDateForQuery);

    /**
     * ========================================================================
     * LÓGICA DE AGRUPACIÓN: shouldGroupByDate
     * ========================================================================
     * 
     * shouldGroupByDate determina si agrupamos múltiples entidades por fecha
     * o si separamos por entidad específica.
     * 
     * shouldGroupByDate = true:
     * - Agrupa múltiples entidades en una sola entrada por fecha
     * - Ejemplo: Todas las bancas del día en una sola entrada
     * - Los movimientos se incluyen sin filtrar por entidad
     * - Útil para vistas globales o cuando no hay filtro específico
     * 
     * shouldGroupByDate = false:
     * - Separa por entidad específica (una entrada por fecha + entidad)
     * - Ejemplo: Una entrada por cada ventana del día
     * - Los movimientos se filtran por la entidad específica
     * - Útil cuando hay un ID específico (bancaId, ventanaId, vendedorId)
     * 
     * REGLAS:
     * - dimension='banca' sin bancaId → true (todas las bancas)
     * - dimension='banca' con bancaId pero sin ventanaId/vendedorId → true (todas las ventanas/vendedores de esa banca)
     * - dimension='ventana' sin ventanaId → true (todas las ventanas)
     * - dimension='vendedor' sin vendedorId → true (todos los vendedores)
     * - Cualquier otra combinación → false (entidad específica)
     * 
     * ========================================================================
     */
    const shouldGroupByDate =
        (dimension === "banca" && (!bancaId || bancaId === "" || bancaId === null)) ||
        (dimension === "banca" && bancaId && !ventanaId && !vendedorId) || // ✅ NUEVO: Agrupar cuando hay bancaId pero múltiples ventanas/vendedores
        (dimension === "ventana" && (!ventanaId || ventanaId === "" || ventanaId === null)) ||
        (dimension === "vendedor" && (!vendedorId || vendedorId === "" || vendedorId === null));

    // ✅ DEBUG: Log para verificar agrupación y rendimiento
    const functionStartTime = Date.now();
    
    // ✅ OPTIMIZACIÓN: Detectar si es "today" (solo un día y es hoy)
    // Para "today", NO cargar todo el mes, solo el día actual (reduce memoria 60-70%)
    const isTodayOnly = startDate.getTime() === endDate.getTime();
    const todayInCR = crDateService.postgresDateToCRString(new Date());
    const queryDateCR = startDateCRStr;
    const isToday = isTodayOnly && queryDateCR === todayInCR;
    
    logger.info({
        layer: "service",
        action: "GET_STATEMENT_DIRECT_START",
        payload: {
            dimension,
            ventanaId: ventanaId || null,
            vendedorId: vendedorId || null,
            bancaId: bancaId || null,
            shouldGroupByDate,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            daysInRange: daysInMonth,
            isToday,
            optimized: isToday ? "yes" : "no",
        },
    });

    // Construir filtros WHERE dinámicos según RBAC (igual que commissions)
    const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        // ✅ CAMBIO: Filtrar EXCLUSIVAMENTE sorteos EVALUATED
        // Ya no permitimos sorteos OPEN, PAID, ACTIVE en el balance
        Prisma.sql`t."status" != 'CANCELLED'`, // Mantener seguridad extra
        Prisma.sql`EXISTS (
            SELECT 1 FROM "Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'EVALUATED'
        )`,
        // ✅ OPTIMIZACIÓN: Si es "today", solo consultar ese día (no desde inicio del mes)
        // Esto reduce significativamente la carga de memoria (de todo el mes a solo un día)
        // Los acumulados mensuales se calcularán después desde account_statements + today
        isToday
            ? Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) = ${startDateCRStr}::date`
            : Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${monthStartDateCRStrForQuery}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${endDateCRStr}::date`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
        Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        )`,
    ];

    // Filtrar por banca activa (para ADMIN multibanca)
    if (bancaId) {
        whereConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v 
      WHERE v.id = t."ventanaId" 
      AND v."bancaId" = ${bancaId}::uuid
    )`);
    }

    // Aplicar filtros de RBAC según dimension
    if (dimension === "banca") {
        // ✅ NUEVO: Filtros para dimension='banca'
        if (bancaId) {
            // Filtrar solo tickets de esta banca específica
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        if (ventanaId) {
            // Filtrar solo listeros de esa banca específica
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
            // Validar que ventanaId pertenece a bancaId (si está presente)
            if (bancaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "Ventana" v 
                    WHERE v.id = ${ventanaId}::uuid
                    AND v."bancaId" = ${bancaId}::uuid
                )`);
            }
        }
        if (vendedorId) {
            // Filtrar solo vendedores de esa banca (y opcionalmente de ese listero)
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
            if (bancaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "Ventana" v 
                    JOIN "User" u ON u."ventanaId" = v.id
                    WHERE u.id = ${vendedorId}::uuid
                    AND v."bancaId" = ${bancaId}::uuid
                )`);
            }
            if (ventanaId) {
                whereConditions.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM "User" u
                    WHERE u.id = ${vendedorId}::uuid
                    AND u."ventanaId" = ${ventanaId}::uuid
                )`);
            }
        }
    } else if (dimension === "vendedor") {
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        // ✅ NUEVO: Si hay bancaId, filtrar solo vendedores de esa banca
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                JOIN "User" u ON u."ventanaId" = v.id
                WHERE u.id = t."vendedorId"
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            whereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        // ✅ NUEVO: Si hay bancaId, filtrar solo listeros de esa banca
        if (bancaId) {
            whereConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v 
                WHERE v.id = t."ventanaId" 
                AND v."bancaId" = ${bancaId}::uuid
            )`);
        }
        // ✅ NUEVO: Si hay vendedorId, filtrar solo vendedores de ese listero
        if (vendedorId) {
            whereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
    }

    // ✅ CRÍTICO: Optimización para dimension='banca' sin bancaId específica
    // Si estamos agrupando por todas las bancas, limitar el rango de fechas y usar índices
    // Agregar límite de fechas más agresivo si no hay filtros específicos
    if (dimension === "banca" && !bancaId && whereConditions.length <= 2) {
        // Solo filtros de fecha básicos, agregar límite de tiempo para evitar consultas masivas
        // Esto previene consultas de años completos cuando solo se necesita un mes
        const maxDaysBack = 90; // Máximo 90 días hacia atrás
        const minDate = new Date(startDate);
        minDate.setUTCDate(minDate.getUTCDate() - maxDaysBack);
        const minDateCR = crDateService.postgresDateToCRString(minDate);
        whereConditions.push(Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${minDateCR}::date`);
    }

    const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

    // ✅ OPTIMIZACIÓN: Usar agregaciones SQL directamente en lugar de traer todas las jugadas
    // Esto reduce significativamente la cantidad de datos transferidos y mejora el rendimiento
    // Usar subquery para calcular payouts correctamente (una vez por ticket, solo si tiene jugadas ganadoras)
    const queryStartTime = Date.now();
    
    // ✅ OPTIMIZACIÓN: Calcular límite dinámico basado en días del mes (evita truncamiento)
    // Estimación: ~200 tickets/día promedio × días en mes = límite seguro
    // Mínimo 5000 para mantener compatibilidad con queries pequeñas
    const dynamicLimit = Math.max(5000, daysInMonth * 200);
    
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_SQL_QUERY_START",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            shouldGroupByDate,
            dynamicLimit,
        },
    });

    // ✅ CRÍTICO: GROUP BY dinámico según shouldGroupByDate
    // Si shouldGroupByDate=true: agrupar solo por (date, banca) para evitar filas duplicadas
    // Si shouldGroupByDate=false: agrupar por (date, banca, ventana, vendedor) para separar por entidad
    const groupByClause = shouldGroupByDate
        ? Prisma.sql`
      COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
      b.id`
        : Prisma.sql`
      COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))),
      b.id,
      t."ventanaId",
      t."vendedorId"`;

    // ✅ OPTIMIZACIÓN CONSERVADORA: Pre-agregar jugadas por ticket usando CTE
    // Esto reduce filas duplicadas de ~5x a 1x (1 fila por ticket en lugar de 1 por jugada)
    // Mantiene exactamente la misma lógica: total_payouts sigue siendo 0 (se calcula desde bySorteo después)
    const query = Prisma.sql`
    WITH jugada_aggregates AS (
      SELECT 
        j."ticketId",
        COALESCE(SUM(j.amount), 0) as total_amount,
        COALESCE(SUM(j."listeroCommissionAmount"), 0) as total_listero_commission,
        COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as total_vendedor_commission
      FROM "Jugada" j
      WHERE j."deletedAt" IS NULL
      GROUP BY j."ticketId"
    )
    SELECT
      COALESCE(
        t."businessDate",
        DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
      ) as business_date,
      b.id as banca_id,
      MAX(b.name) as banca_name,
      MAX(b.code) as banca_code,
      ${shouldGroupByDate ? Prisma.sql`NULL::uuid` : Prisma.sql`t."ventanaId"`} as ventana_id,
      MAX(v.name) as ventana_name,
      MAX(v.code) as ventana_code,
      ${shouldGroupByDate ? Prisma.sql`NULL::uuid` : Prisma.sql`t."vendedorId"`} as vendedor_id,
      MAX(u.name) as vendedor_name,
      MAX(u.code) as vendedor_code,
      COALESCE(SUM(ja.total_amount), 0) as total_sales,
      0 as total_payouts,
      COUNT(DISTINCT t.id) as total_tickets,
      COALESCE(SUM(ja.total_listero_commission), 0) as commission_listero,
      COALESCE(SUM(ja.total_vendedor_commission), 0) as commission_vendedor
    FROM "Ticket" t
    LEFT JOIN jugada_aggregates ja ON ja."ticketId" = t.id
    INNER JOIN "Ventana" v ON v.id = t."ventanaId"
    INNER JOIN "Banca" b ON b.id = v."bancaId"
    LEFT JOIN "User" u ON u.id = t."vendedorId"
    WHERE ${Prisma.join(whereConditions, " AND ")}
    GROUP BY ${groupByClause}
    ORDER BY business_date ${sort === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`}
    -- ✅ OPTIMIZACIÓN: Límite dinámico basado en días del mes (evita truncamiento)
    LIMIT ${dynamicLimit}
  `;

    const aggregatedData = await prisma.$queryRaw<
        Array<{
            business_date: Date;
            banca_id: string | null;
            banca_name: string | null;
            banca_code: string | null;
            ventana_id: string;
            ventana_name: string;
            ventana_code: string | null;
            vendedor_id: string | null;
            vendedor_name: string | null;
            vendedor_code: string | null;
            total_sales: number;
            total_payouts: number;
            total_tickets: bigint;
            commission_listero: number;
            commission_vendedor: number;
        }>
    >(query);

    const queryEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_SQL_QUERY_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            rowsReturned: aggregatedData.length,
            queryTimeMs: queryEndTime - queryStartTime,
        },
    });

    // ✅ CRÍTICO: Agrupar jugadas por día y banca/ventana/vendedor, calculando comisiones jugada por jugada
    // EXACTAMENTE igual que commissions (líneas 403-492)
    // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha (sin separar por entidad)
    const byDateAndDimension = new Map<
        string,
        {
            bancaId: string | null; // ✅ NUEVO: ID de banca
            bancaName: string | null; // ✅ NUEVO: Nombre de banca
            bancaCode: string | null; // ✅ NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; // ✅ NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; // ✅ NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set (reduce memoria 20-30%)
            commissionListero: number;
            commissionVendedor: number;
            payoutTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set
        }
    >();

    // ✅ NUEVO: Mapa para desglose por entidad (byBanca/byVentana/byVendedor) cuando hay agrupación
    const breakdownByEntity = new Map<
        string, // `${dateKey}_${entityId}` o `${dateKey}_${bancaId}` o `${dateKey}_${ventanaId}` o `${dateKey}_${vendedorId}`
        {
            bancaId: string | null; // ✅ NUEVO: ID de banca
            bancaName: string | null; // ✅ NUEVO: Nombre de banca
            bancaCode: string | null; // ✅ NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; // ✅ NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; // ✅ NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set (reduce memoria 20-30%)
            commissionListero: number;
            commissionVendedor: number;
            payoutTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set
        }
    >();

    // 🔍 DEBUG: Contador para ver cuántas filas SQL por fecha
    const rowsPerDate = new Map<string, number>();

    // ✅ OPTIMIZACIÓN: Procesar datos agregados en lugar de jugadas individuales
    for (const row of aggregatedData) {
        const dateKey = crDateService.postgresDateToCRString(row.business_date);

        // ✅ NOTA: NO filtrar aquí - necesitamos todos los días del mes para calcular acumulados correctos
        // El filtro se aplicará al final después de calcular la acumulación

        // 🔍 DEBUG: Contar filas por fecha
        rowsPerDate.set(dateKey, (rowsPerDate.get(dateKey) || 0) + 1);

        // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
        // ✅ CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar ese ID directamente
        // para asegurar que todas las filas SQL se agrupen correctamente en una sola entrada por día
        const groupKey = shouldGroupByDate
            ? dateKey // Solo fecha cuando hay agrupación
            : (dimension === "banca"
                ? `${dateKey}_${bancaId || row.banca_id || 'null'}`
                : dimension === "ventana"
                    ? `${dateKey}_${ventanaId || row.ventana_id}`
                    : `${dateKey}_${vendedorId || row.vendedor_id || 'null'}`);

        // Clave para el desglose por entidad (siempre incluye entidad)
        const breakdownKey = dimension === "banca"
            ? `${dateKey}_${row.banca_id || 'null'}`
            : dimension === "ventana"
                ? `${dateKey}_${row.ventana_id}`
                : `${dateKey}_${row.vendedor_id || 'null'}`;

        // Obtener o crear entrada principal (agrupada por fecha si shouldGroupByDate)
        let entry = byDateAndDimension.get(groupKey);
        if (!entry) {
            entry = {
                bancaId: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_id : null),
                bancaName: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_name : null),
                bancaCode: shouldGroupByDate ? null : (dimension === "banca" ? row.banca_code : null),
                ventanaId: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_id : null),
                ventanaName: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_name : null),
                ventanaCode: shouldGroupByDate ? null : (dimension === "ventana" ? row.ventana_code : null),
                vendedorId: shouldGroupByDate ? null : (dimension === "vendedor" ? (vendedorId || row.vendedor_id) : null),
                vendedorName: shouldGroupByDate ? null : (dimension === "vendedor" ? row.vendedor_name : null),
                vendedorCode: shouldGroupByDate ? null : (dimension === "vendedor" ? row.vendedor_code : null),
                totalSales: 0,
                totalPayouts: 0,
                totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
            };
            byDateAndDimension.set(groupKey, entry);
        }

        // ✅ NUEVO: Mantener desglose por entidad cuando hay agrupación
        if (shouldGroupByDate) {
            let breakdownEntry = breakdownByEntity.get(breakdownKey);
            if (!breakdownEntry) {
                breakdownEntry = {
                    bancaId: dimension === "banca" ? row.banca_id : null,
                    bancaName: dimension === "banca" ? row.banca_name : null,
                    bancaCode: dimension === "banca" ? row.banca_code : null,
                    ventanaId: dimension === "ventana" ? row.ventana_id : (dimension === "banca" ? row.ventana_id : null),
                    ventanaName: dimension === "ventana" ? row.ventana_name : (dimension === "banca" ? row.ventana_name : null),
                    ventanaCode: dimension === "ventana" ? row.ventana_code : (dimension === "banca" ? row.ventana_code : null),
                    vendedorId: dimension === "vendedor" ? row.vendedor_id : null,
                    vendedorName: dimension === "vendedor" ? row.vendedor_name : null,
                    vendedorCode: dimension === "vendedor" ? row.vendedor_code : null,
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                };
                breakdownByEntity.set(breakdownKey, breakdownEntry);
            }

            // Actualizar desglose por entidad (ya agregado desde SQL)
            if (breakdownEntry) {
                breakdownEntry.totalSales += Number(row.total_sales || 0);
                // ✅ NOTA: totalPayouts se calcula desde bySorteo, NO desde SQL
                breakdownEntry.commissionListero += Number(row.commission_listero || 0);
                breakdownEntry.commissionVendedor += Number(row.commission_vendedor || 0);
                // ✅ OPTIMIZACIÓN: Usar contador directo en lugar de Set sintético (reduce memoria)
                const ticketCount = Number(row.total_tickets || 0);
                breakdownEntry.totalTicketsCount = ticketCount;
            }
        }

        // Actualizar entrada principal (agrupada) - ya agregado desde SQL
        entry.totalSales += Number(row.total_sales || 0);
        entry.totalPayouts += Number(row.total_payouts || 0);
        entry.commissionListero += Number(row.commission_listero || 0);
        entry.commissionVendedor += Number(row.commission_vendedor || 0);
        // ✅ OPTIMIZACIÓN: Usar contador directo en lugar de Set sintético (reduce memoria)
        // ✅ CRÍTICO: Acumular ticketCount en lugar de asignarlo directamente
        // Cuando hay múltiples filas SQL para el mismo día (por ejemplo, vendedor en diferentes ventanas),
        // necesitamos acumular el conteo, no sobrescribirlo
        entry.totalTicketsCount += Number(row.total_tickets || 0);
    }

    // ✅ CRÍTICO: Obtener movimientos desde el inicio del mes para calcular acumulados correctos
    const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        monthStartDateForQuery,
        endDate,
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );

    // ✅ NUEVO: Obtener saldos del mes anterior para agregarlos como movimiento especial al primer día
    // Esto permite que el saldo se intercale naturalmente con los sorteos, igual que los pagos/cobros
    const firstDayOfMonthStr = `${yearForMonth}-${String(monthForMonth).padStart(2, '0')}-01`;
    const previousMonthBalancesByEntity = new Map<string, number>();
    
    // ✅ CRÍTICO: Obtener saldo del mes anterior ANTES de procesar statements
    // Esto asegura que el movimiento especial esté disponible incluso si no hay ventas el primer día
    let previousMonthBalanceForMovement: number = 0;
    if (dimension === "banca") {
        previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
            effectiveMonth,
            "banca",
            undefined,
            undefined,
            bancaId || null
        );
    } else if (dimension === "ventana") {
        previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
            effectiveMonth,
            "ventana",
            ventanaId || null,
            undefined,
            bancaId
        );
    } else {
        previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
            effectiveMonth,
            "vendedor",
            undefined,
            vendedorId || null,
            bancaId
        );
    }
    
    // ✅ CRÍTICO: Agregar movimiento especial directamente a movementsByDate para el primer día
    // Esto asegura que esté disponible incluso si no hay ventas ni movimientos ese día
    if (previousMonthBalanceForMovement !== 0) {
        const firstDayMovements = movementsByDate.get(firstDayOfMonthStr) || [];
        const entityId = dimension === "banca" 
            ? (bancaId || 'null')
            : dimension === "ventana"
                ? (ventanaId || 'null')
                : (vendedorId || 'null');
        
        // Agregar movimiento especial al inicio del día
        firstDayMovements.unshift({
            id: `previous-month-balance-${entityId}`,
            type: "payment" as const,
            amount: previousMonthBalanceForMovement,
            method: "Saldo del mes anterior",
            notes: `Saldo arrastrado del mes anterior`,
            isReversed: false,
            createdAt: new Date(`${firstDayOfMonthStr}T00:00:00.000Z`).toISOString(),
            date: firstDayOfMonthStr,
            time: "00:00",
            balance: previousMonthBalanceForMovement,
            bancaId: dimension === "banca" ? (bancaId || null) : null,
            ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
            vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
        });
        movementsByDate.set(firstDayOfMonthStr, firstDayMovements);
    }
    
    // Obtener todas las entidades únicas que aparecerán en los statements (para casos con múltiples entidades)
    const allEntityIdsForPreviousBalance = new Set<string>();
    for (const [dateKey, entry] of byDateAndDimension.entries()) {
        let entityId: string;
        if (dimension === "banca") {
            entityId = entry.bancaId || 'null';
        } else if (dimension === "ventana") {
            entityId = entry.ventanaId || 'null';
        } else {
            entityId = entry.vendedorId || 'null';
        }
        allEntityIdsForPreviousBalance.add(entityId);
    }
    
    // Obtener saldos del mes anterior para cada entidad (para casos con múltiples entidades)
    for (const entityId of allEntityIdsForPreviousBalance) {
        let balance: number;
        if (dimension === "banca") {
            balance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "banca",
                undefined,
                undefined,
                entityId === 'null' ? null : entityId
            );
        } else if (dimension === "ventana") {
            balance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "ventana",
                entityId === 'null' ? null : entityId,
                undefined,
                bancaId
            );
        } else {
            balance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "vendedor",
                undefined,
                entityId === 'null' ? null : entityId,
                bancaId
            );
        }
        previousMonthBalancesByEntity.set(entityId, Number(balance));
    }

    // ✅ NUEVO: Incorporar días que solo tienen movimientos (sin ventas)
    // ✅ NOTA: NO filtrar aquí - necesitamos todos los movimientos del mes para calcular acumulados correctos
    // ✅ CRÍTICO: Asegurar que el primer día tenga una entrada en byDateAndDimension si hay movimiento especial
    if (previousMonthBalanceForMovement !== 0 && !byDateAndDimension.has(firstDayOfMonthStr)) {
        // Crear entrada vacía para el primer día si no existe (para que el movimiento especial se muestre)
        byDateAndDimension.set(firstDayOfMonthStr, {
            bancaId: dimension === "banca" ? (bancaId || null) : null,
            bancaName: null,
            bancaCode: null,
            ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
            ventanaName: null,
            ventanaCode: null,
            vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
            vendedorName: null,
            vendedorCode: null,
            totalSales: 0,
            totalPayouts: 0,
            totalTicketsCount: 0,
            commissionListero: 0,
            commissionVendedor: 0,
            payoutTicketsCount: 0,
        });
    }
    
    for (const [dateKey, movements] of movementsByDate.entries()) {
        // El filtro se aplicará al final después de calcular la acumulación

        for (const movement of movements) {
            // Determinar ID según dimensión
            const targetId = dimension === "banca"
                ? movement.bancaId
                : dimension === "ventana"
                    ? movement.ventanaId
                    : movement.vendedorId;
            // Si estamos filtrando por dimensión y el movimiento no coincide, ignorar (aunque el repo ya filtra)
            if (dimension === "banca" && bancaId && targetId !== bancaId) continue;
            if (dimension === "ventana" && ventanaId && targetId !== ventanaId) continue;
            if (dimension === "vendedor" && vendedorId && targetId !== vendedorId) continue;

            // ✅ NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
            // ✅ CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar ese ID directamente
            // para asegurar que todos los movimientos se agrupen correctamente en una sola entrada por día
            const groupKey = shouldGroupByDate
                ? dateKey // Solo fecha cuando hay agrupación
                : (dimension === "banca"
                    ? `${dateKey}_${bancaId || targetId || 'null'}`
                    : dimension === "ventana"
                        ? `${dateKey}_${ventanaId || targetId || 'null'}`
                        : `${dateKey}_${vendedorId || targetId || 'null'}`);

            if (!byDateAndDimension.has(groupKey)) {
                // Crear entrada vacía si no existe (día sin ventas)
                byDateAndDimension.set(groupKey, {
                    bancaId: shouldGroupByDate ? null : (dimension === "banca" ? movement.bancaId : null),
                    bancaName: shouldGroupByDate ? null : (dimension === "banca" ? (movement.bancaName || "Desconocido") : null),
                    bancaCode: shouldGroupByDate ? null : (dimension === "banca" ? movement.bancaCode : null),
                    ventanaId: shouldGroupByDate ? null : (dimension === "ventana" ? movement.ventanaId : (dimension === "banca" ? movement.ventanaId : null)),
                    ventanaName: shouldGroupByDate ? null : (dimension === "ventana" ? (movement.ventanaName || "Desconocido") : (dimension === "banca" ? (movement.ventanaName || "Desconocido") : null)),
                    ventanaCode: shouldGroupByDate ? null : (dimension === "ventana" ? movement.ventanaCode : (dimension === "banca" ? movement.ventanaCode : null)),
                    vendedorId: shouldGroupByDate ? null : (dimension === "vendedor" ? (vendedorId || movement.vendedorId) : null),
                    vendedorName: shouldGroupByDate ? null : (dimension === "vendedor" ? (movement.vendedorName || "Desconocido") : null),
                    vendedorCode: shouldGroupByDate ? null : (dimension === "vendedor" ? movement.vendedorCode : null),
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                });
            }
        }
    }

    // Obtener desglose por sorteo
    // ✅ CRÍTICO: Si shouldGroupByDate=true, las claves son solo fechas; si no, son fecha_entidad
    const statementDates = Array.from(new Set(
        Array.from(byDateAndDimension.keys()).map(k => {
            // Si shouldGroupByDate=true, la clave es solo la fecha; si no, extraer fecha de fecha_entidad
            const dateStr = shouldGroupByDate ? k : k.split("_")[0];
            return dateStr;
        })
    )).map(d => {
        const [year, month, day] = d.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    });

    const sorteoBreakdownBatch = await getSorteoBreakdownBatch(statementDates, dimension, ventanaId, vendedorId, bancaId, userRole);

    // Construir statements desde el mapa agrupado
    // ✅ NOTA: NO filtrar aquí - necesitamos todos los días del mes para calcular acumulados correctos
    // El filtro se aplicará al final después de calcular la acumulación
    // ✅ CRÍTICO: Procesar días en orden SECUENCIAL (no paralelo) para arrastrar acumulados correctamente
    // El acumulado progresivo requiere que cada día se procese después del anterior
    // Mantener un mapa del último accumulated por entidad para cada día
    const lastAccumulatedByEntity = new Map<string, number>(); // Clave: `${date}_${entityId}`, Valor: último accumulated
    
    // Ordenar entradas por fecha ASC para procesar en orden cronológico
    const sortedEntries = Array.from(byDateAndDimension.entries()).sort(([keyA], [keyB]) => {
        const dateA = shouldGroupByDate ? keyA : keyA.split("_")[0];
        const dateB = shouldGroupByDate ? keyB : keyB.split("_")[0];
        return dateA.localeCompare(dateB); // ASC
    });
    
    // ✅ CRÍTICO: Crear entradas para días que no tienen tickets pero están entre días con tickets
    // SOLO cuando se consulta un rango completo (no para "today" o "este mes")
    // Esto asegura que días sin ventas (como el 25 en diciembre) se procesen y guarden
    // Pero NO ralentiza consultas de "today" o "este mes"
    const isFullMonthQuery = startDateCRStr === firstDayOfMonthStr && endDateCRStr >= `${yearForMonth}-${String(monthForMonth).padStart(2, '0')}-${new Date(yearForMonth, monthForMonth, 0).getDate()}`;
    
    if (isFullMonthQuery && sortedEntries.length > 1) {
        // Solo crear entradas faltantes para consultas de mes completo con múltiples días
        const allDatesInRange = new Set<string>();
        for (const [key] of sortedEntries) {
            const date = shouldGroupByDate ? key : key.split("_")[0];
            allDatesInRange.add(date);
        }
        
        // Obtener el rango de fechas (primer y último día)
        const sortedDatesArray = Array.from(allDatesInRange).sort();
        if (sortedDatesArray.length > 0) {
            const firstDate = sortedDatesArray[0];
            const lastDate = sortedDatesArray[sortedDatesArray.length - 1];
            const [firstYear, firstMonth, firstDay] = firstDate.split('-').map(Number);
            const [lastYear, lastMonth, lastDay] = lastDate.split('-').map(Number);
            
            // Crear entradas para todos los días entre el primero y el último
            const firstDateObj = new Date(Date.UTC(firstYear, firstMonth - 1, firstDay));
            const lastDateObj = new Date(Date.UTC(lastYear, lastMonth - 1, lastDay));
            
            for (let d = new Date(firstDateObj); d <= lastDateObj; d.setUTCDate(d.getUTCDate() + 1)) {
                const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
                
                // Si no existe entrada para este día, crear una vacía
                if (!allDatesInRange.has(dateStr)) {
                    const groupKey = shouldGroupByDate ? dateStr : `${dateStr}_null`;
                    if (!byDateAndDimension.has(groupKey)) {
                        byDateAndDimension.set(groupKey, {
                            bancaId: dimension === "banca" ? (bancaId || null) : null,
                            bancaName: null,
                            bancaCode: null,
                            ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
                            ventanaName: null,
                            ventanaCode: null,
                            vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
                            vendedorName: null,
                            vendedorCode: null,
                            totalSales: 0,
                            totalPayouts: 0,
                            totalTicketsCount: 0,
                            commissionListero: 0,
                            commissionVendedor: 0,
                            payoutTicketsCount: 0,
                        });
                    }
                }
            }
        }
    }
    
    // Re-ordenar entradas después de agregar días faltantes (si se agregaron)
    const sortedEntriesFinal = Array.from(byDateAndDimension.entries()).sort(([keyA], [keyB]) => {
        const dateA = shouldGroupByDate ? keyA : keyA.split("_")[0];
        const dateB = shouldGroupByDate ? keyB : keyB.split("_")[0];
        return dateA.localeCompare(dateB); // ASC
    });
    
    // ✅ CRÍTICO: Procesar en orden SECUENCIAL, no en paralelo
    // Esto asegura que el acumulado del día anterior esté disponible cuando se procesa el día actual
    const allStatementsFromMonth: any[] = [];
    for (const [key, entry] of sortedEntriesFinal) {
        const statement = await (async () => {
            // ✅ NUEVO: Si shouldGroupByDate=true, la clave es solo la fecha; si no, es fecha_entidad
            const date = shouldGroupByDate ? key : key.split("_")[0];

            // ✅ NUEVO: Obtener movimientos y desglose por sorteo según si hay agrupación
            // El movimiento especial "Saldo del mes anterior" ya está en movementsByDate para el primer día
            const allMovementsForDate = movementsByDate.get(date) || [];
            let movementsWithPreviousBalance = [...allMovementsForDate];
            
            // ✅ CRÍTICO: Si es el primer día del mes y hay saldo del mes anterior, asegurar que el movimiento especial esté incluido
            if (date === firstDayOfMonthStr && previousMonthBalanceForMovement !== 0) {
                const hasPreviousMonthMovement = movementsWithPreviousBalance.some(m => 
                    m.id && m.id.startsWith('previous-month-balance-')
                );
                if (!hasPreviousMonthMovement) {
                    // Agregar el movimiento especial si no está presente
                    const entityId = dimension === "banca" 
                        ? (bancaId || 'null')
                        : dimension === "ventana"
                            ? (ventanaId || 'null')
                            : (vendedorId || 'null');
                    movementsWithPreviousBalance.unshift({
                        id: `previous-month-balance-${entityId}`,
                        type: "payment" as const,
                        amount: previousMonthBalanceForMovement,
                        method: "Saldo del mes anterior",
                        notes: `Saldo arrastrado del mes anterior`,
                        isReversed: false,
                        createdAt: new Date(`${firstDayOfMonthStr}T00:00:00.000Z`).toISOString(),
                        date: firstDayOfMonthStr,
                        time: "00:00",
                        balance: previousMonthBalanceForMovement,
                        bancaId: dimension === "banca" ? (bancaId || null) : null,
                        ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
                        vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
                    });
                }
            }
            
            let movements: any[];
            let bySorteo: any[];

            /**
             * ========================================================================
             * FILTRADO DE MOVIMIENTOS PARA INTERCALACIÓN
             * ========================================================================
             * 
             * REGLA CRÍTICA DE RETROCOMPATIBILIDAD:
             * Los movimientos DEBEN incluirse correctamente según la dimensión y filtros
             * para que se intercalen con los sorteos en el historial del día.
             * 
             * Cuando shouldGroupByDate = true:
             * - Incluir TODOS los movimientos del día sin filtrar
             * - Útil para vistas globales donde se agrupan múltiples entidades
             * 
             * Cuando shouldGroupByDate = false:
             * - Filtrar movimientos por la entidad específica de esta entrada
             * - PRIORIDAD: Usar el ID del filtro directamente (más confiable que entry.ventanaId)
             * - Esto asegura que cuando se filtra por ventanaId específico, se incluyan
             *   TODOS los movimientos de esa ventana (consolidados + de vendedores)
             * 
             * IMPORTANTE:
             * - findMovementsByDateRange ya filtra en la BD según dimension y filtros
             * - Cuando dimension='ventana' y hay ventanaId, findMovementsByDateRange
             *   incluye TODOS los movimientos de esa ventana (no solo consolidados)
             * - Este filtro adicional es una capa de seguridad para asegurar que solo
             *   se incluyan movimientos de la entidad correcta
             * 
             * ========================================================================
             */
            // ✅ CRÍTICO: Inicializar movements ANTES de cualquier uso (necesario tanto si hay caché como si no)
            // Usar movementsWithPreviousBalance que incluye el saldo del mes anterior como movimiento especial
            if (shouldGroupByDate) {
                movements = movementsWithPreviousBalance;
            } else {
                // Sin agrupación: filtrar por entidad
                // ✅ CRÍTICO: Cuando hay un ID específico en el filtro (bancaId, ventanaId, vendedorId),
                // findMovementsByDateRange ya filtra correctamente en la BD, pero puede haber múltiples entidades
                // en byDateAndDimension. Necesitamos filtrar por la entidad específica de esta entrada.
                // PRIORIDAD: Usar el ID del filtro directamente cuando está presente (más confiable que entry.ventanaId)
                // ✅ CRÍTICO: Usar movementsWithPreviousBalance (no allMovementsForDate) para incluir el movimiento especial
                movements = movementsWithPreviousBalance.filter((m: any) => {
                    // ✅ CRÍTICO: El movimiento especial "Saldo del mes anterior" debe incluirse siempre si corresponde a esta entidad
                    if (m.id?.startsWith('previous-month-balance-')) {
                        let entityId: string;
                        if (dimension === "banca") {
                            entityId = entry.bancaId || 'null';
                        } else if (dimension === "ventana") {
                            entityId = entry.ventanaId || 'null';
                        } else {
                            entityId = entry.vendedorId || 'null';
                        }
                        return m.id === `previous-month-balance-${entityId}`;
                    }
                    
                    if (dimension === "banca") {
                        // ✅ CRÍTICO: Usar bancaId del filtro si está presente (más confiable)
                        // Si no hay filtro, usar entry.bancaId (puede ser null si hay múltiples bancas)
                        const targetBancaId = bancaId || entry.bancaId;
                        return targetBancaId ? m.bancaId === targetBancaId : true; // Si no hay target, incluir todos
                    } else if (dimension === "ventana") {
                        // ✅ CRÍTICO: Usar ventanaId del filtro si está presente (más confiable)
                        // Esto asegura que cuando se filtra por ventanaId específico, se incluyan todos los movimientos de esa ventana
                        // findMovementsByDateRange ya filtra por ventanaId cuando dimension='ventana' y hay ventanaId,
                        // pero este filtro adicional asegura que solo se incluyan movimientos de la entidad correcta
                        const targetVentanaId = ventanaId || entry.ventanaId;
                        return targetVentanaId ? m.ventanaId === targetVentanaId : true; // Si no hay target, incluir todos
                    } else {
                        // ✅ CRÍTICO: Usar vendedorId del filtro si está presente (más confiable)
                        const targetVendedorId = vendedorId || entry.vendedorId;
                        return targetVendedorId ? m.vendedorId === targetVendedorId : true; // Si no hay target, incluir todos
                    }
                });
            }

            // ✅ OPTIMIZACIÓN: Intentar obtener bySorteo del caché primero (TTL 1 hora)
            // La clave de caché debe reflejar exactamente cómo se calcula bySorteo
            const bySorteoCacheKey = {
                date,
                dimension,
                ventanaId: shouldGroupByDate ? null : (ventanaId || entry.ventanaId || null),
                vendedorId: shouldGroupByDate ? null : (vendedorId || entry.vendedorId || null),
                bancaId: shouldGroupByDate ? null : (bancaId || entry.bancaId || null),
            };
            let cachedBySorteo = await getCachedBySorteo(bySorteoCacheKey);

            // Si está en caché, usarlo directamente; sino calcularlo
            if (cachedBySorteo && cachedBySorteo.length > 0) {
                logger.info({
                    layer: 'cache',
                    action: 'BY_SORTEO_CACHE_HIT',
                    payload: { date, dimension, ventanaId, vendedorId, bancaId }
                });
                bySorteo = cachedBySorteo;
            } else {
                // Calcular bySorteo desde sorteoBreakdownBatch
                if (shouldGroupByDate) {
                    // movements ya está inicializado arriba

                    // ✅ NUEVO: Agrupar bySorteo por fecha solamente (sumar todos los sorteos de todas las entidades)
                    // sorteoBreakdownBatch es un Map<string, Array<...>> donde la clave es `${date}_${ventanaId}` o `${date}_${vendedorId}`
                    const sorteoMap = new Map<string, any>();
                    for (const [sorteoKey, sorteoDataArray] of sorteoBreakdownBatch.entries()) {
                        const sorteoDate = sorteoKey.split("_")[0];
                        if (sorteoDate === date) {
                            // sorteoDataArray es un array de sorteos para esta fecha y entidad
                            for (const sorteoData of sorteoDataArray) {
                                const sorteoId = sorteoData.sorteoId;
                                if (sorteoId) {
                                    const existing = sorteoMap.get(sorteoId);
                                    if (existing) {
                                        // Sumar campos numéricos
                                        existing.sales += sorteoData.sales;
                                        existing.payouts += sorteoData.payouts;
                                        existing.listeroCommission += sorteoData.listeroCommission;
                                        existing.vendedorCommission += sorteoData.vendedorCommission;
                                        // ✅ CORRECCIÓN: Balance usando vendedorCommission si vendedorId está presente, sino listeroCommission
                                        const commissionToUse = vendedorId ? existing.vendedorCommission : existing.listeroCommission;
                                        existing.balance = existing.sales - existing.payouts - commissionToUse;
                                        existing.ticketCount += sorteoData.ticketCount;
                                    } else {
                                        sorteoMap.set(sorteoId, {
                                            sorteoId: sorteoData.sorteoId,
                                            sorteoName: sorteoData.sorteoName,
                                            loteriaId: sorteoData.loteriaId,
                                            loteriaName: sorteoData.loteriaName,
                                            scheduledAt: sorteoData.scheduledAt,
                                            sales: sorteoData.sales,
                                            payouts: sorteoData.payouts,
                                            listeroCommission: sorteoData.listeroCommission,
                                            vendedorCommission: sorteoData.vendedorCommission,
                                            // ✅ CORRECCIÓN: Balance usando vendedorCommission si vendedorId está presente, sino listeroCommission
                                            balance: sorteoData.sales - sorteoData.payouts - (vendedorId ? sorteoData.vendedorCommission : sorteoData.listeroCommission),
                                            ticketCount: sorteoData.ticketCount,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    bySorteo = Array.from(sorteoMap.values()).sort((a, b) =>
                        new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
                    );

                    // ✅ NOTA: sorteoAccumulated se calculará después en intercalateSorteosAndMovements
                    // para incluir movimientos en el acumulado progresivo
                } else {
                    // movements ya está inicializado arriba (línea ~1012)
                    // Obtener desglose por sorteo usando clave según dimensión
                    // ✅ CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar directamente ese ID
                    // Esto asegura que se use la misma clave que en getSorteoBreakdownBatch
                    const sorteoKey = dimension === "banca"
                        ? `${date}_${bancaId || entry.bancaId || 'null'}`
                        : dimension === "ventana"
                            ? `${date}_${ventanaId || entry.ventanaId}`
                            : `${date}_${vendedorId || entry.vendedorId || 'null'}`;
                    bySorteo = sorteoBreakdownBatch.get(sorteoKey) || [];

                    // ✅ NOTA: sorteoAccumulated se calculará después en intercalateSorteosAndMovements
                    // para incluir movimientos en el acumulado progresivo
                }

                // Guardar en caché en background (no esperar) si hay datos
                if (bySorteo.length > 0) {
                    setCachedBySorteo(bySorteoCacheKey, bySorteo).catch(() => {
                        // Ignorar errores de caché
                    });
                }
            }

            // ✅ CRÍTICO: Calcular totalPayouts sumando desde bySorteo en lugar de la query SQL
            // Esto evita la multiplicación por número de jugadas que ocurría en el JOIN
            const totalPayouts = bySorteo.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

            // ✅ CRÍTICO: Usar comisión correcta según dimensión
            // - Si dimension='vendedor' → usar commissionVendedor
            // - Si dimension='banca' o 'ventana' → usar commissionListero (siempre)
            const commissionToUse = dimension === "vendedor" ? entry.commissionVendedor : entry.commissionListero;

            // Calcular totales de pagos y cobros del DÍA (para el statement diario)
            // ✅ CRÍTICO: Excluir el movimiento especial "Saldo del mes anterior" de los totales del día
            // Solo debe afectar el acumulado, no los totales de pagos/cobros del día
            const totalPaid = Number(movements
                .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0));
            const totalCollected = Number(movements
                .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0));

            // ✅ CRÍTICO: Balance del día = ventas - premios - comisiones + movimientos
            // Los movimientos (pagos/cobros) deben participar en el balance diario
            // payment = positivo (aumenta balance), collection = negativo (disminuye balance)
            const balance = entry.totalSales - totalPayouts - commissionToUse + totalPaid - totalCollected;

            // ✅ CRÍTICO: remainingBalance debe ser ACUMULADO REAL hasta esta fecha
            // NO debe depender del filtro de periodo aplicado
            // Se calculará más adelante usando monthlyByDateAndDimension (línea ~1420)
            const remainingBalance = 0; // Temporal, se calcula después

            // ✅ NUEVO: Intercalar sorteos y movimientos en una lista unificada
            // El saldo del mes anterior ya está incluido como movimiento especial en movements
            // ✅ CRÍTICO: Obtener el acumulado del día anterior para arrastrar el acumulado progresivo
            // Para el primer día del mes, incluir el saldo del mes anterior
            // Para días siguientes, usar el último accumulated del día anterior de la misma entidad
            let initialAccumulated = 0;
            
            // ✅ CORREGIDO: Calcular clave de entidad de forma consistente
            // Cuando dimension="banca" sin bancaId específico, agrupar por fecha (no por bancaId)
            // Esto asegura que el acumulado progresivo funcione correctamente cuando hay múltiples statements por día
            const entityKey = shouldGroupByDate 
                ? date // Si hay agrupación, usar solo la fecha
                : dimension === "banca" && !bancaId
                    ? date // ✅ CORREGIDO: Si dimension=banca sin bancaId, agrupar por fecha
                    : dimension === "banca"
                        ? `${date}_${bancaId || entry.bancaId || 'null'}`
                        : dimension === "ventana"
                            ? `${date}_${ventanaId || entry.ventanaId || 'null'}`
                            : `${date}_${vendedorId || entry.vendedorId || 'null'}`;
            
            // ✅ CRÍTICO: Si es el primer día del mes, incluir el saldo del mes anterior
            if (date === firstDayOfMonthStr) {
                let entityIdForPreviousMonth: string;
                if (dimension === "banca") {
                    entityIdForPreviousMonth = entry.bancaId || bancaId || 'null';
                } else if (dimension === "ventana") {
                    entityIdForPreviousMonth = entry.ventanaId || ventanaId || 'null';
                } else {
                    entityIdForPreviousMonth = entry.vendedorId || vendedorId || 'null';
                }
                // ✅ CRÍTICO: Intentar obtener el saldo específico de la entidad, sino usar el general
                let previousMonthBalance = previousMonthBalancesByEntity.get(entityIdForPreviousMonth);
                if (previousMonthBalance === undefined || previousMonthBalance === 0) {
                    // Si no hay saldo específico, usar el saldo general del mes anterior
                    previousMonthBalance = previousMonthBalanceForMovement;
                }
                initialAccumulated = Number(previousMonthBalance);
            } else {
                // Calcular fecha del día anterior
                const [year, month, day] = date.split('-').map(Number);
                const previousDayDate = new Date(Date.UTC(year, month - 1, day));
                previousDayDate.setUTCDate(previousDayDate.getUTCDate() - 1);
                const previousDateStr = `${previousDayDate.getUTCFullYear()}-${String(previousDayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(previousDayDate.getUTCDate()).padStart(2, '0')}`;
                
                // ✅ CRÍTICO: Intentar obtener el remainingBalance del día anterior desde AccountStatement
                // Esto es más confiable que depender solo de lastAccumulatedByEntity
                let previousDayRemainingBalance: number | null = null;
                
                try {
                    // Determinar IDs para buscar el statement del día anterior
                    let targetBancaId: string | undefined = undefined;
                    let targetVentanaId: string | undefined = undefined;
                    let targetVendedorId: string | undefined = undefined;
                    
                    if (dimension === "banca") {
                        if (bancaId) {
                            targetBancaId = bancaId;
                        } else {
                            targetBancaId = entry.bancaId || undefined;
                            targetVentanaId = entry.ventanaId || undefined;
                            targetVendedorId = entry.vendedorId || undefined;
                        }
                    } else if (dimension === "ventana") {
                        if (ventanaId) {
                            targetBancaId = entry.bancaId || undefined;
                            targetVentanaId = ventanaId;
                        } else {
                            targetBancaId = entry.bancaId || undefined;
                            targetVentanaId = entry.ventanaId || undefined;
                            targetVendedorId = entry.vendedorId || undefined;
                        }
                    } else if (dimension === "vendedor") {
                        targetBancaId = entry.bancaId || undefined;
                        targetVentanaId = entry.ventanaId || undefined;
                        targetVendedorId = vendedorId || entry.vendedorId || undefined;
                    }
                    
                    // Buscar el statement del día anterior
                    const previousStatement = await prisma.accountStatement.findFirst({
                        where: {
                            date: previousDayDate,
                            bancaId: targetBancaId || null,
                            ventanaId: targetVentanaId || null,
                            vendedorId: targetVendedorId || null,
                        },
                        orderBy: {
                            createdAt: 'desc', // Obtener el más reciente si hay múltiples
                        },
                    });
                    
                    if (previousStatement && previousStatement.remainingBalance !== null) {
                        previousDayRemainingBalance = Number(previousStatement.remainingBalance);
                    }
                } catch (error) {
                    // Si falla, continuar con el fallback
                    logger.warn({
                        layer: "service",
                        action: "PREVIOUS_DAY_STATEMENT_FETCH_ERROR",
                        payload: {
                            date,
                            previousDateStr,
                            dimension,
                            error: (error as Error).message,
                        },
                    });
                }
                
                // ✅ CRÍTICO: Usar el remainingBalance guardado si está disponible, sino usar lastAccumulatedByEntity
                if (previousDayRemainingBalance !== null) {
                    initialAccumulated = previousDayRemainingBalance;
                } else {
                    // Fallback: usar lastAccumulatedByEntity (calculado durante el procesamiento)
                    const previousEntityKey = shouldGroupByDate
                        ? previousDateStr
                        : dimension === "banca" && !bancaId
                            ? previousDateStr
                            : dimension === "banca"
                                ? `${previousDateStr}_${bancaId || entry.bancaId || 'null'}`
                                : dimension === "ventana"
                                    ? `${previousDateStr}_${ventanaId || entry.ventanaId || 'null'}`
                                    : `${previousDateStr}_${vendedorId || entry.vendedorId || 'null'}`;
                    
                    initialAccumulated = lastAccumulatedByEntity.get(previousEntityKey) || 0;
                }
            }
            
            const sorteosAndMovements = intercalateSorteosAndMovements(bySorteo, movements, date, initialAccumulated);
            
            // ✅ CRÍTICO: Guardar el último accumulated de este día para el siguiente día
            // ✅ NOTA: Cuando shouldGroupByDate=true o dimension="banca" sin bancaId,
            // entityKey es solo la fecha, así que solo hay una entrada por día.
            // El lastAccumulated ya incluye el acumulado progresivo correcto desde initialAccumulated.
            // ✅ CORREGIDO: Cuando hay agrupación, solo actualizar lastAccumulatedByEntity una vez por día
            // (usar el máximo accumulated de todos los sorteos/movimientos del día)
            // ✅ CRÍTICO: Obtener el último accumulated de este día desde sorteosAndMovements
            // El accumulated ya se calculó progresivamente en intercalateSorteosAndMovements
            // usando initialAccumulated como punto de partida
            let statementRemainingBalance = initialAccumulated; // Default: usar acumulado del día anterior
            if (sorteosAndMovements.length > 0) {
                // Ordenar por scheduledAt ASC para obtener el último accumulated (más reciente)
                const sorted = [...sorteosAndMovements].sort((a, b) => {
                    const timeA = new Date(a.scheduledAt).getTime();
                    const timeB = new Date(b.scheduledAt).getTime();
                    return timeA - timeB; // ASC
                });
                const lastItem = sorted[sorted.length - 1];
                // ✅ CRÍTICO: Usar el accumulated del último item si existe y es válido
                if (lastItem && lastItem.accumulated !== undefined && lastItem.accumulated !== null && !isNaN(Number(lastItem.accumulated))) {
                    statementRemainingBalance = Number(lastItem.accumulated);
                }
                // Si no hay accumulated válido, statementRemainingBalance ya tiene initialAccumulated
            }
            // Si no hay sorteos/movimientos, statementRemainingBalance ya tiene initialAccumulated
            
            // ✅ CRÍTICO: Actualizar lastAccumulatedByEntity con el statementRemainingBalance correcto
            // Esto asegura que el siguiente día tenga el acumulado correcto
            if (shouldGroupByDate || (dimension === "banca" && !bancaId)) {
                const existingAccumulated = lastAccumulatedByEntity.get(entityKey);
                if (existingAccumulated === undefined || statementRemainingBalance > existingAccumulated) {
                    // Solo actualizar si no existe o si el nuevo es mayor (más reciente)
                    lastAccumulatedByEntity.set(entityKey, statementRemainingBalance);
                }
            } else {
                // Cuando no hay agrupación, actualizar directamente
                lastAccumulatedByEntity.set(entityKey, statementRemainingBalance);
            }
            
            const statement: any = {
                date,
                bancaId: entry.bancaId, // ✅ NUEVO: Solo si dimension='banca' o si hay filtro por banca
                bancaName: entry.bancaName, // ✅ NUEVO
                bancaCode: entry.bancaCode, // ✅ NUEVO
                ventanaId: entry.ventanaId,
                ventanaName: entry.ventanaName,
                ventanaCode: entry.ventanaCode, // ✅ NUEVO: Código de ventana
                vendedorId: entry.vendedorId,
                vendedorName: entry.vendedorName,
                vendedorCode: entry.vendedorCode, // ✅ NUEVO: Código de vendedor
                totalSales: parseFloat(entry.totalSales.toFixed(2)),
                totalPayouts: parseFloat(totalPayouts.toFixed(2)),
                listeroCommission: parseFloat(entry.commissionListero.toFixed(2)),
                vendedorCommission: parseFloat(entry.commissionVendedor.toFixed(2)),
                balance: parseFloat(balance.toFixed(2)),
                totalPaid: parseFloat(totalPaid.toFixed(2)),
                totalCollected: parseFloat(totalCollected.toFixed(2)),
                totalPaymentsCollections: parseFloat((totalPaid + totalCollected).toFixed(2)),
                remainingBalance: parseFloat(statementRemainingBalance.toFixed(2)), // ✅ CORREGIDO: Usar el acumulado progresivo correcto
                isSettled: calculateIsSettled(entry.totalTicketsCount, statementRemainingBalance, totalPaid, totalCollected),
                canEdit: !calculateIsSettled(entry.totalTicketsCount, statementRemainingBalance, totalPaid, totalCollected),
                ticketCount: entry.totalTicketsCount,
                bySorteo: sorteosAndMovements, // ✅ Sorteos + Movimientos intercalados (incluye accumulated)
                hasSorteos: sorteosAndMovements.length > 0, // ✅ NUEVO: Flag para lazy loading (FE puede usar para saber si hay sorteos)
            };

            // ✅ NUEVO: Agregar desglose por entidad cuando hay agrupación
            if (shouldGroupByDate) {
                if (dimension === "banca") {
                    // ✅ NUEVO: Construir byBanca desde breakdownByEntity
                    const bancaBreakdown: any[] = [];
                    // Agrupar breakdowns por banca
                    const bancaMap = new Map<string, {
                        bancaId: string;
                        bancaName: string;
                        bancaCode: string | null;
                        ventanas: Map<string, any>;
                        vendedores: Map<string, any>;
                        totalSales: number;
                        totalPayouts: number;
                        commissionListero: number;
                        commissionVendedor: number;
                        totalTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                    }>();

                    for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                        const breakdownDate = breakdownKey.split("_")[0];
                        if (breakdownDate === date && breakdownEntry.bancaId) {
                            // ✅ CRÍTICO: Calcular totalPayouts desde sorteos agrupados por banca
                            // Cuando dimension=banca sin bancaId, sorteoBreakdownBatch tiene claves por banca
                            // Como los sorteos están agrupados por banca, no podemos obtener payouts específicos por ventana/vendedor
                            // Usaremos 0 aquí y se calculará correctamente desde los sorteos de la banca al construir el breakdown
                            const breakdownTotalPayouts = 0; // Se calculará después desde sorteoBreakdownBatch al construir byVentana/byVendedor

                            let bancaGroup = bancaMap.get(breakdownEntry.bancaId);
                            if (!bancaGroup) {
                                bancaGroup = {
                                    bancaId: breakdownEntry.bancaId,
                                    bancaName: breakdownEntry.bancaName || "Desconocido",
                                    bancaCode: breakdownEntry.bancaCode,
                                    ventanas: new Map(),
                                    vendedores: new Map(),
                                    totalSales: 0,
                                    totalPayouts: 0,
                                    commissionListero: 0,
                                    commissionVendedor: 0,
                                    totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                                };
                                bancaMap.set(breakdownEntry.bancaId, bancaGroup);
                            }

                            // Agregar a totales de banca (bancaGroup está garantizado que no es undefined aquí)
                            const group = bancaGroup;
                            group.totalSales += breakdownEntry.totalSales;
                            // ✅ NOTA: totalPayouts se calculará después desde sorteoBreakdownBatch al construir byVentana/byVendedor
                            // No acumular aquí porque breakdownEntry no tiene totalPayouts (se calcula desde sorteos)
                            group.commissionListero += breakdownEntry.commissionListero;
                            group.commissionVendedor += breakdownEntry.commissionVendedor;
                            group.totalTicketsCount += breakdownEntry.totalTicketsCount;

                            // Agrupar por ventana dentro de esta banca
                            if (breakdownEntry.ventanaId) {
                                const ventanaKey = breakdownEntry.ventanaId;
                                let ventanaGroup = group.ventanas.get(ventanaKey);
                                if (!ventanaGroup) {
                                    ventanaGroup = {
                                        ventanaId: breakdownEntry.ventanaId,
                                        ventanaName: breakdownEntry.ventanaName || "Desconocido",
                                        ventanaCode: breakdownEntry.ventanaCode,
                                        totalSales: 0,
                                        totalPayouts: 0,
                                        commissionListero: 0,
                                        commissionVendedor: 0,
                                        totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                                    };
                                    group.ventanas.set(ventanaKey, ventanaGroup);
                                }
                                ventanaGroup.totalSales += breakdownEntry.totalSales;
                                // ✅ NOTA: totalPayouts no se puede calcular aquí porque los sorteos están agrupados por banca
                                // Se usará el totalPayouts de la banca distribuido proporcionalmente, o se calculará desde sorteos de la banca
                                ventanaGroup.commissionListero += breakdownEntry.commissionListero;
                                ventanaGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                                ventanaGroup.totalTicketsCount += breakdownEntry.totalTicketsCount;
                            }

                            // Agrupar por vendedor dentro de esta banca
                            if (breakdownEntry.vendedorId) {
                                const vendedorKey = breakdownEntry.vendedorId;
                                let vendedorGroup = group.vendedores.get(vendedorKey);
                                if (!vendedorGroup) {
                                    vendedorGroup = {
                                        vendedorId: breakdownEntry.vendedorId,
                                        vendedorName: breakdownEntry.vendedorName || "Desconocido",
                                        vendedorCode: breakdownEntry.vendedorCode,
                                        ventanaId: breakdownEntry.ventanaId,
                                        ventanaName: breakdownEntry.ventanaName || "Desconocido",
                                        ventanaCode: breakdownEntry.ventanaCode,
                                        totalSales: 0,
                                        totalPayouts: 0,
                                        commissionListero: 0,
                                        commissionVendedor: 0,
                                        totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                                    };
                                    group.vendedores.set(vendedorKey, vendedorGroup);
                                }
                                vendedorGroup.totalSales += breakdownEntry.totalSales;
                                // ✅ NOTA: totalPayouts no se puede calcular aquí porque los sorteos están agrupados por banca
                                // Se usará el totalPayouts de la banca distribuido proporcionalmente
                                vendedorGroup.commissionListero += breakdownEntry.commissionListero;
                                vendedorGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                                vendedorGroup.totalTicketsCount += breakdownEntry.totalTicketsCount;
                            }
                        }
                    }

                    // Construir byBanca con byVentana y byVendedor
                    for (const [bancaId, bancaGroup] of bancaMap.entries()) {
                        // ✅ CORRECCIÓN: Calcular totalPayouts desde sorteoBreakdownBatch (agrupado por banca)
                        const bancaSorteoKey = `${date}_${bancaId}`;
                        const bancaSorteos = sorteoBreakdownBatch.get(bancaSorteoKey) || [];
                        const bancaTotalPayouts = bancaSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);
                        bancaGroup.totalPayouts = bancaTotalPayouts; // Actualizar totalPayouts desde sorteos
                        
                        const bancaBalance = bancaGroup.totalSales - bancaGroup.totalPayouts - bancaGroup.commissionListero;
                        const bancaMovements = allMovementsForDate.filter((m: any) => m.bancaId === bancaId);
                        const bancaTotalPaid = bancaMovements
                            .filter((m: any) => m.type === "payment" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const bancaTotalCollected = bancaMovements
                            .filter((m: any) => m.type === "collection" && !m.isReversed)
                            .reduce((sum: number, m: any) => sum + m.amount, 0);
                        const bancaRemainingBalance = bancaBalance - bancaTotalCollected + bancaTotalPaid;

                        // Construir byVentana para esta banca
                        const byVentana: any[] = [];
                        for (const [ventanaId, ventanaGroup] of bancaGroup.ventanas.entries()) {
                            // ✅ CORRECCIÓN: Calcular totalPayouts desde sorteos de la banca (proporcional a ventas de esta ventana)
                            // Como los sorteos están agrupados por banca, usamos el totalPayouts de la banca
                            // y lo distribuimos proporcionalmente según las ventas de esta ventana
                            const ventanaTotalPayouts = bancaGroup.totalSales > 0
                                ? (ventanaGroup.totalSales / bancaGroup.totalSales) * bancaGroup.totalPayouts
                                : 0;
                            ventanaGroup.totalPayouts = ventanaTotalPayouts; // Actualizar totalPayouts proporcional
                            
                            const ventanaBalance = ventanaGroup.totalSales - ventanaGroup.totalPayouts - ventanaGroup.commissionListero;
                            const ventanaMovements = allMovementsForDate.filter((m: any) => m.ventanaId === ventanaId);
                            const ventanaTotalPaid = ventanaMovements
                                .filter((m: any) => m.type === "payment" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const ventanaTotalCollected = ventanaMovements
                                .filter((m: any) => m.type === "collection" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const ventanaRemainingBalance = ventanaBalance - ventanaTotalCollected + ventanaTotalPaid;
                            // ✅ CORRECCIÓN: Cuando dimension=banca sin bancaId, NO mostrar sorteos individuales por ventana
                            // Los sorteos ya están agrupados por banca en el nivel principal (statement.bySorteo)
                            // El breakdown por entidad muestra solo totales, no sorteos individuales para evitar duplicados
                            const ventanaSorteos: any[] = []; // Vacío: sorteos ya mostrados en nivel principal

                            byVentana.push({
                                ventanaId: ventanaGroup.ventanaId,
                                ventanaName: ventanaGroup.ventanaName,
                                ventanaCode: ventanaGroup.ventanaCode,
                                bancaId: bancaGroup.bancaId, // ✅ NUEVO: ID de banca
                                bancaName: bancaGroup.bancaName, // ✅ NUEVO: Nombre de banca
                                totalSales: ventanaGroup.totalSales,
                                totalPayouts: ventanaGroup.totalPayouts,
                                listeroCommission: ventanaGroup.commissionListero,
                                vendedorCommission: ventanaGroup.commissionVendedor,
                                balance: ventanaBalance,
                                totalPaid: ventanaTotalPaid,
                                totalCollected: ventanaTotalCollected,
                                remainingBalance: ventanaRemainingBalance,
                                ticketCount: ventanaGroup.totalTicketsCount,
                                bySorteo: ventanaSorteos,
                                movements: ventanaMovements,
                            });
                        }

                        // Construir byVendedor para esta banca
                        const byVendedor: any[] = [];
                        for (const [vendedorId, vendedorGroup] of bancaGroup.vendedores.entries()) {
                            // ✅ CORRECCIÓN: Balance de vendedor usando vendedorCommission
                            // ✅ CORRECCIÓN: Calcular totalPayouts desde sorteos de la banca (proporcional a ventas de este vendedor)
                            // Como los sorteos están agrupados por banca, usamos el totalPayouts de la banca
                            // y lo distribuimos proporcionalmente según las ventas de este vendedor
                            const vendedorTotalPayouts = bancaGroup.totalSales > 0
                                ? (vendedorGroup.totalSales / bancaGroup.totalSales) * bancaGroup.totalPayouts
                                : 0;
                            vendedorGroup.totalPayouts = vendedorTotalPayouts; // Actualizar totalPayouts proporcional
                            
                            const vendedorBalance = vendedorGroup.totalSales - vendedorGroup.totalPayouts - vendedorGroup.commissionVendedor;
                            const vendedorMovements = allMovementsForDate.filter((m: any) => m.vendedorId === vendedorId);
                            const vendedorTotalPaid = vendedorMovements
                                .filter((m: any) => m.type === "payment" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const vendedorTotalCollected = vendedorMovements
                                .filter((m: any) => m.type === "collection" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const vendedorRemainingBalance = vendedorBalance - vendedorTotalCollected + vendedorTotalPaid;
                            // ✅ CORRECCIÓN: Cuando dimension=banca sin bancaId, NO mostrar sorteos individuales por vendedor
                            // Los sorteos ya están agrupados por banca en el nivel principal (statement.bySorteo)
                            // El breakdown por entidad muestra solo totales, no sorteos individuales para evitar duplicados
                            const vendedorSorteos: any[] = []; // Vacío: sorteos ya mostrados en nivel principal

                            byVendedor.push({
                                vendedorId: vendedorGroup.vendedorId,
                                vendedorName: vendedorGroup.vendedorName,
                                vendedorCode: vendedorGroup.vendedorCode,
                                ventanaId: vendedorGroup.ventanaId,
                                ventanaName: vendedorGroup.ventanaName,
                                ventanaCode: vendedorGroup.ventanaCode,
                                bancaId: bancaGroup.bancaId, // ✅ NUEVO: ID de banca
                                bancaName: bancaGroup.bancaName, // ✅ NUEVO: Nombre de banca
                                totalSales: vendedorGroup.totalSales,
                                totalPayouts: vendedorGroup.totalPayouts,
                                listeroCommission: vendedorGroup.commissionListero,
                                vendedorCommission: vendedorGroup.commissionVendedor,
                                balance: vendedorBalance,
                                totalPaid: vendedorTotalPaid,
                                totalCollected: vendedorTotalCollected,
                                remainingBalance: vendedorRemainingBalance,
                                ticketCount: vendedorGroup.totalTicketsCount,
                                bySorteo: vendedorSorteos,
                                movements: vendedorMovements,
                            });
                        }

                        bancaBreakdown.push({
                            bancaId: bancaGroup.bancaId,
                            bancaName: bancaGroup.bancaName,
                            bancaCode: bancaGroup.bancaCode,
                            totalSales: bancaGroup.totalSales,
                            totalPayouts: bancaGroup.totalPayouts,
                            listeroCommission: bancaGroup.commissionListero,
                            vendedorCommission: bancaGroup.commissionVendedor,
                            balance: bancaBalance,
                            totalPaid: bancaTotalPaid,
                            totalCollected: bancaTotalCollected,
                            remainingBalance: bancaRemainingBalance,
                            ticketCount: bancaGroup.totalTicketsCount,
                            byVentana: byVentana.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName)),
                            byVendedor: byVendedor.sort((a, b) => a.vendedorName.localeCompare(b.vendedorName)),
                            movements: bancaMovements,
                        });
                    }
                    statement.byBanca = bancaBreakdown.sort((a, b) => a.bancaName.localeCompare(b.bancaName));
                } else if (dimension === "ventana") {
                    // Construir byVentana desde breakdownByEntity
                    const ventanaBreakdown: any[] = [];
                    for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                        const breakdownDate = breakdownKey.split("_")[0];
                        if (breakdownDate === date) {
                            // ✅ CRÍTICO: Obtener sorteos específicos de esta ventana
                            const ventanaSorteoKey = `${date}_${breakdownEntry.ventanaId}`;
                            const ventanaSorteos = sorteoBreakdownBatch.get(ventanaSorteoKey) || [];

                            // ✅ CRÍTICO: Calcular totalPayouts sumando desde sorteos
                            const ventanaTotalPayouts = ventanaSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                            const breakdownBalance = breakdownEntry.totalSales - ventanaTotalPayouts - breakdownEntry.commissionListero;
                            // Calcular totalPaid y totalCollected para esta ventana en esta fecha
                            const ventanaMovements = allMovementsForDate.filter((m: any) => m.ventanaId === breakdownEntry.ventanaId);
                            const ventanaTotalPaid = ventanaMovements
                                .filter((m: any) => m.type === "payment" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const ventanaTotalCollected = ventanaMovements
                                .filter((m: any) => m.type === "collection" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const ventanaRemainingBalance = breakdownBalance - ventanaTotalCollected + ventanaTotalPaid;

                            // ✅ CRÍTICO: Obtener movimientos específicos de esta ventana
                            const ventanaMovementsFiltered = allMovementsForDate.filter((m: any) => m.ventanaId === breakdownEntry.ventanaId);

                            ventanaBreakdown.push({
                                ventanaId: breakdownEntry.ventanaId,
                                ventanaName: breakdownEntry.ventanaName,
                                ventanaCode: breakdownEntry.ventanaCode, // ✅ NUEVO: Código de ventana
                                bancaId: breakdownEntry.bancaId, // ✅ NUEVO: ID de banca (si está disponible)
                                bancaName: breakdownEntry.bancaName, // ✅ NUEVO: Nombre de banca (si está disponible)
                                totalSales: breakdownEntry.totalSales,
                                totalPayouts: ventanaTotalPayouts,
                                listeroCommission: breakdownEntry.commissionListero,
                                vendedorCommission: breakdownEntry.commissionVendedor,
                                balance: breakdownBalance,
                                totalPaid: ventanaTotalPaid,
                                totalCollected: ventanaTotalCollected,
                                remainingBalance: ventanaRemainingBalance,
                                ticketCount: breakdownEntry.totalTicketsCount,
                                // ✅ CRÍTICO: Sorteos específicos de esta ventana (NO agrupados con otras ventanas)
                                bySorteo: ventanaSorteos,
                                // ✅ CRÍTICO: Movimientos específicos de esta ventana (NO agrupados con otras ventanas)
                                movements: ventanaMovementsFiltered,
                            });
                        }
                    }
                    statement.byVentana = ventanaBreakdown.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName));
                } else {
                    // Construir byVendedor desde breakdownByEntity
                    const vendedorBreakdown: any[] = [];
                    for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                        const breakdownDate = breakdownKey.split("_")[0];
                        if (breakdownDate === date) {
                            // ✅ CRÍTICO: Obtener sorteos específicos de este vendedor
                            const vendedorSorteoKey = `${date}_${breakdownEntry.vendedorId || 'null'}`;
                            const vendedorSorteos = sorteoBreakdownBatch.get(vendedorSorteoKey) || [];

                            // ✅ CRÍTICO: Calcular totalPayouts sumando desde sorteos
                            const vendedorTotalPayouts = vendedorSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                            // ✅ CORRECCIÓN: Balance de vendedor usando vendedorCommission
                            const breakdownBalance = breakdownEntry.totalSales - vendedorTotalPayouts - breakdownEntry.commissionVendedor;
                            // Calcular totalPaid y totalCollected para este vendedor en esta fecha
                            const vendedorMovements = allMovementsForDate.filter((m: any) => m.vendedorId === breakdownEntry.vendedorId);
                            const vendedorTotalPaid = vendedorMovements
                                .filter((m: any) => m.type === "payment" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const vendedorTotalCollected = vendedorMovements
                                .filter((m: any) => m.type === "collection" && !m.isReversed)
                                .reduce((sum: number, m: any) => sum + m.amount, 0);
                            const vendedorRemainingBalance = breakdownBalance - vendedorTotalCollected + vendedorTotalPaid;

                            // ✅ CRÍTICO: Obtener movimientos específicos de este vendedor
                            const vendedorMovementsFiltered = allMovementsForDate.filter((m: any) => m.vendedorId === breakdownEntry.vendedorId);

                            vendedorBreakdown.push({
                                vendedorId: breakdownEntry.vendedorId,
                                vendedorName: breakdownEntry.vendedorName,
                                ventanaId: breakdownEntry.ventanaId,
                                ventanaName: breakdownEntry.ventanaName,
                                totalSales: breakdownEntry.totalSales,
                                totalPayouts: vendedorTotalPayouts,
                                listeroCommission: breakdownEntry.commissionListero,
                                vendedorCommission: breakdownEntry.commissionVendedor,
                                balance: breakdownBalance,
                                totalPaid: vendedorTotalPaid,
                                totalCollected: vendedorTotalCollected,
                                remainingBalance: vendedorRemainingBalance,
                                ticketCount: breakdownEntry.totalTicketsCount,
                                // ✅ CRÍTICO: Sorteos específicos de este vendedor (NO agrupados con otros vendedores)
                                bySorteo: vendedorSorteos,
                                // ✅ CRÍTICO: Movimientos específicos de este vendedor (NO agrupados con otros vendedores)
                                movements: vendedorMovementsFiltered,
                            });
                        }
                    }
                    statement.byVendedor = vendedorBreakdown.sort((a, b) => a.vendedorName.localeCompare(b.vendedorName));
                }
                // Cuando hay agrupación, bancaId/ventanaId/vendedorId son null según dimensión
                if (dimension === "banca") {
                    statement.bancaId = null;
                    statement.bancaName = null;
                    statement.bancaCode = null;
                }
                statement.ventanaId = null;
                statement.ventanaName = null;
                statement.ventanaCode = null;
                statement.vendedorId = null;
                statement.vendedorName = null;
                statement.vendedorCode = null;
            } else {
                // Sin agrupación: comportamiento original
                if (dimension === "banca") {
                    statement.bancaId = entry.bancaId;
                    statement.bancaName = entry.bancaName;
                    statement.bancaCode = entry.bancaCode;
                } else if (dimension === "ventana") {
                    statement.ventanaId = entry.ventanaId;
                    statement.ventanaName = entry.ventanaName;
                    statement.ventanaCode = entry.ventanaCode;
                } else {
                    statement.vendedorId = entry.vendedorId;
                    statement.vendedorName = entry.vendedorName;
                    statement.vendedorCode = entry.vendedorCode;
                }
            }

            return statement;
        })();
        
        allStatementsFromMonth.push(statement);
        
        // ✅ CRÍTICO: Guardar el statement INMEDIATAMENTE después de calcularlo
        // Esto asegura que cuando se procesa el día siguiente, el día actual ya está guardado
        try {
            const statementDate = new Date(statement.date + 'T00:00:00.000Z');
            const monthForStatement = `${statementDate.getUTCFullYear()}-${String(statementDate.getUTCMonth() + 1).padStart(2, '0')}`;
            
            // Determinar IDs según la dimensión
            let targetBancaId: string | undefined = undefined;
            let targetVentanaId: string | undefined = undefined;
            let targetVendedorId: string | undefined = undefined;
            
            if (shouldGroupByDate) {
                // Cuando hay agrupación, guardar statement consolidado
                if (dimension === "banca") {
                    if (bancaId) {
                        targetBancaId = bancaId;
                    }
                } else if (dimension === "ventana") {
                    if (ventanaId) {
                        targetBancaId = statement.bancaId || undefined;
                        targetVentanaId = ventanaId;
                    }
                }
            } else {
                // Cuando no hay agrupación, guardar statement individual
                targetBancaId = statement.bancaId || undefined;
                targetVentanaId = statement.ventanaId || undefined;
                targetVendedorId = statement.vendedorId || undefined;
                
                // Aplicar filtros si existen
                if (dimension === "banca" && bancaId) {
                    targetBancaId = bancaId;
                } else if (dimension === "ventana" && ventanaId) {
                    targetVentanaId = ventanaId;
                    targetVendedorId = undefined; // Statement consolidado de ventana
                } else if (dimension === "vendedor" && vendedorId) {
                    targetVendedorId = vendedorId;
                }
            }
            
            // Buscar o crear el statement en la BD
            const dbStatement = await AccountStatementRepository.findOrCreate({
                date: statementDate,
                month: monthForStatement,
                bancaId: targetBancaId,
                ventanaId: targetVentanaId,
                vendedorId: targetVendedorId,
            });
            
            // Actualizar con todos los valores calculados
            await AccountStatementRepository.update(dbStatement.id, {
                totalSales: statement.totalSales,
                totalPayouts: statement.totalPayouts,
                listeroCommission: statement.listeroCommission,
                vendedorCommission: statement.vendedorCommission,
                balance: statement.balance,
                totalPaid: statement.totalPaid,
                totalCollected: statement.totalCollected,
                remainingBalance: statement.remainingBalance, // ✅ CRÍTICO: Guardar el acumulado progresivo correcto
                isSettled: statement.isSettled,
                canEdit: statement.canEdit,
                ticketCount: statement.ticketCount,
            });
        } catch (error) {
            // Loggear error pero continuar con los demás días
            logger.error({
                layer: "service",
                action: "ACCOUNT_STATEMENT_IMMEDIATE_SAVE_ERROR",
                payload: {
                    date: statement.date,
                    dimension,
                    error: (error as Error).message,
                },
            });
        }
    }
    
    // Ordenar statements por fecha
    allStatementsFromMonth.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            return sort === "desc" ? dateB - dateA : dateA - dateB;
        });

    // ✅ NUEVO: Calcular monthlyAccumulated (Saldo a Hoy - acumulado desde inicio del mes hasta hoy)
    // Esto es INMUTABLE respecto al período filtrado (siempre desde el día 1 del mes ACTUAL hasta hoy)
    // ✅ CRÍTICO: monthlyAccumulated SIEMPRE debe calcularse para el mes ACTUAL, no para effectiveMonth
    // Esto es especialmente importante cuando se consulta por "week" que cruza meses
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentMonthStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
    
    // ✅ CRÍTICO: Usar el mes ACTUAL para monthlyAccumulated, no effectiveMonth
    const monthStartDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1)); // Primer día del mes actual
    const today = new Date(Date.UTC(currentYear, currentMonth - 1, now.getUTCDate(), 23, 59, 59, 999));
    const lastDayOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));
    const monthEndDate = today < monthStartDate ? monthStartDate : today;
    const monthStartDateCRStr = crDateService.dateUTCToCRString(monthStartDate);
    const monthEndDateCRStr = crDateService.dateUTCToCRString(monthEndDate);

    // Construir WHERE conditions para el mes completo
    const monthlyWhereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" != 'CANCELLED'`, // Mantener seguridad extra
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${monthStartDateCRStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${monthEndDateCRStr}::date`,
        // ✅ CRÍTICO: Usar EL MISMO filtro de sorteos que la query principal (SOLO EVALUATED)
        // Esto asegura que totals y monthlyAccumulated usen exactamente los mismos datos
        Prisma.sql`EXISTS (
            SELECT 1 FROM "Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'EVALUATED'
        )`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
        Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        )`,
    ];

    // Reutilizar filtros RBAC/banca
    if (bancaId) {
        monthlyWhereConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v
      WHERE v.id = t."ventanaId"
      AND v."bancaId" = ${bancaId}::uuid
    )`);
    }

    if (dimension === "vendedor") {
        if (vendedorId) {
            monthlyWhereConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
    }

    const monthlyWhereClause = Prisma.sql`WHERE ${Prisma.join(monthlyWhereConditions, " AND ")}`;

    // ✅ OPTIMIZACIÓN: Calcular límite dinámico para query mensual
    // Estimación: ~200 tickets/día × días en mes × 5 jugadas/ticket promedio × 2 (margen seguridad)
    // Mínimo 50000 para mantener compatibilidad
    const monthlyDynamicLimit = Math.max(50000, daysInMonth * 200 * 5 * 2);
    
    // ✅ OPTIMIZACIÓN: Log de rendimiento para consulta mensual
    const monthlyQueryStartTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_START",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            month: effectiveMonth,
            monthlyDynamicLimit,
        },
    });

    // Obtener jugadas del mes completo
    const monthlyJugadas = await prisma.$queryRaw<
        Array<{
            business_date: Date;
            ventana_id: string;
            ventana_name: string;
            vendedor_id: string | null;
            vendedor_name: string | null;
            ticket_id: string;
            amount: number;
            type: string;
            finalMultiplierX: number | null;
            loteriaId: string;
            ventana_policy: any;
            banca_policy: any;
            ticket_total_payout: number | null;
            commission_amount: number | null;
            listero_commission_amount: number | null;
            commission_origin: string;
        }>
    >`
    SELECT
      COALESCE(
        t."businessDate",
        DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
      ) as business_date,
      t."ventanaId" as ventana_id,
      v.name as ventana_name,
      t."vendedorId" as vendedor_id,
      u.name as vendedor_name,
      t.id as ticket_id,
      j.amount,
      j.type,
      j."finalMultiplierX",
      t."loteriaId",
      v."commissionPolicyJson" as ventana_policy,
      b."commissionPolicyJson" as banca_policy,
      t."totalPayout" as ticket_total_payout,
      j."commissionAmount" as commission_amount,
      j."listeroCommissionAmount" as listero_commission_amount,
      j."commissionOrigin" as commission_origin
    FROM "Ticket" t
    INNER JOIN "Jugada" j ON j."ticketId" = t.id
    INNER JOIN "Ventana" v ON v.id = t."ventanaId"
    INNER JOIN "Banca" b ON b.id = v."bancaId"
    LEFT JOIN "User" u ON u.id = t."vendedorId"
    ${monthlyWhereClause}
    AND j."deletedAt" IS NULL
    -- ✅ OPTIMIZACIÓN: Límite dinámico basado en días del mes (evita truncamiento)
    LIMIT ${monthlyDynamicLimit}
  `;

    const monthlyQueryEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            month: effectiveMonth,
            rowsReturned: monthlyJugadas.length,
            queryTimeMs: monthlyQueryEndTime - monthlyQueryStartTime,
        },
    });

    // Agrupar jugadas del mes por día y dimensión
    const monthlyByDateAndDimension = new Map<
        string,
        {
            ventanaId: string;
            ventanaName: string;
            vendedorId: string | null;
            vendedorName: string | null;
            totalSales: number;
            totalPayouts: number;
            totalTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set (reduce memoria 20-30%)
            commissionListero: number;
            commissionVendedor: number;
            payoutTicketsCount: number; // ✅ OPTIMIZACIÓN: Contador en lugar de Set
            processedPayoutTicketIds: Set<string>; // ✅ CRÍTICO: Set pequeño solo para evitar duplicados de payouts
        }
    >();

    // Procesar jugadas del mes (misma lógica que periodo filtrado)
    for (const jugada of monthlyJugadas) {
        // ✅ CORREGIDO: Usar listeroCommissionAmount directamente de Jugada (igual que dashboard)
        // Esto asegura consistencia entre ambos endpoints
        const commissionListeroFinal = Number(jugada.listero_commission_amount || 0);
        const dateKey = crDateService.postgresDateToCRString(jugada.business_date);
        const key = dimension === "banca"
            ? `${dateKey}_null` // Cuando dimension=banca sin bancaId, todos comparten bancaId=null
            : dimension === "ventana"
                ? `${dateKey}_${jugada.ventana_id}`
                : `${dateKey}_${jugada.vendedor_id || 'null'}`;

        let entry = monthlyByDateAndDimension.get(key);
        if (!entry) {
            entry = {
                ventanaId: jugada.ventana_id,
                ventanaName: jugada.ventana_name,
                vendedorId: jugada.vendedor_id,
                vendedorName: jugada.vendedor_name,
                totalSales: 0,
                totalPayouts: 0,
                totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                processedPayoutTicketIds: new Set<string>(), // ✅ CRÍTICO: Set pequeño solo para evitar duplicados de payouts
            };
            monthlyByDateAndDimension.set(key, entry);
        }

        entry.totalSales += jugada.amount;
        entry.totalTicketsCount += 1;
        entry.commissionListero += commissionListeroFinal;
        if (jugada.commission_origin === "USER") {
            entry.commissionVendedor += Number(jugada.commission_amount || 0);
        }
        // ✅ CRÍTICO: Evitar duplicados de payouts - un ticket puede tener múltiples jugadas
        // Solo sumar el payout una vez por ticket_id
        if (jugada.ticket_id && !entry.processedPayoutTicketIds.has(jugada.ticket_id)) {
            entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
            entry.payoutTicketsCount += 1;
            entry.processedPayoutTicketIds.add(jugada.ticket_id);
        }
    }

    // Calcular movimientos del mes completo
    const monthlyMovementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        monthStartDate,
        monthEndDate,
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );

    // ✅ NUEVO: Incorporar días que solo tienen movimientos al mapa mensual
    for (const [dateKey, movements] of monthlyMovementsByDate.entries()) {
        for (const movement of movements) {
            const targetId = dimension === "ventana" ? movement.ventanaId : movement.vendedorId;
            if (dimension === "ventana" && ventanaId && targetId !== ventanaId) continue;
            if (dimension === "vendedor" && vendedorId && targetId !== vendedorId) continue;

            const key = `${dateKey}_${targetId || 'null'}`;

            if (!monthlyByDateAndDimension.has(key)) {
                monthlyByDateAndDimension.set(key, {
                    ventanaId: movement.ventanaId,
                    ventanaName: movement.ventanaName || "Desconocido",
                    vendedorId: movement.vendedorId,
                    vendedorName: movement.vendedorName || "Desconocido",
                    totalSales: 0,
                    totalPayouts: 0,
                    totalTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0, // ✅ OPTIMIZACIÓN: Contador en lugar de Set
                    processedPayoutTicketIds: new Set<string>(), // ✅ CRÍTICO: Set pequeño solo para evitar duplicados de payouts
                });
            }
        }
    }

    // Calcular totales mensuales
    const monthlyTotalSales = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.totalSales,
        0
    );
    const monthlyTotalPayouts = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.totalPayouts,
        0
    );
    const monthlyTotalListeroCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.commissionListero,
        0
    );
    const monthlyTotalVendedorCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
        (sum, entry) => sum + entry.commissionVendedor,
        0
    );
    // ✅ CRÍTICO: Usar comisión correcta según dimension (no vendedorId)
    // - Si dimension='vendedor' → usar vendedorCommission
    // - Si dimension='banca' o 'ventana' → usar listeroCommission (siempre)
    const monthlyTotalCommissionToUse = dimension === "vendedor" ? monthlyTotalVendedorCommission : monthlyTotalListeroCommission;

    // Calcular totales de pagos/cobros del mes
    let monthlyTotalPaid = 0;
    let monthlyTotalCollected = 0;
    for (const movements of monthlyMovementsByDate.values()) {
        // ✅ CRÍTICO: Filtrar movimientos por bancaId cuando dimension=banca con bancaId
        let filteredMovements = movements;
        if (dimension === "banca" && bancaId) {
            filteredMovements = movements.filter((m: any) => m.bancaId === bancaId);
        }
        monthlyTotalPaid += filteredMovements
            .filter((m: any) => m.type === "payment" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
        monthlyTotalCollected += filteredMovements
            .filter((m: any) => m.type === "collection" && !m.isReversed)
            .reduce((sum: number, m: any) => sum + m.amount, 0);
    }

    // ✅ CRÍTICO: monthlyTotalBalance debe incluir movimientos (igual que balance en statements individuales)
    // balance = balanceBase + totalPaid - totalCollected, donde balanceBase = totalSales - totalPayouts - commission
    const monthlyTotalBalanceBase = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalCommissionToUse;
    const monthlyTotalBalance = monthlyTotalBalanceBase + monthlyTotalPaid - monthlyTotalCollected;

    // Contar días saldados en el mes
    const monthlySettledDays = Array.from(monthlyByDateAndDimension.entries())
        .filter(([key, entry]) => {
            const date = key.split("_")[0];
            // Obtener movimientos específicos para esta entrada (fecha + dimensión)
            const allMovements = monthlyMovementsByDate.get(date) || [];
            let movements = allMovements;
            // ✅ CRÍTICO: Filtrar movimientos según dimension y filtros
            if (dimension === "banca" && bancaId) {
                movements = allMovements.filter((m: any) => m.bancaId === bancaId);
            } else if (dimension === "ventana") {
                movements = allMovements.filter((m: any) => m.ventanaId === entry.ventanaId);
            } else {
                movements = allMovements.filter((m: any) => m.vendedorId === entry.vendedorId);
            }

            const totalPaid = movements
                .filter((m: any) => m.type === "payment" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);
            const totalCollected = movements
                .filter((m: any) => m.type === "collection" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);

            // ✅ CORRECCIÓN: Balance según dimensión
            const commission = dimension === "vendedor" ? entry.commissionVendedor : entry.commissionListero;
            const remainingBalance = entry.totalSales - entry.totalPayouts - commission - totalCollected + totalPaid;
            return calculateIsSettled(entry.totalTicketsCount, remainingBalance, totalPaid, totalCollected);
        }).length;
    const monthlyPendingDays = monthlyByDateAndDimension.size - monthlySettledDays;

    // ✅ CRÍTICO: monthlyRemainingBalance debe ser igual a monthlyTotalBalance (que ya incluye movimientos)
    // En statements individuales: remainingBalance = balance (que ya incluye movimientos)
    // ✅ NUEVO: Obtener saldo final del mes anterior y sumarlo al acumulado del mes actual
    // ✅ CRÍTICO: Usar currentMonthStr (mes actual) para obtener el saldo del mes anterior correcto
    // No usar effectiveMonth porque puede ser el mes del inicio del rango (ej: diciembre si la semana cruza meses)
    const previousMonthBalance = await getPreviousMonthFinalBalance(
        currentMonthStr, // ✅ CORREGIDO: Usar mes actual, no effectiveMonth
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );
    
    // Sumar saldo del mes anterior al acumulado del mes actual
    // ✅ CRÍTICO: Si no hay transacciones en el mes actual, monthlyTotalBalance será 0,
    // pero monthlyRemainingBalance debe ser igual al saldo del mes anterior
    // ✅ CRÍTICO: Asegurar que previousMonthBalance sea número (puede venir como Decimal de Prisma)
    const previousMonthBalanceNum = Number(previousMonthBalance);
    const monthlyRemainingBalance = previousMonthBalanceNum + monthlyTotalBalance;
    

    const monthlyAccumulated: StatementTotals = {
        totalSales: parseFloat(monthlyTotalSales.toFixed(2)),
        totalPayouts: parseFloat(monthlyTotalPayouts.toFixed(2)),
        totalBalance: parseFloat((previousMonthBalanceNum + monthlyTotalBalance).toFixed(2)),
        totalPaid: parseFloat(monthlyTotalPaid.toFixed(2)),
        totalCollected: parseFloat(monthlyTotalCollected.toFixed(2)),
        totalRemainingBalance: parseFloat(monthlyRemainingBalance.toFixed(2)),
        settledDays: monthlySettledDays,
        pendingDays: monthlyPendingDays,
    };

    // ✅ CRÍTICO: Paso 3 - Guardar statements calculados en la base de datos
    // Asegurar que todos los campos se guarden correctamente para todas las dimensiones
    // Esto garantiza que la información esté bien registrada y sea fidedigna
    
    // ✅ CRÍTICO: Cuando shouldGroupByDate=true, todos los statements del mismo día deben tener el mismo remainingBalance
    // El remainingBalance ya está correcto en cada statement, pero cuando hay agrupación,
    // debemos asegurar que todos los statements del mismo día tengan el mismo valor (el máximo)
    if (shouldGroupByDate) {
        // Agrupar statements por fecha
        const statementsByDate = new Map<string, typeof allStatementsFromMonth>();
        for (const statement of allStatementsFromMonth) {
            const dateKey = statement.date;
            if (!statementsByDate.has(dateKey)) {
                statementsByDate.set(dateKey, []);
            }
            statementsByDate.get(dateKey)!.push(statement);
        }
        
        // Procesar días en orden cronológico y asegurar que todos tengan el mismo remainingBalance
        const sortedDates = Array.from(statementsByDate.keys()).sort();
        for (const date of sortedDates) {
            const statementsForDate = statementsByDate.get(date)!;
            
            // ✅ CRÍTICO: Encontrar el máximo remainingBalance de todos los statements del día
            // Todos los statements del mismo día deben tener el mismo remainingBalance
            // Este es el acumulado del último sorteo del día, que ya se calculó correctamente durante la construcción
            let maxRemainingBalance = 0;
            for (const statement of statementsForDate) {
                if (statement.remainingBalance > maxRemainingBalance) {
                    maxRemainingBalance = statement.remainingBalance;
                }
            }
            
            // Asignar el mismo remainingBalance a todos los statements del día
            for (const statement of statementsForDate) {
                statement.remainingBalance = parseFloat(maxRemainingBalance.toFixed(2));
                
                // Recalcular isSettled y canEdit
                statement.isSettled = calculateIsSettled(
                    statement.ticketCount,
                    statement.remainingBalance,
                    statement.totalPaid,
                    statement.totalCollected
                );
                statement.canEdit = !statement.isSettled;
            }
        }
    }
    
    // ✅ CRÍTICO: Guardar todos los statements calculados en la base de datos
    // Esto asegura que la información esté bien registrada para futuras consultas
    // Asegurar que se guarden correctamente para todas las dimensiones y escenarios
    
    if (shouldGroupByDate) {
        // ✅ CRÍTICO: Cuando hay agrupación, guardar statement consolidado por día
        // Sumar todos los balances de las entidades del día y guardar un solo statement consolidado
        
        // Agrupar statements por fecha (ya está agrupado en statementsByDate)
        const statementsByDateForSave = new Map<string, typeof allStatementsFromMonth>();
        for (const statement of allStatementsFromMonth) {
            const dateKey = statement.date;
            if (!statementsByDateForSave.has(dateKey)) {
                statementsByDateForSave.set(dateKey, []);
            }
            statementsByDateForSave.get(dateKey)!.push(statement);
        }
        
        // Procesar días en orden cronológico y guardar statement consolidado
        const sortedDatesForSave = Array.from(statementsByDateForSave.keys()).sort();
        for (const date of sortedDatesForSave) {
            const statementsForDate = statementsByDateForSave.get(date)!;
            
            // ✅ CRÍTICO: Sumar todos los valores de las entidades del día
            const consolidatedTotalSales = statementsForDate.reduce((sum, s) => sum + s.totalSales, 0);
            const consolidatedTotalPayouts = statementsForDate.reduce((sum, s) => sum + s.totalPayouts, 0);
            const consolidatedListeroCommission = statementsForDate.reduce((sum, s) => sum + s.listeroCommission, 0);
            const consolidatedVendedorCommission = statementsForDate.reduce((sum, s) => sum + s.vendedorCommission, 0);
            const consolidatedTotalPaid = statementsForDate.reduce((sum, s) => sum + s.totalPaid, 0);
            const consolidatedTotalCollected = statementsForDate.reduce((sum, s) => sum + s.totalCollected, 0);
            const consolidatedBalance = statementsForDate.reduce((sum, s) => sum + s.balance, 0);
            const consolidatedRemainingBalance = statementsForDate[0]?.remainingBalance || 0; // Todos tienen el mismo remainingBalance
            const consolidatedTicketCount = statementsForDate.reduce((sum, s) => sum + s.ticketCount, 0);
            const consolidatedIsSettled = statementsForDate[0]?.isSettled || false;
            const consolidatedCanEdit = !consolidatedIsSettled;
            
            try {
                // Convertir date string a Date object
                const statementDate = new Date(date + 'T00:00:00.000Z');
                const monthForStatement = `${statementDate.getUTCFullYear()}-${String(statementDate.getUTCMonth() + 1).padStart(2, '0')}`;
                
                // ✅ CRÍTICO: Determinar IDs según la dimensión para statement consolidado
                let targetBancaId: string | undefined = undefined;
                let targetVentanaId: string | undefined = undefined;
                let targetVendedorId: string | undefined = undefined;
                
                if (dimension === "banca") {
                    if (bancaId) {
                        // Statement consolidado de banca específica
                        targetBancaId = bancaId;
                    } else {
                        // Statement consolidado de todas las bancas (raro, pero posible)
                        // No establecer bancaId, ventanaId, vendedorId (todos null)
                    }
                } else if (dimension === "ventana") {
                    if (ventanaId) {
                        // Statement consolidado de ventana específica
                        targetBancaId = statementsForDate[0]?.bancaId || undefined;
                        targetVentanaId = ventanaId;
                    } else {
                        // Statement consolidado de todas las ventanas (raro, pero posible)
                        // No establecer ventanaId, vendedorId (todos null)
                    }
                } else if (dimension === "vendedor") {
                    // Para vendedor sin filtros, guardar statement consolidado de todos los vendedores
                    // No establecer vendedorId (null)
                }
                
                // Buscar o crear el statement consolidado en la BD
                const dbStatement = await AccountStatementRepository.findOrCreate({
                    date: statementDate,
                    month: monthForStatement,
                    bancaId: targetBancaId,
                    ventanaId: targetVentanaId,
                    vendedorId: targetVendedorId,
                });
                
                // Actualizar con valores consolidados
                await AccountStatementRepository.update(dbStatement.id, {
                    totalSales: consolidatedTotalSales,
                    totalPayouts: consolidatedTotalPayouts,
                    listeroCommission: consolidatedListeroCommission,
                    vendedorCommission: consolidatedVendedorCommission,
                    balance: consolidatedBalance,
                    totalPaid: consolidatedTotalPaid,
                    totalCollected: consolidatedTotalCollected,
                    remainingBalance: consolidatedRemainingBalance,
                    isSettled: consolidatedIsSettled,
                    canEdit: consolidatedCanEdit,
                    ticketCount: consolidatedTicketCount,
                });
            } catch (error) {
                logger.error({
                    layer: "service",
                    action: "ACCOUNT_STATEMENT_CONSOLIDATED_SAVE_ERROR",
                    payload: {
                        date,
                        dimension,
                        bancaId,
                        ventanaId,
                        vendedorId,
                        error: (error as Error).message,
                    },
                });
            }
        }
    } else {
        // ✅ CRÍTICO: Cuando no hay agrupación, guardar statements individuales por entidad
        // Procesar en lotes para evitar sobrecargar la BD
        const BATCH_SIZE = 50;
        for (let i = 0; i < allStatementsFromMonth.length; i += BATCH_SIZE) {
            const batch = allStatementsFromMonth.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (statement) => {
                try {
                    // Convertir date string a Date object
                    const statementDate = new Date(statement.date + 'T00:00:00.000Z');
                    
                    // ✅ CRÍTICO: Determinar bancaId, ventanaId, vendedorId según la dimensión
                    let targetBancaId: string | undefined = statement.bancaId || undefined;
                    let targetVentanaId: string | undefined = statement.ventanaId || undefined;
                    let targetVendedorId: string | undefined = statement.vendedorId || undefined;
                    
                    // Aplicar filtros si existen
                    if (dimension === "banca" && bancaId) {
                        targetBancaId = bancaId;
                    } else if (dimension === "ventana" && ventanaId) {
                        targetVentanaId = ventanaId;
                        targetVendedorId = undefined; // Statement consolidado de ventana
                    } else if (dimension === "vendedor" && vendedorId) {
                        targetVendedorId = vendedorId;
                    }
                    
                    // Calcular month desde la fecha
                    const monthForStatement = `${statementDate.getUTCFullYear()}-${String(statementDate.getUTCMonth() + 1).padStart(2, '0')}`;
                    
                    // Buscar o crear el statement en la BD
                    const dbStatement = await AccountStatementRepository.findOrCreate({
                        date: statementDate,
                        month: monthForStatement,
                        bancaId: targetBancaId,
                        ventanaId: targetVentanaId,
                        vendedorId: targetVendedorId,
                    });
                    
                    // Actualizar con todos los valores calculados
                    await AccountStatementRepository.update(dbStatement.id, {
                        totalSales: statement.totalSales,
                        totalPayouts: statement.totalPayouts,
                        listeroCommission: statement.listeroCommission,
                        vendedorCommission: statement.vendedorCommission,
                        balance: statement.balance,
                        totalPaid: statement.totalPaid,
                        totalCollected: statement.totalCollected,
                        remainingBalance: statement.remainingBalance, // ✅ CRÍTICO: Guardar el acumulado progresivo correcto
                        isSettled: statement.isSettled,
                        canEdit: statement.canEdit,
                        ticketCount: statement.ticketCount,
                    });
                } catch (error) {
                    // Loggear error pero continuar con los demás statements
                    logger.error({
                        layer: "service",
                        action: "ACCOUNT_STATEMENT_SAVE_ERROR",
                        payload: {
                            date: statement.date,
                            dimension,
                            bancaId: statement.bancaId,
                            ventanaId: statement.ventanaId,
                            vendedorId: statement.vendedorId,
                            error: (error as Error).message,
                        },
                    });
                }
            }));
        }
    }

    // ✅ ELIMINADO: Paso 3.5 ya no es necesario porque el Paso 3 ahora usa directamente bySorteo
    // El remainingBalance ya está correcto después del Paso 3

    // ✅ CRÍTICO: Paso 4 - Filtrar para retornar solo los días dentro del período solicitado
    // La acumulación ya se calculó correctamente para todos los días del mes
    // Ahora solo devolvemos los días que el usuario pidió ver
    // ✅ CORREGIDO: statement.date ya es un string YYYY-MM-DD, no necesita conversión
    const statements = allStatementsFromMonth.filter(statement => {
        const statementDateStr = statement.date; // Ya es YYYY-MM-DD
        return statementDateStr >= startDateCRStr && statementDateStr <= endDateCRStr;
    });

    // ✅ CRÍTICO: Paso 5 - Calcular totales SOLO para los días filtrados
    const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
    const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
    const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
    const totalVendedorCommission = statements.reduce((sum, s) => sum + s.vendedorCommission, 0);
    const totalCommissionToUse = vendedorId ? totalVendedorCommission : totalListeroCommission;
    const totalBalanceBase = totalSales - totalPayouts - totalCommissionToUse;
    const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
    const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
    
    // ✅ NUEVO: Obtener saldo del mes anterior para incluir en totals.totalBalance y totals.totalRemainingBalance
    // El saldo del mes anterior es un movimiento más (como un pago) que debe incluirse en el balance del período
    // Solo si el período incluye el día 1 del mes
    let periodPreviousMonthBalance = 0;
    const startDateCRStrForPeriod = crDateService.dateUTCToCRString(startDate);
    const periodIncludesFirstDay = startDateCRStrForPeriod === firstDayOfMonthStr;
    
    if (periodIncludesFirstDay) {
        // Obtener el saldo del mes anterior usando la función existente
        if (dimension === "banca") {
            periodPreviousMonthBalance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "banca",
                undefined,
                undefined,
                bancaId || null
            );
        } else if (dimension === "ventana") {
            periodPreviousMonthBalance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "ventana",
                ventanaId || null,
                undefined,
                bancaId
            );
        } else {
            periodPreviousMonthBalance = await getPreviousMonthFinalBalance(
                effectiveMonth,
                "vendedor",
                undefined,
                vendedorId || null,
                bancaId
            );
        }
    }
    
    // ✅ CRÍTICO: totalRemainingBalance debe incluir el saldo del mes anterior si el período incluye el día 1
    // Según el requerimiento: totals.totalRemainingBalance = saldoFinalMesAnterior + SUM(statements[].remainingBalance)
    // El remainingBalance de cada statement se calcula acumulativamente, pero el del día 1 ya incluye el saldo del mes anterior
    // ✅ CRÍTICO: totalRemainingBalance debe incluir el saldo del mes anterior si el período incluye el día 1
    // Según el requerimiento: totals.totalRemainingBalance = saldoFinalMesAnterior + totalBalance del período
    // El remainingBalance de cada statement ya incluye el saldo del mes anterior (para mostrar el balance acumulado correcto)
    // Pero el totalRemainingBalance debe ser simplemente: saldo del mes anterior + totalBalance del período
    // Esto evita duplicar el saldo del mes anterior cuando sumamos los remainingBalance de múltiples días
    // ✅ CRÍTICO: Asegurar que periodPreviousMonthBalance sea un número
    // getPreviousMonthFinalBalance puede devolver un Decimal de Prisma, string, o number
    let periodPreviousMonthBalanceNum = 0;
    if (typeof periodPreviousMonthBalance === 'string') {
        periodPreviousMonthBalanceNum = parseFloat(periodPreviousMonthBalance);
    } else if (typeof periodPreviousMonthBalance === 'object' && periodPreviousMonthBalance !== null && 'toNumber' in periodPreviousMonthBalance) {
        periodPreviousMonthBalanceNum = (periodPreviousMonthBalance as any).toNumber();
    } else if (periodPreviousMonthBalance !== null && periodPreviousMonthBalance !== undefined) {
        periodPreviousMonthBalanceNum = Number(periodPreviousMonthBalance) || 0;
    } else {
        periodPreviousMonthBalanceNum = 0;
    }
    
    // ✅ CRÍTICO: totalBalance debe incluir el saldo del mes anterior si el período incluye el día 1
    // Cuando se consulta el mes completo, totalBalance debe ser: saldo del mes anterior + totalBalanceBase
    const totalBalance = periodIncludesFirstDay 
        ? Number(periodPreviousMonthBalanceNum) + Number(totalBalanceBase)
        : Number(totalBalanceBase);
    
    // ✅ CRÍTICO: totalRemainingBalance debe incluir pagos y cobros del período
    // totalRemainingBalance = totalBalance + totalPaid - totalCollected
    const totalRemainingBalance = Number(totalBalance) + Number(totalPaid) - Number(totalCollected);

    const functionEndTime = Date.now();
    logger.info({
        layer: "service",
        action: "GET_STATEMENT_DIRECT_END",
        payload: {
            dimension,
            bancaId,
            ventanaId,
            vendedorId,
            statementsCount: statements.length,
            totalTimeMs: functionEndTime - functionStartTime,
        },
    });

    return {
        statements,
        totals: {
            totalSales: parseFloat(totalSales.toFixed(2)),
            totalPayouts: parseFloat(totalPayouts.toFixed(2)),
            totalListeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
            totalVendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
            totalBalance: parseFloat(totalBalance.toFixed(2)),
            totalPaid: parseFloat(totalPaid.toFixed(2)),
            totalCollected: parseFloat(totalCollected.toFixed(2)),
            totalRemainingBalance: parseFloat(totalRemainingBalance.toFixed(2)),
            settledDays: statements.filter(s => s.isSettled).length,
            pendingDays: statements.filter(s => !s.isSettled).length,
        },
        monthlyAccumulated,  // ✅ NUEVO: Saldo a Hoy (acumulado del mes)
        meta: {
            month: effectiveMonth,
            startDate: startDateCRStr,
            endDate: endDateCRStr,
            dimension,
            totalDays: daysInMonth,
            monthStartDate: crDateService.dateUTCToCRString(monthStartDate),
            monthEndDate: crDateService.dateUTCToCRString(monthEndDate),
        },
    };
}

/**
 * Helper para obtener IDs de tickets excluidos en una fecha específica
 * Basado en la tabla sorteo_lista_exclusion
 */
async function getExcludedTicketIdsForDate(date: Date): Promise<string[]> {
    // Convertir fecha a string YYYY-MM-DD para comparación SQL
    // Nota: date viene como objeto Date UTC (00:00:00Z) que representa el día
    const dateStr = crDateService.dateUTCToCRString(date);

    const excludedIds = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id
      FROM "Ticket" t
      JOIN "sorteo_lista_exclusion" sle ON sle.sorteo_id = t."sorteoId"
      WHERE
        (
          t."businessDate" = ${date}::date
          OR (
            t."businessDate" IS NULL
            AND DATE(t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica') = ${date}::date
          )
        )
        AND sle.ventana_id = t."ventanaId"
        AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
    `;

    return excludedIds.map(r => r.id);
}

/**
 * Calcula el saldo del mes anterior desde la fuente de verdad (tickets + pagos)
 * ✅ CONTABLEMENTE ROBUSTO: Siempre correcto porque calcula desde datos fuente
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'banca' | 'ventana' | 'vendedor'
 * @param filters - Filtros de dimensión
 * @returns Saldo final del mes anterior calculado desde fuente
 */
async function calculatePreviousMonthBalanceFromSource(
    effectiveMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    filters: {
        ventanaId?: string | null;
        vendedorId?: string | null;
        bancaId?: string | null;
    }
): Promise<number> {
    try {
        const [year, month] = effectiveMonth.split("-").map(Number);
        // Calcular primer y último día del mes anterior en CR
        // Mes anterior: month - 1 (si month = 1, mes anterior = 12 del año anterior)
        const previousYear = month === 1 ? year - 1 : year;
        const previousMonth = month === 1 ? 12 : month - 1;
        const lastDayOfPreviousMonth = new Date(previousYear, previousMonth, 0).getDate(); // Día 0 = último día del mes anterior
        
        const firstDay = new Date(Date.UTC(previousYear, previousMonth - 1, 1, 6, 0, 0, 0)); // 00:00 CR = 06:00 UTC
        // Último día: 23:59:59.999 CR = 05:59:59.999 UTC del día siguiente
        const lastDay = new Date(Date.UTC(previousYear, previousMonth - 1, lastDayOfPreviousMonth + 1, 5, 59, 59, 999));
        
        // Para las queries SQL, usar fechas CR directamente (YYYY-MM-DD)
        const firstDayCRStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`;
        const lastDayCRStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}-${String(lastDayOfPreviousMonth).padStart(2, '0')}`;

        // Construir condiciones WHERE para tickets
        // ✅ CRÍTICO: Incluir AMBOS límites (inicio y fin del mes anterior)
        const ticketConditions: Prisma.Sql[] = [
            Prisma.sql`t."deletedAt" IS NULL`,
            Prisma.sql`t."isActive" = true`,
            Prisma.sql`t."status" != 'CANCELLED'`,
            Prisma.sql`EXISTS (SELECT 1 FROM "Sorteo" s WHERE s.id = t."sorteoId" AND s.status = 'EVALUATED')`,
            Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${firstDayCRStr}::date`,
            Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${lastDayCRStr}::date`,
            Prisma.sql`NOT EXISTS (
                SELECT 1 FROM "sorteo_lista_exclusion" sle
                WHERE sle.sorteo_id = t."sorteoId"
                AND sle.ventana_id = t."ventanaId"
                AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            )`,
        ];

        // Aplicar filtros según dimensión
        if (filters.bancaId) {
            ticketConditions.push(Prisma.sql`EXISTS (
                SELECT 1 FROM "Ventana" v
                WHERE v.id = t."ventanaId"
                AND v."bancaId" = ${filters.bancaId}::uuid
            )`);
        }
        if (filters.ventanaId) {
            ticketConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
        if (filters.vendedorId) {
            ticketConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
        }

        const ticketWhereClause = Prisma.sql`WHERE ${Prisma.join(ticketConditions, " AND ")}`;

        // 1. Calcular ventas desde jugadas
        // ✅ CRÍTICO: Excluir jugadas excluidas (isExcluded = true)
        const salesResult = await prisma.$queryRaw<Array<{ total_sales: number }>>`
            SELECT COALESCE(SUM(j.amount), 0) as total_sales
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            ${ticketWhereClause}
            AND j."deletedAt" IS NULL
            AND j."isExcluded" = false
        `;

        // 2. Calcular premios desde tickets (no desde jugadas para evitar duplicar)
        const payoutsResult = await prisma.$queryRaw<Array<{ total_payouts: number }>>`
            SELECT COALESCE(SUM(t."totalPayout"), 0) as total_payouts
            FROM "Ticket" t
            ${ticketWhereClause}
        `;

        // 3. Calcular comisiones según dimensión
        // ✅ CRÍTICO: Excluir jugadas excluidas (isExcluded = true)
        const commissionField = dimension === "vendedor" 
            ? Prisma.sql`CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END`
            : Prisma.sql`j."listeroCommissionAmount"`;

        const commissionResult = await prisma.$queryRaw<Array<{ total_commission: number }>>`
            SELECT COALESCE(SUM(${commissionField}), 0) as total_commission
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            ${ticketWhereClause}
            AND j."deletedAt" IS NULL
            AND j."isExcluded" = false
        `;

        // 4. Obtener pagos y cobros del mes anterior
        // ✅ CRÍTICO: Incluir AMBOS límites (inicio y fin del mes anterior)
        // ✅ CRÍTICO: AccountPayment.date es @db.Date (solo fecha, sin hora)
        // Para @db.Date, Prisma espera Date objects, pero debemos usar solo la parte de fecha
        // Usar firstDayCRStr y lastDayCRStr para comparación directa de fechas
        const paymentsWhere: Prisma.AccountPaymentWhereInput = {
            date: { 
                gte: new Date(firstDayCRStr + "T00:00:00.000Z"),
                lte: new Date(lastDayCRStr + "T23:59:59.999Z"),
            },
            isReversed: false,
        };

        // ✅ CRÍTICO: Aplicar filtros según dimensión
        if (dimension === "vendedor" && filters.vendedorId) {
            paymentsWhere.vendedorId = filters.vendedorId;
        } else if (dimension === "ventana" && filters.ventanaId) {
            paymentsWhere.ventanaId = filters.ventanaId;
            // ✅ CRÍTICO: NO forzar vendedorId a null porque algunos payments de ventana pueden tener vendedorId
            // Los payments pueden tener vendedorId incluso cuando pertenecen a una ventana específica
        } else if (dimension === "banca") {
            // ✅ CRÍTICO: AccountPayment tiene bancaId directamente, no usar relación ventana
            if (filters.bancaId) {
                paymentsWhere.bancaId = filters.bancaId;
            }
            // ✅ CRÍTICO: NO forzar vendedorId/ventanaId a null porque algunos payments pueden tenerlos
            // Los payments pueden tener vendedorId o ventanaId incluso cuando pertenecen a una banca específica
        }

        const payments = await prisma.accountPayment.findMany({
            where: paymentsWhere,
            select: { type: true, amount: true },
        });

        const totalPaid = payments
            .filter(p => p.type === "payment")
            .reduce((sum, p) => sum + p.amount, 0);
        const totalCollected = payments
            .filter(p => p.type === "collection")
            .reduce((sum, p) => sum + p.amount, 0);

        // 5. Calcular saldo final
        const totalSales = Number(salesResult[0]?.total_sales || 0);
        const totalPayouts = Number(payoutsResult[0]?.total_payouts || 0);
        const totalCommission = Number(commissionResult[0]?.total_commission || 0);

        const balance = totalSales - totalPayouts - totalCommission;
        const remainingBalance = balance - totalCollected + totalPaid;

        // ✅ VALIDACIÓN: Contar tickets para debugging
        const ticketsCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint as count
            FROM "Ticket" t
            ${ticketWhereClause}
        `;
        const ticketsCountNum = Number(ticketsCount[0]?.count || 0);

        // ✅ VALIDACIÓN: Si no hay tickets ni pagos, el saldo debe ser 0
        if (ticketsCountNum === 0 && payments.length === 0 && remainingBalance !== 0) {
            logger.warn({
                layer: "service",
                action: "PREVIOUS_MONTH_BALANCE_INVALID",
                payload: {
                    effectiveMonth,
                    dimension,
                    filters: {
                        ventanaId: filters.ventanaId || null,
                        vendedorId: filters.vendedorId || null,
                        bancaId: filters.bancaId || null,
                    },
                    issue: "No hay tickets ni pagos pero saldo no es 0",
                    calculatedBalance: remainingBalance,
                },
            });
            return 0; // ✅ CORRECCIÓN: Si no hay datos, retornar 0
        }

        logger.info({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_CALCULATED_FROM_SOURCE",
            payload: {
                effectiveMonth,
                dimension,
                filters: {
                    ventanaId: filters.ventanaId || null,
                    vendedorId: filters.vendedorId || null,
                    bancaId: filters.bancaId || null,
                },
                dateRange: {
                    firstDay: firstDayCRStr,
                    lastDay: lastDayCRStr,
                },
                counts: {
                    tickets: ticketsCountNum,
                    payments: payments.length,
                },
                totals: {
                    totalSales,
                    totalPayouts,
                    totalCommission,
                    totalPaid,
                    totalCollected,
                    remainingBalance,
                },
            },
        });

        return remainingBalance;
    } catch (error) {
        logger.error({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_FROM_SOURCE_ERROR",
            payload: {
                effectiveMonth,
                dimension,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        return 0;
    }
}

/**
 * Obtiene los saldos finales del mes anterior para múltiples entidades en batch
 * ✅ ESTRATEGIA HÍBRIDA: Intenta usar statements asentados, si no calcula desde fuente
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'ventana' | 'vendedor'
 * @param entityIds - Array de IDs de entidades (ventanaId o vendedorId)
 * @returns Map<entityId, saldoFinal>
 */
export async function getPreviousMonthFinalBalancesBatch(
    effectiveMonth: string,
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string | null
): Promise<Map<string, number>> {
    if (entityIds.length === 0) {
        return new Map();
    }

    try {
        // Calcular mes anterior
        const [year, month] = effectiveMonth.split("-").map(Number);
        const previousYear = month === 1 ? year - 1 : year;
        const previousMonth = month === 1 ? 12 : month - 1;
        const previousMonthStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;
        const lastDayNum = new Date(previousYear, previousMonth, 0).getDate();
        
        const firstDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, 1, 6, 0, 0, 0)); // 00:00 CR
        // Último día: 23:59:59.999 CR = 05:59:59.999 UTC del día siguiente
        const lastDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, lastDayNum + 1, 5, 59, 59, 999));

        const balancesMap = new Map<string, number>();

        // ✅ PASO 1: Buscar en tabla de cierre mensual (FUENTE DE VERDAD)
        const closingWhere: any = {
            closingMonth: previousMonthStr,
            dimension,
        };

        if (dimension === "ventana") {
            closingWhere.ventanaId = { in: entityIds };
            closingWhere.vendedorId = null;
            // ✅ CRÍTICO: Si hay bancaId, filtrar también por banca
            if (bancaId) {
                closingWhere.bancaId = bancaId;
            }
        } else {
            closingWhere.vendedorId = { in: entityIds };
            // ✅ CRÍTICO: Si hay bancaId, filtrar también por banca (a través de ventana)
            if (bancaId) {
                closingWhere.bancaId = bancaId;
            }
        }

        const closingBalances = await prisma.monthlyClosingBalance.findMany({
            where: closingWhere,
            select: {
                vendedorId: true,
                ventanaId: true,
                closingBalance: true,
            },
        });

        // Mapear saldos desde cierre mensual
        for (const closing of closingBalances) {
            const entityId = dimension === "ventana" ? closing.ventanaId : closing.vendedorId;
            if (entityId) {
                balancesMap.set(entityId, Number(closing.closingBalance));
            }
        }

        // Si todos los entities tienen cierre, retornar
        const missingEntities = entityIds.filter(id => !balancesMap.has(id));
        if (missingEntities.length === 0) {
            logger.info({
                layer: "service",
                action: "PREVIOUS_MONTH_BALANCES_BATCH_FROM_CLOSING",
                payload: {
                    effectiveMonth,
                    dimension,
                    count: balancesMap.size,
                    source: "monthly_closing_balance",
                },
            });
            return balancesMap;
        }

        // ✅ PASO 2: Para entities sin cierre, calcular desde fuente (fallback)
        logger.info({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCES_BATCH_CALCULATING_FROM_SOURCE",
            payload: {
                effectiveMonth,
                dimension,
                missingCount: missingEntities.length,
                reason: "no_closing_balance_found",
            },
        });

        // Intentar obtener desde statements ASENTADOS del mes anterior (fallback)
        const where: Prisma.AccountStatementWhereInput = {
            date: {
                gte: firstDayOfPreviousMonth,
                lte: lastDayOfPreviousMonth,
            },
            isSettled: true, // ✅ SOLO statements asentados
        };

        if (dimension === "ventana") {
            where.ventanaId = { in: missingEntities };
            where.vendedorId = null;
            // ✅ CRÍTICO: Si hay bancaId, filtrar también por banca
            if (bancaId) {
                where.bancaId = bancaId;
            }
        } else {
            where.vendedorId = { in: missingEntities };
            // ✅ CRÍTICO: Si hay bancaId, filtrar también por banca (a través de ventana)
            if (bancaId) {
                where.bancaId = bancaId;
            }
        }

        const settledStatements = await prisma.accountStatement.findMany({
            where,
            select: {
                ventanaId: true,
                vendedorId: true,
                remainingBalance: true,
                date: true,
                ticketCount: true,
            },
            orderBy: { date: "desc" },
        });

        // Agrupar por entidad y tomar el más reciente (último statement asentado)
        // ✅ VALIDACIÓN CRÍTICA: Verificar que cada statement tenga tickets válidos
        const entityToStatement = new Map<string, { balance: number; date: Date; ticketCount: number }>();
        for (const stmt of settledStatements) {
            const entityId = dimension === "ventana" ? stmt.ventanaId : stmt.vendedorId;
            if (entityId && !entityToStatement.has(entityId)) {
                entityToStatement.set(entityId, {
                    balance: stmt.remainingBalance || 0,
                    date: stmt.date,
                    ticketCount: stmt.ticketCount || 0,
                });
            }
        }

        // Validar cada statement antes de usarlo
        for (const [entityId, stmtInfo] of entityToStatement.entries()) {
            // Verificar si hay tickets válidos para ese statement
            const statementDate = stmtInfo.date;
            const hasValidTickets = await prisma.ticket.count({
                where: {
                    ...(dimension === "ventana" ? { ventanaId: entityId } : { vendedorId: entityId }),
                    OR: [
                        { businessDate: statementDate },
                        {
                            businessDate: null,
                            createdAt: {
                                gte: new Date(statementDate.getTime()),
                                lt: new Date(statementDate.getTime() + 24 * 60 * 60 * 1000),
                            },
                        },
                    ],
                    deletedAt: null,
                    isActive: true,
                    status: { not: "CANCELLED" },
                    sorteo: {
                        status: "EVALUATED",
                    },
                },
            }) > 0;

            // Si el statement tiene tickets válidos o no tiene tickets (saldo 0), usarlo
            if (hasValidTickets || stmtInfo.ticketCount === 0) {
                balancesMap.set(entityId, stmtInfo.balance);
            } else {
                // Statement tiene saldo pero no tiene tickets válidos - marcarlo para recalcular
                logger.warn({
                    layer: "service",
                    action: "PREVIOUS_MONTH_BALANCE_SETTLED_INVALID_BATCH",
                    payload: {
                        effectiveMonth,
                        dimension,
                        entityId,
                        statementDate: statementDate.toISOString().split("T")[0],
                        statementTicketCount: stmtInfo.ticketCount,
                        statementBalance: stmtInfo.balance,
                        reason: "Statement has balance but no valid tickets - will recalculate from source",
                    },
                });
                // No agregar al map, se calculará desde fuente más abajo
            }
        }

        // PASO 3: Para entidades sin statement asentado o con statement inválido, intentar caché o calcular desde fuente
        const missingEntitiesAfterStatements = entityIds.filter(id => !balancesMap.has(id));
        
        if (missingEntitiesAfterStatements.length > 0) {
            logger.info({
                layer: "service",
                action: "PREVIOUS_MONTH_BALANCES_CALCULATING_FROM_SOURCE",
                payload: {
                    effectiveMonth,
                    dimension,
                    missingCount: missingEntitiesAfterStatements.length,
                    totalCount: entityIds.length,
                    reason: "No settled statement or invalid statement (no valid tickets)",
                },
            });

            // Para cada entidad faltante, intentar caché primero
            for (const entityId of missingEntitiesAfterStatements) {
                const cacheKey = {
                    effectiveMonth,
                    dimension,
                    ventanaId: dimension === "ventana" ? entityId : null,
                    vendedorId: dimension === "vendedor" ? entityId : null,
                    bancaId: bancaId || null,
                };
                
                const cachedBalance = await getCachedPreviousMonthBalance(cacheKey);
                if (cachedBalance !== null) {
                    balancesMap.set(entityId, cachedBalance);
                    continue;
                }

                // Si no hay en caché, calcular desde fuente
                const balance = await calculatePreviousMonthBalanceFromSource(
                    effectiveMonth,
                    dimension,
                    dimension === "ventana" 
                        ? { ventanaId: entityId, bancaId: bancaId || null }
                        : { vendedorId: entityId, bancaId: bancaId || null }
                );
                balancesMap.set(entityId, balance);

                // Guardar en caché
                await setCachedPreviousMonthBalance(cacheKey, balance, 300).catch(() => {
                    // Ignorar errores de caché
                });
            }
        }

        return balancesMap;
    } catch (error) {
        logger.warn({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCES_BATCH_ERROR",
            payload: {
                effectiveMonth,
                dimension,
                entityIdsCount: entityIds.length,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        return new Map();
    }
}

/**
 * Obtiene el saldo final del mes anterior para una entidad específica
 * ✅ ESTRATEGIA HÍBRIDA: Intenta usar statements asentados, si no calcula desde fuente de verdad
 * Esto garantiza que siempre tengamos el saldo correcto, independientemente del estado de asentamiento
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'banca' | 'ventana' | 'vendedor'
 * @param ventanaId - ID de ventana (opcional)
 * @param vendedorId - ID de vendedor (opcional)
 * @param bancaId - ID de banca (opcional)
 * @returns Saldo final del mes anterior o 0 si no existe
 */
export async function getPreviousMonthFinalBalance(
    effectiveMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    ventanaId?: string | null,
    vendedorId?: string | null,
    bancaId?: string | null
): Promise<number> {
    try {
        // Calcular mes anterior
        const [year, month] = effectiveMonth.split("-").map(Number);
        const previousYear = month === 1 ? year - 1 : year;
        const previousMonth = month === 1 ? 12 : month - 1;
        const previousMonthStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;

        // ✅ PASO 1: Buscar en tabla de cierre mensual (FUENTE DE VERDAD)
        // Nota: Usamos findFirst porque Prisma no permite null en findUnique con constraint único
        const closingBalance = await prisma.monthlyClosingBalance.findFirst({
            where: {
                closingMonth: previousMonthStr,
                dimension,
                ...(dimension === "vendedor" && vendedorId ? { vendedorId } : {}),
                ...(dimension === "vendedor" && ventanaId ? { ventanaId } : {}),
                ...(dimension === "ventana" && ventanaId ? { ventanaId, vendedorId: null } : {}),
                ...(dimension === "banca" && bancaId ? { bancaId, vendedorId: null, ventanaId: null } : {}),
            },
            select: {
                closingBalance: true,
            },
        });

        if (closingBalance) {
            const balance = parseFloat(closingBalance.closingBalance.toString());
            logger.info({
                layer: "service",
                action: "PREVIOUS_MONTH_BALANCE_FROM_CLOSING",
                payload: {
                    effectiveMonth,
                    dimension,
                    ventanaId,
                    vendedorId,
                    bancaId,
                    closingMonth: previousMonthStr,
                    closingBalance: balance,
                    source: "monthly_closing_balance",
                },
            });
            return balance;
        }

        // ✅ PASO 2: Si no hay cierre, calcular desde fuente (solo para meses históricos sin cierre)
        logger.info({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_CALCULATING_FROM_SOURCE",
            payload: {
                effectiveMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                closingMonth: previousMonthStr,
                reason: "no_closing_balance_found",
            },
        });

        const lastDayNum = new Date(previousYear, previousMonth, 0).getDate();
        const firstDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, 1, 6, 0, 0, 0)); // 00:00 CR
        const lastDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, lastDayNum + 1, 5, 59, 59, 999));

        // Intentar obtener desde statements ASENTADOS del mes anterior (fallback)
        const where: Prisma.AccountStatementWhereInput = {
            date: {
                gte: firstDayOfPreviousMonth,
                lte: lastDayOfPreviousMonth,
            },
            isSettled: true, // ✅ SOLO statements asentados
        };

        if (dimension === "vendedor") {
            if (vendedorId) {
                where.vendedorId = vendedorId;
            }
            if (ventanaId) {
                where.ventanaId = ventanaId;
            }
        } else if (dimension === "ventana") {
            if (ventanaId) {
                where.ventanaId = ventanaId;
            }
            where.vendedorId = null; // Solo statements consolidados de ventana
        } else if (dimension === "banca") {
            where.vendedorId = null; // Solo statements consolidados
            if (bancaId) {
                // ✅ CRÍTICO: AccountStatement tiene bancaId directamente (no usar relación ventana)
                where.bancaId = bancaId;
            }
        }

        // Buscar el último statement asentado del mes anterior
        const lastSettledStatement = await prisma.accountStatement.findFirst({
            where,
            orderBy: {
                date: "desc",
            },
            select: {
                date: true,
                remainingBalance: true,
                ticketCount: true,
            },
        });

        // ✅ VALIDACIÓN CRÍTICA: Verificar que el statement tenga tickets válidos
        // Si el statement tiene saldo pero no tiene tickets, puede ser incorrecto
        // (tickets eliminados/cancelados después del asentamiento)
        if (lastSettledStatement) {
            // Verificar si hay tickets válidos para ese statement
            const statementDate = lastSettledStatement.date;
            const hasValidTickets = await prisma.ticket.count({
                where: {
                    ...(dimension === "vendedor" && vendedorId ? { vendedorId } : {}),
                    ...(dimension === "ventana" && ventanaId ? { ventanaId } : {}),
                    ...(dimension === "banca" && bancaId ? {
                        ventana: { bancaId },
                    } : {}),
                    OR: [
                        { businessDate: statementDate },
                        {
                            businessDate: null,
                            createdAt: {
                                gte: new Date(statementDate.getTime()),
                                lt: new Date(statementDate.getTime() + 24 * 60 * 60 * 1000),
                            },
                        },
                    ],
                    deletedAt: null,
                    isActive: true,
                    status: { not: "CANCELLED" },
                    sorteo: {
                        status: "EVALUATED",
                    },
                },
            }) > 0;

            // Si el statement tiene tickets válidos, usarlo
            if (hasValidTickets || lastSettledStatement.ticketCount === 0) {
                logger.info({
                    layer: "service",
                    action: "PREVIOUS_MONTH_BALANCE_FROM_SETTLED",
                    payload: {
                        effectiveMonth,
                        dimension,
                        source: "settled_statement",
                        statementDate: statementDate.toISOString().split("T")[0],
                        ticketCount: lastSettledStatement.ticketCount,
                        hasValidTickets,
                    },
                });
                return lastSettledStatement.remainingBalance || 0;
            } else {
                // Statement tiene saldo pero no tiene tickets válidos - puede ser incorrecto
                logger.warn({
                    layer: "service",
                    action: "PREVIOUS_MONTH_BALANCE_SETTLED_INVALID",
                    payload: {
                        effectiveMonth,
                        dimension,
                        statementDate: statementDate.toISOString().split("T")[0],
                        statementTicketCount: lastSettledStatement.ticketCount,
                        statementBalance: lastSettledStatement.remainingBalance,
                        reason: "Statement has balance but no valid tickets - recalculating from source",
                    },
                });
                // Continuar para calcular desde fuente
            }
        }

        // PASO 2: Intentar obtener del caché (si fue calculado recientemente)
        const cacheKey = {
            effectiveMonth,
            dimension,
            ventanaId: ventanaId || null,
            vendedorId: vendedorId || null,
            bancaId: bancaId || null,
        };
        const cachedBalance = await getCachedPreviousMonthBalance(cacheKey);
        if (cachedBalance !== null) {
            logger.info({
                layer: "service",
                action: "PREVIOUS_MONTH_BALANCE_FROM_CACHE",
                payload: {
                    effectiveMonth,
                    dimension,
                    source: "cache",
                },
            });
            return cachedBalance;
        }

        // PASO 3: Si no hay en caché, calcular desde fuente de verdad
        logger.info({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_CALCULATING_FROM_SOURCE",
            payload: {
                effectiveMonth,
                dimension,
                source: "tickets_and_payments",
            },
        });

        const balance = await calculatePreviousMonthBalanceFromSource(
            effectiveMonth,
            dimension,
            { ventanaId, vendedorId, bancaId }
        );

        // Guardar en caché (TTL: 5 minutos)
        await setCachedPreviousMonthBalance(cacheKey, balance, 300).catch(() => {
            // Ignorar errores de caché
        });

        return balance;
    } catch (error) {
        // Si hay error, retornar 0 (no bloquear el cálculo)
        logger.warn({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_ERROR",
            payload: {
                effectiveMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                error: error instanceof Error ? error.message : String(error),
            },
        });
        return 0;
    }
}

/**
 * ✅ OPTIMIZACIÓN: Obtiene estados de cuenta asentados desde account_statements
 * Usa datos precomputados (totalSales, totalPayouts, comisiones) pero recalcula movimientos
 * desde AccountPayment para asegurar que estén actualizados
 */
export async function getSettledStatements(
    startDate: Date,
    endDate: Date,
    dimension: "banca" | "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string
): Promise<Map<string, DayStatement>> {
    try {
        // 1. Query optimizada a account_statements (solo asentados)
        const where: Prisma.AccountStatementWhereInput = {
            date: {
                gte: startDate,
                lte: endDate,
            },
            isSettled: true, // ⭐ Solo estados asentados
        };

        // Filtros según dimension
        if (dimension === "vendedor" && vendedorId) {
            where.vendedorId = vendedorId;
        } else if (dimension === "ventana" && ventanaId) {
            where.ventanaId = ventanaId;
            where.vendedorId = null; // Statements consolidados de ventana
        } else if (dimension === "banca" && bancaId) {
            // ✅ CRÍTICO: Incluir statements con bancaId explícito O statements que pertenecen a esa banca a través de ventanaId
            // Algunos statements antiguos pueden tener bancaId=null pero ventanaId que pertenece a esa banca
            where.OR = [
                { bancaId: bancaId },
                {
                    bancaId: null,
                    ventana: {
                        bancaId: bancaId,
                    },
                },
            ];
        }

        const settledStatementsRaw = await prisma.accountStatement.findMany({
            where,
            include: {
                ventana: {
                    select: {
                        name: true,
                        code: true,
                        banca: { select: { id: true, name: true, code: true } }, // ✅ Para obtener banca cuando bancaId es null
                    },
                },
                vendedor: { select: { name: true, code: true } },
                banca: { select: { id: true, name: true, code: true } },
            },
            orderBy: { date: "desc" },
        });

        if (settledStatementsRaw.length === 0) {
            return new Map();
        }

        // 2. Recalcular movimientos desde AccountPayment (batch)
        const statementIds = settledStatementsRaw.map(s => s.id);
        const movementsTotals = await AccountPaymentRepository.getTotalsBatch(statementIds);

        // ✅ CRÍTICO: Determinar si necesitamos agregar por fecha
        // Cuando dimension=banca con bancaId pero sin ventanaId/vendedorId, hay múltiples statements por fecha
        // (uno por cada ventana/vendedor dentro de esa banca) y necesitamos agregarlos
        const requiresGrouping = dimension === "banca" && bancaId && !ventanaId && !vendedorId;

        // 3. Combinar datos consolidados + movimientos actualizados
        // Si requiere agrupación, agrupamos por fecha; si no, usamos Map normal (puede sobrescribir)
        const settledStatementsByDate = new Map<string, DayStatement[]>();

        for (const statement of settledStatementsRaw) {
            const totals = movementsTotals.get(statement.id) || { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 };

            // Calcular balance base (sin movimientos)
            const balanceBase = dimension === "vendedor"
                ? statement.totalSales - statement.totalPayouts - statement.vendedorCommission
                : statement.totalSales - statement.totalPayouts - statement.listeroCommission;

            // Recalcular balance y remainingBalance con movimientos actualizados
            const balance = balanceBase + totals.totalPaid - totals.totalCollected;
            const remainingBalance = balance;

            const dateKey = crDateService.postgresDateToCRString(statement.date);

            // ✅ Obtener bancaId, bancaName, bancaCode (puede venir de statement.banca o statement.ventana.banca)
            const effectiveBancaId = statement.bancaId || statement.ventana?.banca?.id || null;
            const effectiveBancaName = statement.banca?.name || statement.ventana?.banca?.name || null;
            const effectiveBancaCode = statement.banca?.code || statement.ventana?.banca?.code || null;

            const dayStatement: DayStatement = {
                id: statement.id,
                date: statement.date,
                month: statement.month,
                bancaId: effectiveBancaId, // ✅ Usar el bancaId efectivo (del statement o de ventana.banca)
                bancaName: effectiveBancaName,
                bancaCode: effectiveBancaCode,
                ventanaId: statement.ventanaId,
                ventanaName: statement.ventana?.name || null,
                ventanaCode: statement.ventana?.code || null,
                vendedorId: statement.vendedorId,
                vendedorName: statement.vendedor?.name || null,
                vendedorCode: statement.vendedor?.code || null,
                totalSales: statement.totalSales,
                totalPayouts: statement.totalPayouts,
                listeroCommission: statement.listeroCommission,
                vendedorCommission: statement.vendedorCommission,
                balance: parseFloat(balance.toFixed(2)),
                totalPaid: totals.totalPaid, // ⭐ Actualizado desde AccountPayment
                totalCollected: totals.totalCollected, // ⭐ Actualizado desde AccountPayment
                totalPaymentsCollections: totals.totalPaymentsCollections,
                remainingBalance: parseFloat(remainingBalance.toFixed(2)),
                isSettled: true,
                canEdit: false,
                ticketCount: statement.ticketCount,
                createdAt: statement.createdAt,
                updatedAt: statement.updatedAt,
            };

            // Agrupar por fecha (siempre, pero cuando requiresGrouping=true, acumulamos múltiples)
            if (!settledStatementsByDate.has(dateKey)) {
                settledStatementsByDate.set(dateKey, []);
            }
            if (requiresGrouping) {
                // Acumular múltiples statements por fecha
                settledStatementsByDate.get(dateKey)!.push(dayStatement);
            } else {
                // Solo mantener el último (comportamiento original cuando no requiere agrupación)
                settledStatementsByDate.set(dateKey, [dayStatement]);
            }
        }

        // 4. Si requiere agrupación, agregar statements por fecha; si no, usar el único statement por fecha
        const settledStatements = new Map<string, DayStatement>();
        
        for (const [dateKey, statements] of Array.from(settledStatementsByDate.entries())) {
            if (requiresGrouping && statements.length > 1) {
                // Agregar múltiples statements por fecha (sumar totales)
                const aggregated: DayStatement = {
                    id: statements[0].id, // Usar el primer ID (solo para referencia, no tiene significado real cuando está agregado)
                    date: statements[0].date,
                    month: statements[0].month,
                    bancaId: bancaId || null, // Usar el bancaId proporcionado
                    // ✅ Obtener bancaName y bancaCode del primer statement que los tenga, o usar null
                    bancaName: statements.find((s) => s.bancaName)?.bancaName || null,
                    bancaCode: statements.find((s) => s.bancaCode)?.bancaCode || null,
                    ventanaId: null, // Agregado: sin ventanaId específica
                    ventanaName: null,
                    ventanaCode: null,
                    vendedorId: null, // Agregado: sin vendedorId específico
                    vendedorName: null,
                    vendedorCode: null,
                    totalSales: statements.reduce((sum, s) => sum + s.totalSales, 0),
                    totalPayouts: statements.reduce((sum, s) => sum + s.totalPayouts, 0),
                    listeroCommission: statements.reduce((sum, s) => sum + s.listeroCommission, 0),
                    vendedorCommission: statements.reduce((sum, s) => sum + s.vendedorCommission, 0),
                    // ✅ CRÍTICO: Calcular balance agregado usando la comisión correcta según dimension
                    // balance debe incluir movimientos: balance = balanceBase + totalPaid - totalCollected
                    // Donde balanceBase = totalSales - totalPayouts - commission
                    balance: (() => {
                        const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
                        const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
                        const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
                        const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
                        const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
                        // Cuando dimension=banca con bancaId, siempre usar listeroCommission (no vendedorCommission)
                        const balanceBase = totalSales - totalPayouts - totalListeroCommission;
                        // ✅ CRÍTICO: balance debe incluir movimientos (igual que en statements individuales)
                        return balanceBase + totalPaid - totalCollected;
                    })(),
                    totalPaid: statements.reduce((sum, s) => sum + s.totalPaid, 0),
                    totalCollected: statements.reduce((sum, s) => sum + s.totalCollected, 0),
                    totalPaymentsCollections: statements.reduce((sum, s) => sum + s.totalPaymentsCollections, 0),
                    // ✅ CRÍTICO: remainingBalance debe ser igual a balance (que ya incluye movimientos)
                    // En statements individuales: remainingBalance = balance = balanceBase + totalPaid - totalCollected
                    // Entonces cuando agregamos, remainingBalance debe ser igual al balance agregado (que ya incluye movimientos)
                    remainingBalance: (() => {
                        // Reutilizar el cálculo de balance que ya incluye movimientos
                        const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
                        const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
                        const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
                        const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
                        const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
                        // Cuando dimension=banca con bancaId, siempre usar listeroCommission (no vendedorCommission)
                        const balanceBase = totalSales - totalPayouts - totalListeroCommission;
                        // balance ya incluye movimientos, y remainingBalance = balance
                        return balanceBase + totalPaid - totalCollected;
                    })(),
                    isSettled: true,
                    canEdit: false,
                    ticketCount: statements.reduce((sum, s) => sum + s.ticketCount, 0),
                    createdAt: statements.reduce((earliest, s) => s.createdAt < earliest ? s.createdAt : earliest, statements[0].createdAt),
                    updatedAt: statements.reduce((latest, s) => s.updatedAt > latest ? s.updatedAt : latest, statements[0].updatedAt),
                };
                settledStatements.set(dateKey, aggregated);
            } else if (requiresGrouping && statements.length === 1) {
                // Si requiere agrupación pero solo hay un statement, usar ese pero limpiar ventanaId/vendedorId
                const singleStatement = statements[0];
                settledStatements.set(dateKey, {
                    ...singleStatement,
                    ventanaId: null,
                    ventanaName: null,
                    ventanaCode: null,
                    vendedorId: null,
                    vendedorName: null,
                    vendedorCode: null,
                    bancaId: bancaId || singleStatement.bancaId,
                });
            } else {
                // Un solo statement por fecha (comportamiento original cuando no requiere agrupación)
                settledStatements.set(dateKey, statements[0]);
            }
        }

        logger.info({
            layer: "service",
            action: "GET_SETTLED_STATEMENTS",
            payload: {
                dimension,
                bancaId,
                ventanaId,
                vendedorId,
                statementsCount: settledStatements.size,
                rawStatementsCount: settledStatementsRaw.length,
                requiresGrouping,
            },
        });

        return settledStatements;
    } catch (error: any) {
        logger.error({
            layer: "service",
            action: "GET_SETTLED_STATEMENTS_ERROR",
            payload: {
                error: error.message,
                dimension,
                bancaId,
                ventanaId,
                vendedorId,
            },
        });
        // Si hay error, retornar Map vacío (se calculará en tiempo real)
        return new Map();
    }
}

/**
 * ✅ OPTIMIZACIÓN: Identifica días que NO están asentados y requieren cálculo completo
 */
export function getDatesNotSettled(
    startDate: Date,
    endDate: Date,
    settledStatements: Map<string, DayStatement>
): Date[] {
    const dates: Date[] = [];
    const current = new Date(startDate);

    while (current <= endDate) {
        const dateKey = crDateService.postgresDateToCRString(current);
        if (!settledStatements.has(dateKey)) {
            // Este día no está asentado, requiere cálculo completo
            dates.push(new Date(current)); // Clonar para evitar mutación
        }
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
}

/**
 * ✅ OPTIMIZACIÓN: Combina estados asentados y calculados en tiempo real
 */
export function combineSettledAndCalculated(
    settled: Map<string, DayStatement>,
    calculated: DayStatement[],
    startDate: Date,
    endDate: Date,
    sort: "asc" | "desc"
): DayStatement[] {
    const combined = new Map<string, DayStatement>();

    // Agregar estados asentados
    for (const [dateKey, statement] of Array.from(settled.entries())) {
        combined.set(dateKey, statement);
    }

    // Agregar estados calculados (sobrescriben si hay conflicto, pero no debería haberlo)
    for (const statement of calculated) {
        const dateKey = crDateService.postgresDateToCRString(statement.date);
        combined.set(dateKey, statement);
    }

    // Convertir a array y ordenar
    const result = Array.from(combined.values())
        .filter(stmt => {
            // ✅ CRÍTICO: Asegurar que date sea un objeto Date
            const dateObj = stmt.date instanceof Date ? stmt.date : new Date(stmt.date);
            const date = crDateService.postgresDateToCRString(dateObj);
            const startDateCR = crDateService.postgresDateToCRString(startDate);
            const endDateCR = crDateService.postgresDateToCRString(endDate);
            return date >= startDateCR && date <= endDateCR;
        })
        .sort((a, b) => {
            const dateA = (a.date instanceof Date ? a.date : new Date(a.date)).getTime();
            const dateB = (b.date instanceof Date ? b.date : new Date(b.date)).getTime();
            return sort === "desc" ? dateB - dateA : dateA - dateB;
        });

    return result;
}
