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
import { getCachedDayStatement, setCachedDayStatement, getCachedBySorteo, setCachedBySorteo } from "../../../../utils/accountStatementCache";
import { intercalateSorteosAndMovements, SorteoOrMovement } from "./accounts.intercalate";

/**
 * Calcula y actualiza el estado de cuenta para un día específico
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

    // ✅ NUEVO: Detectar si debemos agrupar por fecha solamente (sin separar por entidad)
    // Agrupamos cuando:
    // - dimension=banca y bancaId NO está especificado
    // - dimension=ventana y ventanaId NO está especificado
    // - dimension=vendedor y vendedorId NO está especificado
    // ✅ CRÍTICO: Verificar tanto undefined como null y cadena vacía
    // ✅ CRÍTICO: shouldGroupByDate=true cuando necesitamos agrupar múltiples entidades por fecha
    // - dimension=banca sin bancaId específico (todas las bancas)
    // - dimension=banca con bancaId pero sin ventanaId/vendedorId (todas las ventanas/vendedores de esa banca)
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

    const query = Prisma.sql`
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
      COALESCE(SUM(j.amount), 0) as total_sales,
      0 as total_payouts,
      COUNT(DISTINCT t.id) as total_tickets,
      COALESCE(SUM(j."listeroCommissionAmount"), 0) as commission_listero,
      COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as commission_vendedor
    FROM "Ticket" t
    INNER JOIN "Jugada" j ON j."ticketId" = t.id
    INNER JOIN "Ventana" v ON v.id = t."ventanaId"
    INNER JOIN "Banca" b ON b.id = v."bancaId"
    LEFT JOIN "User" u ON u.id = t."vendedorId"
    WHERE ${Prisma.join(whereConditions, " AND ")}
    AND j."deletedAt" IS NULL
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

    // ✅ NUEVO: Incorporar días que solo tienen movimientos (sin ventas)
    // ✅ NOTA: NO filtrar aquí - necesitamos todos los movimientos del mes para calcular acumulados correctos
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
    // ✅ CRÍTICO: Usar Promise.all para procesar en paralelo y permitir await dentro
    const allStatementsFromMonthPromises = Array.from(byDateAndDimension.entries())
        .map(async ([key, entry]) => {
            // ✅ NUEVO: Si shouldGroupByDate=true, la clave es solo la fecha; si no, es fecha_entidad
            const date = shouldGroupByDate ? key : key.split("_")[0];

            // ✅ NUEVO: Obtener movimientos y desglose por sorteo según si hay agrupación
            const allMovementsForDate = movementsByDate.get(date) || [];
            let movements: any[];
            let bySorteo: any[];

            // ✅ CRÍTICO: Inicializar movements ANTES de cualquier uso (necesario tanto si hay caché como si no)
            if (shouldGroupByDate) {
                movements = allMovementsForDate;
            } else {
                // Sin agrupación: filtrar por entidad
                movements = allMovementsForDate.filter((m: any) => {
                    if (dimension === "banca") {
                        return m.bancaId === entry.bancaId;
                    } else if (dimension === "ventana") {
                        return m.ventanaId === entry.ventanaId;
                    } else {
                        return m.vendedorId === entry.vendedorId;
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
            const totalPaid = movements
                .filter((m: any) => m.type === "payment" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);
            const totalCollected = movements
                .filter((m: any) => m.type === "collection" && !m.isReversed)
                .reduce((sum: number, m: any) => sum + m.amount, 0);

            // ✅ CRÍTICO: Balance del día = ventas - premios - comisiones + movimientos
            // Los movimientos (pagos/cobros) deben participar en el balance diario
            // payment = positivo (aumenta balance), collection = negativo (disminuye balance)
            const balance = entry.totalSales - totalPayouts - commissionToUse + totalPaid - totalCollected;

            // ✅ CRÍTICO: remainingBalance debe ser ACUMULADO REAL hasta esta fecha
            // NO debe depender del filtro de periodo aplicado
            // Se calculará más adelante usando monthlyByDateAndDimension (línea ~1420)
            const remainingBalance = 0; // Temporal, se calcula después

            // ✅ NUEVO: Intercalar sorteos y movimientos en una lista unificada
            const sorteosAndMovements = intercalateSorteosAndMovements(bySorteo, movements, date);

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
                remainingBalance: parseFloat(remainingBalance.toFixed(2)),
                isSettled: calculateIsSettled(entry.totalTicketsCount, remainingBalance, totalPaid, totalCollected),
                canEdit: !calculateIsSettled(entry.totalTicketsCount, remainingBalance, totalPaid, totalCollected),
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
        });
    
    // ✅ CRÍTICO: Esperar todas las promesas antes de ordenar
    const allStatementsFromMonth = await Promise.all(allStatementsFromMonthPromises);
    
    // Ordenar statements por fecha
    allStatementsFromMonth.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            return sort === "desc" ? dateB - dateA : dateA - dateB;
        });

    // ✅ NUEVO: Calcular monthlyAccumulated (Saldo a Hoy - acumulado desde inicio del mes hasta hoy)
    // Esto es INMUTABLE respecto al período filtrado (siempre desde el día 1 del mes hasta hoy)
    const [year, month] = effectiveMonth.split("-").map(Number);
    const monthStartDate = new Date(Date.UTC(year, month - 1, 1)); // Primer día del mes

    // ✅ FIX: Para monthlyAccumulated, usar la MISMA lógica que getMonthDateRange()
    // pero aplicarla aquí para asegurar consistencia temporal dentro del mismo request
    // Esto previene problemas cuando new Date() se llama en momentos diferentes
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
    const monthEndDate = isCurrentMonth ? (today < monthStartDate ? monthStartDate : today) : lastDayOfMonth;
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
    const monthlyRemainingBalance = monthlyTotalBalance;

    const monthlyAccumulated: StatementTotals = {
        totalSales: parseFloat(monthlyTotalSales.toFixed(2)),
        totalPayouts: parseFloat(monthlyTotalPayouts.toFixed(2)),
        totalBalance: parseFloat(monthlyTotalBalance.toFixed(2)),
        totalPaid: parseFloat(monthlyTotalPaid.toFixed(2)),
        totalCollected: parseFloat(monthlyTotalCollected.toFixed(2)),
        totalRemainingBalance: parseFloat(monthlyRemainingBalance.toFixed(2)),
        settledDays: monthlySettledDays,
        pendingDays: monthlyPendingDays,
    };

    // ✅ CRÍTICO: Recalcular remainingBalance acumulado progresivamente
    // El acumulado se calcula SOLO sobre los días mostrados en el resultado
    // El cálculo es TOTALMENTE INDEPENDIENTE de los sorteos - usa solo los balances de los días

    // ✅ CRÍTICO: Paso 1 - Calcular remainingBalance diario para TODOS los días del mes
    // Esto es necesario para que el acumulado sea correcto incluso cuando se filtra por un día específico
    const dailyRemainingBalance = new Map<any, number>();

    for (const statement of allStatementsFromMonth) {
        // ✅ NUEVO: remainingBalance del día = balance (ya incluye movimientos, no volver a aplicarlos)
        const dailyValue = parseFloat(statement.balance.toFixed(2));
        dailyRemainingBalance.set(statement, dailyValue);
    }

    // ✅ CRÍTICO: Paso 2 - Ordenar TODOS los statements del mes por fecha (de menor a mayor)
    allStatementsFromMonth.sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateA - dateB;
    });

    // ✅ CRÍTICO: Paso 3 - Acumular remainingBalance progresivamente para TODOS los días del mes
    const accumulatedByEntity = new Map<string, number>();

    for (const statement of allStatementsFromMonth) {
        // Obtener el ID correcto según la dimensión
        let entityId: string;
        if (dimension === "banca") {
            entityId = statement.bancaId || 'null';
        } else if (dimension === "ventana") {
            entityId = statement.ventanaId || 'null';
        } else {
            entityId = statement.vendedorId || 'null';
        }

        // Obtener el acumulado previo de esta entidad (empieza en 0)
        const prevAccumulated = accumulatedByEntity.get(entityId) || 0;

        // ✅ CRÍTICO: Usar el valor diario guardado, NO el que está en statement.remainingBalance
        // porque ese ya puede haber sido sobreescrito en una iteración anterior
        const dailyValue = dailyRemainingBalance.get(statement)!;
        const newAccumulated = prevAccumulated + dailyValue;

        // Actualizar el mapa de acumulados
        accumulatedByEntity.set(entityId, newAccumulated);

        // Asignar el valor acumulado al statement
        statement.remainingBalance = parseFloat(newAccumulated.toFixed(2));

        // Recalcular isSettled y canEdit con el nuevo remainingBalance
        statement.isSettled = calculateIsSettled(
            statement.ticketCount,
            statement.remainingBalance,
            statement.totalPaid,
            statement.totalCollected
        );
        statement.canEdit = !statement.isSettled;
    }

    // ✅ CRÍTICO: Paso 3.5 - Acumular balance por sorteo progresivamente a través de todos los días
    // El accumulated dentro del día ya está calculado correctamente por intercalateSorteosAndMovements
    // Solo necesitamos arrastrar el último accumulated del día anterior
    let lastDayAccumulated = 0; // Último accumulated del día anterior (acumulado general del día)
    
    for (const statement of allStatementsFromMonth) {
        if (!statement.bySorteo || statement.bySorteo.length === 0) {
            // Si no hay bySorteo, el acumulado se mantiene igual al día anterior
            continue;
        }

        // Ordenar bySorteo por scheduledAt ASC para encontrar el último accumulated del día
        const bySorteoSorted = [...statement.bySorteo].sort((a, b) => {
            const timeA = new Date(a.scheduledAt).getTime();
            const timeB = new Date(b.scheduledAt).getTime();
            return timeA - timeB; // ASC
        });

        // El último accumulated del día (el más reciente en orden cronológico)
        // Este es el acumulado total dentro del día (desde 0)
        const lastAccumulatedOfDay = bySorteoSorted.length > 0 
            ? (bySorteoSorted[bySorteoSorted.length - 1].accumulated || 0)
            : 0;

        // Sumar el accumulated del día anterior a todos los items del día actual
        const adjustedBySorteo = statement.bySorteo.map((item: SorteoOrMovement) => {
            const newAccumulated = lastDayAccumulated + (item.accumulated || 0);
            return {
                ...item,
                accumulated: newAccumulated,
                sorteoAccumulated: newAccumulated,
            };
        });

        // Actualizar el último accumulated para el siguiente día
        // Es el último accumulated ajustado del día actual (que ya incluye lastDayAccumulated)
        lastDayAccumulated = lastDayAccumulated + lastAccumulatedOfDay;
        
        // Actualizar statement.bySorteo (ya está ordenado DESC por intercalateSorteosAndMovements)
        statement.bySorteo = adjustedBySorteo;
    }

    // ✅ CRÍTICO: Paso 4 - Filtrar para retornar solo los días dentro del período solicitado
    // La acumulación ya se calculó correctamente para todos los días del mes
    // Ahora solo devolvemos los días que el usuario pidió ver
    const statements = allStatementsFromMonth.filter(statement => {
        const date = crDateService.dateUTCToCRString(new Date(statement.date));
        return date >= startDateCRStr && date <= endDateCRStr;
    });

    // ✅ CRÍTICO: Paso 5 - Calcular totales SOLO para los días filtrados
    const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
    const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
    const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
    const totalVendedorCommission = statements.reduce((sum, s) => sum + s.vendedorCommission, 0);
    const totalCommissionToUse = vendedorId ? totalVendedorCommission : totalListeroCommission;
    const totalBalance = totalSales - totalPayouts - totalCommissionToUse;
    const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
    const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);
    const totalRemainingBalance = totalBalance - totalCollected + totalPaid;

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
