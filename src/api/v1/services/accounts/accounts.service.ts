import { AccountsFilters, DayStatement, StatementResponse } from "./accounts.types";
import { resolveDateRange } from "../../../../utils/dateRange";
import { getMonthDateRange, toCRDateString } from "./accounts.dates.utils";
import { getMovementsForDay, getSorteoBreakdownBatch } from "./accounts.queries";
import { getStatementDirect, calculateDayStatement, getSettledStatements, getDatesNotSettled } from "./accounts.calculations";
import { registerPayment, reversePayment, deleteStatement } from "./accounts.movements";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import prisma from "../../../../core/prismaClient";
import { Prisma } from "@prisma/client";
import { getCachedStatement, setCachedStatement } from "../../../../utils/accountStatementCache";
import { crDateService } from "../../../../utils/crDateService";
import logger from "../../../../core/logger";

/**
 * Accounts Service
 * Proporciona endpoints para consultar y gestionar estados de cuenta
 * Refactorizado para usar módulos especializados
 */
/**
 * ✅ HELPER BATCH: Obtiene monthlyRemainingBalance (Saldo a Hoy) para múltiples entidades de una vez
 * MUCHO MÁS RÁPIDO que llamar getMonthlyRemainingBalance individualmente
 * 
 * @param month - Mes en formato YYYY-MM (ej: "2026-01")
 * @param dimension - "ventana" | "vendedor"
 * @param entityIds - Array de IDs de entidades (ventanaIds o vendedorIds)
 * @param bancaId - ID de la banca (opcional, para filtrado)
 * @returns Map<entityId, remainingBalance> con el saldo a hoy de cada entidad
 */
export async function getMonthlyRemainingBalancesBatch(
    month: string, // YYYY-MM
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string
): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    
    if (!month || typeof month !== 'string' || !month.includes('-') || entityIds.length === 0) {
        return result;
    }
    
    const { resolveDateRange } = await import('../../../../utils/dateRange');
    const monthRange = resolveDateRange('month');
    const todayRange = resolveDateRange('today');
    const monthStartDate = monthRange.fromAt;
    const todayEndDate = todayRange.toAt;
    
    // ✅ OPTIMIZACIÓN: Una sola query para obtener todos los remainingBalance
    const where: Prisma.AccountStatementWhereInput = {
        date: {
            gte: monthStartDate,
            lte: todayEndDate,
        },
    };
    
    if (dimension === "vendedor") {
        where.vendedorId = { in: entityIds };
    } else if (dimension === "ventana") {
        where.ventanaId = { in: entityIds };
        where.vendedorId = null; // Statement consolidado de ventana
    }
    
    if (bancaId) {
        where.bancaId = bancaId;
    }
    
    // Obtener el último statement de cada entidad hasta hoy
    const statements = await prisma.accountStatement.findMany({
        where,
        select: {
            remainingBalance: true,
            date: true,
            ventanaId: true,
            vendedorId: true,
        },
        orderBy: [
            { date: 'desc' },
            { createdAt: 'desc' },
        ],
    });
    
    // ✅ OPTIMIZACIÓN CRÍTICA: Agrupar por entidad y tomar el más reciente de cada una
    // Solo usar AccountStatement si la fecha es hasta HOY (no futura) y tiene remainingBalance válido
    const latestByEntity = new Map<string, { remainingBalance: number; date: Date; isUpToDate: boolean }>();
    const todayCR = crDateService.dateUTCToCRString(new Date());
    
    for (const stmt of statements) {
        const entityId = dimension === "vendedor" ? stmt.vendedorId : stmt.ventanaId;
        if (!entityId) continue;
        
        // ✅ CRÍTICO: Solo usar statements hasta HOY (no futuros) y con remainingBalance válido
        const stmtDateCR = crDateService.postgresDateToCRString(stmt.date);
        if (stmtDateCR > todayCR) continue; // Ignorar statements futuros
        
        const existing = latestByEntity.get(entityId);
        if (!existing || stmt.date > existing.date) {
            if (stmt.remainingBalance !== null && stmt.remainingBalance !== undefined) {
                const isUpToDate = stmtDateCR === todayCR; // Verificar si es del día de hoy
                latestByEntity.set(entityId, {
                    remainingBalance: Number(stmt.remainingBalance),
                    date: stmt.date,
                    isUpToDate,
                });
            }
        }
    }
    
    // ✅ CRÍTICO: Identificar entidades que necesitan cálculo hasta HOY
    // Si el AccountStatement no es del día de hoy, necesitamos calcular el saldo hasta hoy
    const entitiesNeedingTodayCalculation = entityIds.filter(id => {
        const latest = latestByEntity.get(id);
        return !latest || !latest.isUpToDate; // No hay statement o no está actualizado hasta hoy
    });
    
    // ✅ LOGGING: Para diagnosticar rendimiento
    logger.info({
        layer: "service",
        action: "GET_MONTHLY_REMAINING_BALANCES_BATCH_STATUS",
        payload: {
            dimension,
            month,
            totalEntities: entityIds.length,
            entitiesWithUpToDateStatement: entityIds.length - entitiesNeedingTodayCalculation.length,
            entitiesNeedingCalculation: entitiesNeedingTodayCalculation.length,
            note: entitiesNeedingTodayCalculation.length > 0 
                ? "Some entities need calculation (slower) - AccountStatement not up to date"
                : "All entities have up-to-date AccountStatement (fast)",
        },
    });
    
    // ✅ OPTIMIZACIÓN: Si hay AccountStatement actualizado hasta hoy, usarlo directamente (MUY RÁPIDO)
    for (const entityId of entityIds) {
        const latest = latestByEntity.get(entityId);
        if (latest && latest.isUpToDate) {
            // ✅ USAR remainingBalance de AccountStatement del día de hoy (rápido y confiable)
            result.set(entityId, latest.remainingBalance);
        }
    }
    
    // ✅ CRÍTICO: Para entidades sin AccountStatement o con AccountStatement desactualizado,
    // calcular el saldo hasta HOY usando getStatementDirect (más lento pero preciso)
    if (entitiesNeedingTodayCalculation.length > 0) {
        const { getStatementDirect } = await import('./accounts.calculations');
        const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(monthStartDate, todayEndDate);
        const [year, monthNum] = month.split("-").map(Number);
        const daysInMonth = new Date(year, monthNum, 0).getDate();
        
        // Calcular para cada entidad que necesita actualización (en paralelo para mejor rendimiento)
        await Promise.all(entitiesNeedingTodayCalculation.map(async (entityId) => {
            try {
                const entityVentanaId = dimension === "ventana" ? entityId : undefined;
                const entityVendedorId = dimension === "vendedor" ? entityId : undefined;
                
                const calcResult = await getStatementDirect(
                    {
                        date: "range" as const,
                        fromDate: startDateCRStr,
                        toDate: endDateCRStr,
                        dimension,
                        ventanaId: entityVentanaId,
                        vendedorId: entityVendedorId,
                        bancaId,
                        scope: "all",
                        sort: "desc",
                        userRole: "ADMIN",
                    },
                    monthStartDate,
                    todayEndDate,
                    daysInMonth,
                    month,
                    dimension,
                    entityVentanaId,
                    entityVendedorId,
                    bancaId,
                    "ADMIN",
                    "desc"
                );
                
                if (calcResult.statements && calcResult.statements.length > 0) {
                    // ✅ Obtener el remainingBalance del último día con datos hasta HOY
                    const sortedStatements = [...calcResult.statements].sort((a, b) => 
                        new Date(a.date).getTime() - new Date(b.date).getTime()
                    );
                    const lastStatement = sortedStatements[sortedStatements.length - 1];
                    result.set(entityId, Number(lastStatement.remainingBalance || 0));
                } else {
                    // Si no hay statements, usar saldo del mes anterior
                    const { getPreviousMonthFinalBalance } = await import('./accounts.calculations');
                    const previousBalance = await getPreviousMonthFinalBalance(
                        month,
                        dimension,
                        entityVentanaId,
                        entityVendedorId,
                        bancaId
                    );
                    result.set(entityId, Number(previousBalance || 0));
                }
            } catch (error) {
                logger.error({
                    layer: "service",
                    action: "GET_MONTHLY_REMAINING_BALANCES_BATCH_CALCULATION_ERROR",
                    payload: {
                        entityId,
                        dimension,
                        month,
                        error: (error as Error).message,
                    },
                });
                // Si falla, usar el AccountStatement disponible (si existe) o 0
                const latest = latestByEntity.get(entityId);
                result.set(entityId, latest ? latest.remainingBalance : 0);
            }
        }));
    }
    
    return result;
}

/**
 * ✅ HELPER REUTILIZABLE: Obtiene el monthlyRemainingBalance (Saldo a Hoy) para una entidad específica
 * Esta función calcula el mismo valor que se muestra en estado de cuentas
 * 
 * IMPORTANTE: Calcula el "Saldo a Hoy" = saldo inicial del mes anterior + acumulado desde inicio del mes hasta HOY
 * Incluye: ventas, premios, comisiones, pagos y cobros hasta el día de hoy
 * 
 * ✅ OPTIMIZADO: Primero intenta usar AccountStatement (rápido), solo calcula si no existe
 * 
 * @param month - Mes en formato YYYY-MM (ej: "2026-01")
 * @param dimension - "ventana" | "vendedor"
 * @param ventanaId - ID de la ventana (opcional, requerido si dimension="ventana")
 * @param vendedorId - ID del vendedor (opcional, requerido si dimension="vendedor")
 * @param bancaId - ID de la banca (opcional, para filtrado)
 * @returns remainingBalance del último día con datos hasta HOY (acumulado progresivo que incluye saldo del mes anterior + movimientos hasta hoy)
 */
export async function getMonthlyRemainingBalance(
    month: string, // YYYY-MM
    dimension: "ventana" | "vendedor",
    ventanaId?: string,
    vendedorId?: string,
    bancaId?: string
): Promise<number> {
    // ✅ VALIDACIÓN: Asegurar que month sea válido
    if (!month || typeof month !== 'string' || !month.includes('-')) {
        logger.warn({
            layer: "service",
            action: "GET_MONTHLY_REMAINING_BALANCE_INVALID_MONTH",
            payload: {
                month,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                note: "month is invalid, returning 0",
            },
        });
        return 0;
    }
    
    const { resolveDateRange } = await import('../../../../utils/dateRange');
    
    // ✅ CRÍTICO: Obtener rango desde inicio del mes hasta HOY (no hasta el final del mes)
    const monthRange = resolveDateRange('month'); // Primer día del mes en CR
    const todayRange = resolveDateRange('today'); // Fin del día de hoy en CR
    
    const monthStartDate = monthRange.fromAt; // Primer día del mes en CR
    const todayEndDate = todayRange.toAt; // Fin del día de hoy en CR
    
    // ✅ OPTIMIZACIÓN: Primero intentar obtener desde AccountStatement (mucho más rápido)
    const where: Prisma.AccountStatementWhereInput = {
        date: {
            gte: monthStartDate,
            lte: todayEndDate,
        },
    };
    
    if (dimension === "vendedor" && vendedorId) {
        where.vendedorId = vendedorId;
    } else if (dimension === "ventana" && ventanaId) {
        where.ventanaId = ventanaId;
        where.vendedorId = null; // Statement consolidado de ventana
    }
    
    if (bancaId) {
        where.bancaId = bancaId;
    }
    
    // Buscar el último statement hasta hoy (más reciente)
    const lastStatement = await prisma.accountStatement.findFirst({
        where,
        orderBy: [
            { date: 'desc' },
            { createdAt: 'desc' },
        ],
        select: {
            remainingBalance: true,
            date: true,
        },
    });
    
    if (lastStatement && lastStatement.remainingBalance !== null && lastStatement.remainingBalance !== undefined) {
        // ✅ USAR remainingBalance del AccountStatement (rápido y confiable)
        // Este valor ya incluye: saldoMesAnterior + todos los balances del mes hasta hoy + pagos y cobros hasta hoy
        return Number(lastStatement.remainingBalance);
    }
    
    // ✅ FALLBACK: Si no hay AccountStatement, calcular con getStatementDirect (lento pero necesario)
    // Solo se ejecuta si no hay datos en AccountStatement
    const [year, monthNum] = month.split("-").map(Number);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    
    const { getStatementDirect } = await import('./accounts.calculations');
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(monthStartDate, todayEndDate);
    
    try {
        const result = await getStatementDirect(
            {
                date: "range" as const,
                fromDate: startDateCRStr,
                toDate: endDateCRStr,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                scope: "all",
                sort: "desc",
                userRole: "ADMIN",
            },
            monthStartDate,
            todayEndDate,
            daysInMonth,
            month,
            dimension,
            ventanaId,
            vendedorId,
            bancaId,
            "ADMIN",
            "desc"
        );
        
        // ✅ Obtener el remainingBalance del último statement calculado hasta hoy
        if (result.statements && result.statements.length > 0) {
            // Ordenar por fecha para obtener el último día con datos hasta hoy
            const sortedStatements = [...result.statements].sort((a, b) => 
                new Date(a.date).getTime() - new Date(b.date).getTime()
            );
            const lastStatement = sortedStatements[sortedStatements.length - 1];
            // ✅ Usar remainingBalance del último día con datos hasta hoy
            return Number(lastStatement.remainingBalance || 0);
        }
    } catch (error) {
        logger.error({
            layer: "service",
            action: "GET_MONTHLY_REMAINING_BALANCE_CALCULATION_ERROR",
            payload: {
                month,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                error: (error as Error).message,
            },
        });
    }
    
    // ✅ ÚLTIMO FALLBACK: Si no hay statements hasta hoy, usar el saldo del mes anterior
    const { getPreviousMonthFinalBalance } = await import('./accounts.calculations');
    const previousMonthBalance = await getPreviousMonthFinalBalance(
        month,
        dimension,
        ventanaId,
        vendedorId,
        bancaId
    );
    // Si no hay statements hasta hoy, el remainingBalance es solo el saldo anterior
    return Number(previousMonthBalance || 0);
}

export const AccountsService = {
    /**
     * Obtiene el estado de cuenta día a día del mes o período
     */
    async getStatement(filters: AccountsFilters) {
        const { month, date, fromDate, toDate, dimension, ventanaId, vendedorId, bancaId, sort = "desc" } = filters;

        // ✅ NUEVO: Resolver rango de fechas según filtros proporcionados
        // Prioridad: date > month > mes actual por defecto
        let startDate: Date;
        let endDate: Date;
        let daysInMonth: number;
        let effectiveMonth: string;

        if (date) {
            // Usar filtros de período (date, fromDate, toDate)
            try {
                const dateRange = resolveDateRange(date, fromDate, toDate);
                startDate = dateRange.fromAt;
                endDate = dateRange.toAt;
            } catch (e) {
                // Fallback simple si resolveDateRange no está disponible
                const now = new Date();
                startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
                endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
            }

            // Calcular días en el rango
            const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
            daysInMonth = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
            // Usar el mes del inicio del rango para compatibilidad
            effectiveMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
        } else if (month) {
            // Usar filtro de mes (comportamiento existente)
            const monthRange = getMonthDateRange(month);
            startDate = monthRange.startDate;
            endDate = monthRange.endDate;
            daysInMonth = monthRange.daysInMonth;
            effectiveMonth = month;
        } else {
            // Por defecto: mes actual
            const today = new Date();
            const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
            const monthRange = getMonthDateRange(currentMonth);
            startDate = monthRange.startDate;
            endDate = monthRange.endDate;
            daysInMonth = monthRange.daysInMonth;
            effectiveMonth = currentMonth;
        }

        // ✅ OPTIMIZACIÓN: Intentar obtener del caché primero
        const cacheKey = {
            month: month || undefined,
            date: date || undefined,
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
            dimension,
            ventanaId: ventanaId || null,
            vendedorId: vendedorId || null,
            bancaId: bancaId || null,
            userRole: filters.userRole || "ADMIN",
            sort: sort || "desc",
        };

        const cached = await getCachedStatement(cacheKey);
        if (cached) {
            logger.info({
                layer: 'cache',
                action: 'ACCOUNT_STATEMENT_CACHE_HIT',
                payload: { cacheKey, dimension, bancaId, ventanaId, vendedorId }
            });
            return cached;
        }

        logger.info({
            layer: 'cache',
            action: 'ACCOUNT_STATEMENT_CACHE_MISS',
            payload: { cacheKey, dimension, bancaId, ventanaId, vendedorId }
        });

        // ✅ OPTIMIZACIÓN: Obtener estados asentados (datos consolidados + movimientos actualizados)
        const settledStatements = await getSettledStatements(
            startDate,
            endDate,
            dimension,
            ventanaId,
            vendedorId,
            bancaId
        );

        // ✅ CRÍTICO: Determinar si debemos agrupar por fecha solamente (igual que getStatementDirect)
        // - dimension=banca sin bancaId específico (todas las bancas)
        // - dimension=banca con bancaId pero sin ventanaId/vendedorId (todas las ventanas/vendedores de esa banca)
        const shouldGroupByDate =
            (dimension === "banca" && (!bancaId || bancaId === "" || bancaId === null)) ||
            (dimension === "banca" && bancaId && !ventanaId && !vendedorId) || // ✅ NUEVO: Agrupar cuando hay bancaId pero múltiples ventanas/vendedores
            (dimension === "ventana" && (!ventanaId || ventanaId === "" || ventanaId === null)) ||
            (dimension === "vendedor" && (!vendedorId || vendedorId === "" || vendedorId === null));

        // Identificar días no asentados que requieren cálculo completo
        const datesNotSettled = getDatesNotSettled(startDate, endDate, settledStatements);

        let result;

        // ✅ CRÍTICO: SIEMPRE usar getStatementDirect para obtener bySorteo (sorteos intercalados con pagos/cobros)
        // Los statements asentados de la BD NO incluyen bySorteo, pero el frontend lo necesita siempre
        // Por lo tanto, SIEMPRE calcular con getStatementDirect para tener el desglose completo
        if (false) { // ✅ DESHABILITADO: Ya no usamos statements asentados directamente porque no tienen bySorteo
            // ✅ TODOS los días están asentados Y NO hay agrupación - solo usar datos precomputados
            logger.info({
                layer: 'service',
                action: 'ACCOUNT_STATEMENT_ALL_SETTLED',
                payload: { dimension, bancaId, ventanaId, vendedorId, count: settledStatements.size }
            });

            // Combinar todos los estados asentados
            const allStatements = Array.from(settledStatements.values())
                .sort((a, b) => {
                    const dateA = new Date(a.date).getTime();
                    const dateB = new Date(b.date).getTime();
                    return sort === "desc" ? dateB - dateA : dateA - dateB;
                });

            // Calcular totales desde estados asentados
            const totalSales = allStatements.reduce((sum, s) => sum + s.totalSales, 0);
            const totalPayouts = allStatements.reduce((sum, s) => sum + s.totalPayouts, 0);
            const totalListeroCommission = allStatements.reduce((sum, s) => sum + s.listeroCommission, 0);
            const totalVendedorCommission = allStatements.reduce((sum, s) => sum + s.vendedorCommission, 0);
            // ✅ CRÍTICO: Usar comisión correcta según dimension (no vendedorId)
            // - Si dimension='vendedor' → usar vendedorCommission
            // - Si dimension='banca' o 'ventana' → usar listeroCommission (siempre)
            const totalCommissionToUse = dimension === "vendedor" ? totalVendedorCommission : totalListeroCommission;
            const totalPaid = allStatements.reduce((sum, s) => sum + s.totalPaid, 0);
            const totalCollected = allStatements.reduce((sum, s) => sum + s.totalCollected, 0);
            // ✅ CRÍTICO: totalBalance debe incluir movimientos (igual que balance en statements individuales)
            // balance = balanceBase + totalPaid - totalCollected, donde balanceBase = totalSales - totalPayouts - commission
            const totalBalanceBase = totalSales - totalPayouts - totalCommissionToUse;
            const totalBalance = totalBalanceBase + totalPaid - totalCollected;
            // ✅ CRÍTICO: totalRemainingBalance = totalBalance (que ya incluye movimientos)
            // NO usar suma de remainingBalance porque esos valores son acumulados progresivamente
            const totalRemainingBalance = totalBalance;

            // Calcular acumulados del mes (desde todos los días asentados del mes)
            const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(startDate, endDate);
            const [yearForMonth, monthForMonth] = effectiveMonth.split("-").map(Number);
            const monthStartDate = new Date(Date.UTC(yearForMonth, monthForMonth - 1, 1));
            const monthEndDate = new Date(Date.UTC(yearForMonth, monthForMonth, 0, 23, 59, 59, 999));
            
            // ✅ OPTIMIZACIÓN: Si el período filtrado es el mes completo, reutilizar los mismos datos
            const isFullMonth = startDate.getTime() === monthStartDate.getTime() && 
                                endDate.getTime() === monthEndDate.getTime();
            
            let allStatementsFromMonth: DayStatement[];
            if (isFullMonth) {
                // El período filtrado es el mes completo, usar los mismos statements
                allStatementsFromMonth = allStatements;
            } else {
                // Obtener todos los días asentados del mes (para acumulados)
                const allSettledFromMonth = await getSettledStatements(
                    monthStartDate,
                    monthEndDate,
                    dimension,
                    ventanaId,
                    vendedorId,
                    bancaId
                );
                allStatementsFromMonth = Array.from(allSettledFromMonth.values());
            }
            const monthlyTotalSales = allStatementsFromMonth.reduce((sum, s) => sum + s.totalSales, 0);
            const monthlyTotalPayouts = allStatementsFromMonth.reduce((sum, s) => sum + s.totalPayouts, 0);
            const monthlyTotalListeroCommission = allStatementsFromMonth.reduce((sum, s) => sum + s.listeroCommission, 0);
            const monthlyTotalVendedorCommission = allStatementsFromMonth.reduce((sum, s) => sum + s.vendedorCommission, 0);
            // ✅ CRÍTICO: Usar comisión correcta según dimension (no vendedorId)
            // - Si dimension='vendedor' → usar vendedorCommission
            // - Si dimension='banca' o 'ventana' → usar listeroCommission (siempre)
            const monthlyTotalCommissionToUse = dimension === "vendedor" ? monthlyTotalVendedorCommission : monthlyTotalListeroCommission;
            const monthlyTotalPaid = allStatementsFromMonth.reduce((sum, s) => sum + s.totalPaid, 0);
            const monthlyTotalCollected = allStatementsFromMonth.reduce((sum, s) => sum + s.totalCollected, 0);
            // ✅ CRÍTICO: monthlyTotalBalance debe incluir movimientos (igual que balance en statements individuales)
            // balance = balanceBase + totalPaid - totalCollected, donde balanceBase = totalSales - totalPayouts - commission
            const monthlyTotalBalanceBase = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalCommissionToUse;
            const monthlyTotalBalance = monthlyTotalBalanceBase + monthlyTotalPaid - monthlyTotalCollected;
            // ✅ CORRECCIÓN CRÍTICA: monthlyRemainingBalance debe ser el remainingBalance del último día del mes
            // Este es el acumulado progresivo del mes completo (invariable), NO la suma de balances
            // El remainingBalance del último día ya incluye: saldoMesAnterior + todos los balances del mes acumulados
            let monthlyRemainingBalance = 0;
            if (allStatementsFromMonth.length > 0) {
                // Ordenar por fecha para obtener el último día del mes
                const sortedStatements = [...allStatementsFromMonth].sort((a, b) => 
                    new Date(a.date).getTime() - new Date(b.date).getTime()
                );
                const lastStatementOfMonth = sortedStatements[sortedStatements.length - 1];
                // ✅ Usar remainingBalance del último día (acumulado progresivo del mes completo)
                monthlyRemainingBalance = Number(lastStatementOfMonth.remainingBalance || 0);
            } else {
                // Si no hay statements, usar monthlyTotalBalance como fallback
                monthlyRemainingBalance = monthlyTotalBalance;
            }

            result = {
                statements: allStatements,
                totals: {
                    totalSales: parseFloat(totalSales.toFixed(2)),
                    totalPayouts: parseFloat(totalPayouts.toFixed(2)),
                    totalListeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
                    totalVendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
                    totalBalance: parseFloat(totalBalance.toFixed(2)),
                    totalPaid: parseFloat(totalPaid.toFixed(2)),
                    totalCollected: parseFloat(totalCollected.toFixed(2)),
                    totalRemainingBalance: parseFloat(totalRemainingBalance.toFixed(2)),
                    settledDays: allStatements.length,
                    pendingDays: 0,
                },
                monthlyAccumulated: {
                    totalSales: parseFloat(monthlyTotalSales.toFixed(2)),
                    totalPayouts: parseFloat(monthlyTotalPayouts.toFixed(2)),
                    totalBalance: parseFloat(monthlyTotalBalance.toFixed(2)),
                    totalPaid: parseFloat(monthlyTotalPaid.toFixed(2)),
                    totalCollected: parseFloat(monthlyTotalCollected.toFixed(2)),
                    totalRemainingBalance: parseFloat(monthlyRemainingBalance.toFixed(2)),
                    settledDays: allStatementsFromMonth.length,
                    pendingDays: 0,
                },
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
        } else {
            // ✅ HAY días no asentados O shouldGroupByDate=true - calcular todo con getStatementDirect para obtener bySorteo
            logger.info({
                layer: 'service',
                action: 'ACCOUNT_STATEMENT_CALCULATING',
                payload: {
                    dimension,
                    bancaId,
                    ventanaId,
                    vendedorId,
                    shouldGroupByDate,
                    settledCount: settledStatements.size,
                    notSettledCount: datesNotSettled.length,
                    reason: shouldGroupByDate ? 'grouping_required' : 'partial_settled',
                }
            });

            // Calcular TODO el rango (necesario para acumulados correctos y para obtener bySorteo cuando hay agrupación)
            const calculatedResult = await getStatementDirect(
                filters,
                startDate,
                endDate,
                daysInMonth,
                effectiveMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                filters.userRole || "ADMIN",
                sort as "asc" | "desc"
            );

            // ✅ CRÍTICO: SIEMPRE usar los statements calculados directamente porque tienen bySorteo
            // NO reemplazar con settledStatements porque estos NO incluyen bySorteo (sorteos intercalados con pagos/cobros)
            // getStatementDirect ya calcula correctamente desde tickets y genera bySorteo completo
            const optimizedStatements = calculatedResult.statements;

            // Recalcular totales desde statements optimizados
            const totalSales = optimizedStatements.reduce((sum, s) => sum + s.totalSales, 0);
            const totalPayouts = optimizedStatements.reduce((sum, s) => sum + s.totalPayouts, 0);
            const totalListeroCommission = optimizedStatements.reduce((sum, s) => sum + s.listeroCommission, 0);
            const totalVendedorCommission = optimizedStatements.reduce((sum, s) => sum + s.vendedorCommission, 0);
            // ✅ CRÍTICO: Usar comisión correcta según dimension (no vendedorId)
            // - Si dimension='vendedor' → usar vendedorCommission
            // - Si dimension='banca' o 'ventana' → usar listeroCommission (siempre)
            const totalCommissionToUse = dimension === "vendedor" ? totalVendedorCommission : totalListeroCommission;
            // ✅ CRÍTICO: Usar los totales calculados por getStatementDirect que ya incluyen el saldo del mes anterior
            // getStatementDirect ya calcula correctamente todos los totales incluyendo el saldo del mes anterior
            result = {
                statements: optimizedStatements,
                totals: {
                    totalSales: calculatedResult.totals.totalSales,
                    totalPayouts: calculatedResult.totals.totalPayouts,
                    totalListeroCommission: calculatedResult.totals.totalListeroCommission,
                    totalVendedorCommission: calculatedResult.totals.totalVendedorCommission,
                    totalBalance: calculatedResult.totals.totalBalance,
                    totalPaid: calculatedResult.totals.totalPaid,
                    totalCollected: calculatedResult.totals.totalCollected,
                    totalRemainingBalance: calculatedResult.totals.totalRemainingBalance,
                    settledDays: optimizedStatements.filter(s => s.isSettled).length,
                    pendingDays: optimizedStatements.filter(s => !s.isSettled).length,
                },
                monthlyAccumulated: calculatedResult.monthlyAccumulated, // Usar acumulados del cálculo completo
                meta: calculatedResult.meta,
            };
        }

        // Guardar en caché con TTL diferenciado
        const cacheTTL = datesNotSettled.length > 0 ? 60 : 900; // 1 min vs 15 min
        setCachedStatement(cacheKey, result, cacheTTL).catch(() => {
            // Ignorar errores de caché
        });

        return result;
    },

    /**
     * Obtiene el estado de cuenta de un día específico
     * (Wrapper para calculateDayStatement)
     */
    getDayStatement: calculateDayStatement,

    /**
     * Registra un pago o cobro
     */
    createPayment: registerPayment, // Alias para compatibilidad
    registerPayment,

    /**
     * Revierte un pago o cobro
     */
    reversePayment,

    /**
     * Obtiene el historial de pagos de un statement
     * Mantiene compatibilidad con la firma anterior: (date: Date, filters: AccountsFilters)
     */
    async getPaymentHistory(date: any, filters: any) {
        // Si el primer argumento es string, asumir que es statementId (uso interno nuevo)
        if (typeof date === 'string' && !date.includes('-')) {
            return getMovementsForDay(date);
        }

        // Si es fecha y filtros (uso legacy del controller)
        let targetDate: Date;
        if (typeof date === 'string') {
            // Parse date string in format YYYY-MM-DD
            // This represents a day in Costa Rica timezone
            const [year, month, day] = date.split('-').map(Number);
            targetDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        } else {
            targetDate = date;
        }

        const { ventanaId, vendedorId } = filters;

        // Buscar el statement correspondiente
        const statement = await AccountStatementRepository.findByDate(targetDate, {
            ventanaId,
            vendedorId,
        });

        if (!statement) {
            return [];
        }

        return getMovementsForDay(statement.id);
    },

    /**
     * Elimina un estado de cuenta
     */
    deleteStatement,

    /**
     * ✅ NUEVO: Obtiene bySorteo (sorteos intercalados con movimientos) para un día específico
     * Usado para lazy loading desde el frontend
     * ✅ ACTUALIZADO: Ahora incluye el acumulado progresivo del día anterior
     */
    async getBySorteo(
        date: string, // YYYY-MM-DD
        filters: {
            dimension: "banca" | "ventana" | "vendedor";
            ventanaId?: string;
            vendedorId?: string;
            bancaId?: string;
            userRole?: "ADMIN" | "VENTANA" | "VENDEDOR";
        },
        includePreviousDayAccumulated: boolean = true // ✅ NUEVO: Flag para controlar si se incluye acumulado del día anterior
    ) {
        // Convertir fecha string a Date
        const [year, month, day] = date.split('-').map(Number);
        const targetDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

        // ✅ NUEVO: Calcular fecha del día anterior
        const previousDayDate = new Date(targetDate);
        previousDayDate.setUTCDate(previousDayDate.getUTCDate() - 1);
        const previousDateStr = `${previousDayDate.getUTCFullYear()}-${String(previousDayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(previousDayDate.getUTCDate()).padStart(2, '0')}`;

        // ✅ NUEVO: Obtener el último accumulated del día anterior (si se solicita)
        // ✅ OPTIMIZADO: Para el día 1, no consultar el día anterior (no existe)
        // Para días siguientes, primero intentar leer directamente de AccountStatement
        // Solo si no existe o no es válido, entonces calcular con getStatementDirect
        const firstDayOfMonthStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const isFirstDay = date === firstDayOfMonthStr;
        let lastDayAccumulated = 0;
        if (includePreviousDayAccumulated && !isFirstDay) {
            try {
                // ✅ OPTIMIZACIÓN: Primero intentar leer directamente de AccountStatement
                // previousDayDate ya está definido arriba, solo necesitamos usarlo directamente
                
                // Determinar IDs según la dimensión
                let targetBancaId: string | undefined = undefined;
                let targetVentanaId: string | undefined = undefined;
                let targetVendedorId: string | undefined = undefined;
                
                if (filters.dimension === "banca") {
                    targetBancaId = filters.bancaId || undefined;
                    // ✅ CRÍTICO: Si dimension="banca" sin bancaId, buscar statement consolidado
                    // (sin ventanaId ni vendedorId)
                } else if (filters.dimension === "ventana") {
                    targetBancaId = filters.bancaId || undefined;
                    targetVentanaId = filters.ventanaId || undefined;
                } else if (filters.dimension === "vendedor") {
                    targetBancaId = filters.bancaId || undefined;
                    targetVentanaId = filters.ventanaId || undefined;
                    targetVendedorId = filters.vendedorId || undefined;
                }
                
                // ✅ CORRECCIÓN CRÍTICA: Buscar statement del día anterior según dimensión
                // Si dimension="banca" sin bancaId, buscar statement consolidado (bancaId: null, ventanaId: null, vendedorId: null)
                // Si dimension="banca" con bancaId, buscar por bancaId (bancaId: X, ventanaId: null, vendedorId: null)
                let dbStatement: any = null;
                
                if (filters.dimension === "banca" && !targetBancaId) {
                    // Buscar statement consolidado (sin ventanaId ni vendedorId)
                    dbStatement = await prisma.accountStatement.findFirst({
                        where: {
                            date: previousDayDate,
                            bancaId: null,
                            ventanaId: null,
                            vendedorId: null,
                        },
                    });
                } else {
                    // ✅ CRÍTICO: Si dimension="banca" con bancaId específico, buscar directamente el statement consolidado
                    // NO usar findByDate porque no filtra por bancaId y puede devolver statements incorrectos
                    if (filters.dimension === "banca" && targetBancaId) {
                        // Buscar específicamente el statement consolidado de la banca (ventanaId=null, vendedorId=null)
                        dbStatement = await prisma.accountStatement.findFirst({
                            where: {
                                date: previousDayDate,
                                bancaId: targetBancaId,
                                ventanaId: null,
                                vendedorId: null,
                            },
                        });
                    } else {
                        // Para otras dimensiones (ventana, vendedor), usar findByDate
                        dbStatement = await AccountStatementRepository.findByDate(previousDayDate, {
                            ventanaId: targetVentanaId,
                            vendedorId: targetVendedorId,
                        });
                    }
                }
                
                // ✅ CORRECCIÓN CRÍTICA: Para el acumulado progresivo de sorteos, necesitamos el
                // remainingBalance del día anterior (que es el acumulado al final del día anterior)
                // Este es el valor correcto para iniciar el acumulado del día actual
                if (dbStatement && dbStatement.remainingBalance !== null && dbStatement.remainingBalance !== undefined) {
                    // ✅ Usar remainingBalance del día anterior (acumulado al final del día anterior)
                    // Incluso si es 0, es el valor correcto (día anterior sin saldo)
                    lastDayAccumulated = Number(dbStatement.remainingBalance);
                    
                    logger.info({
                        layer: "service",
                        action: "GET_BY_SORTEO_USING_DB_STATEMENT",
                        payload: {
                            date,
                            previousDate: previousDateStr,
                            dimension: filters.dimension,
                            bancaId: filters.bancaId,
                            ventanaId: filters.ventanaId,
                            vendedorId: filters.vendedorId,
                            dbStatementId: dbStatement.id,
                            remainingBalance: Number(dbStatement.remainingBalance),
                            accumulatedBalance: dbStatement.accumulatedBalance ? Number(dbStatement.accumulatedBalance) : null,
                            lastDayAccumulated,
                        },
                    });
                } else {
                    logger.warn({
                        layer: "service",
                        action: "GET_BY_SORTEO_DB_STATEMENT_NOT_FOUND",
                        payload: {
                            date,
                            previousDate: previousDateStr,
                            dimension: filters.dimension,
                            bancaId: filters.bancaId,
                            ventanaId: filters.ventanaId,
                            vendedorId: filters.vendedorId,
                            note: "No se encontró dbStatement del día anterior, calculando con getStatementDirect",
                        },
                    });
                    // ✅ Si no existe en la BD, calcular con getStatementDirect (fallback)
                    const [prevYear, prevMonth, prevDay] = previousDateStr.split('-').map(Number);
                    const monthStartDate = new Date(Date.UTC(prevYear, prevMonth - 1, 1));
                    const previousDayEndDate = new Date(Date.UTC(prevYear, prevMonth - 1, prevDay, 23, 59, 59, 999));
                    const monthStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
                    const daysInMonth = new Date(prevYear, prevMonth, 0).getDate();
                    
                    // Obtener statements desde inicio del mes hasta día anterior
                    const statementsFromMonthStart = await getStatementDirect(
                    {
                        date: "range" as const,
                        fromDate: `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`,
                        toDate: previousDateStr,
                        dimension: filters.dimension,
                        ventanaId: filters.ventanaId,
                        vendedorId: filters.vendedorId,
                        bancaId: filters.bancaId,
                        scope: "all",
                        sort: "desc",
                        userRole: filters.userRole || "ADMIN",
                    },
                    monthStartDate,
                    previousDayEndDate,
                    daysInMonth,
                    monthStr,
                    filters.dimension,
                    filters.ventanaId,
                    filters.vendedorId,
                    filters.bancaId,
                    filters.userRole || "ADMIN",
                    "desc"
                );
                
                // ✅ CRÍTICO: Buscar el último statement con datos (no necesariamente el día anterior)
                // Si el día anterior no tiene datos, buscar el último día que sí tiene datos
                // Esto es importante cuando hay días sin ventas entre el último día con datos y el día actual
                let previousDayStatement: any = null;
                
                // Primero intentar encontrar el día anterior exacto
                previousDayStatement = statementsFromMonthStart.statements?.find((s: any) => {
                    const statementDate = crDateService.dateUTCToCRString(new Date(s.date));
                    const dateMatches = statementDate === previousDateStr;
                    
                    // ✅ CRÍTICO: Verificar que el statement corresponda al mismo vendedorId si hay filtro
                    if (filters.dimension === "vendedor" && filters.vendedorId) {
                        return dateMatches && s.vendedorId === filters.vendedorId;
                    }
                    
                    return dateMatches;
                });
                
                // Si no se encuentra el día anterior, buscar el último día con datos antes del día actual
                if (!previousDayStatement && statementsFromMonthStart.statements && statementsFromMonthStart.statements.length > 0) {
                    // Filtrar statements que sean anteriores al día actual y correspondan al mismo vendedorId
                    const candidateStatements = statementsFromMonthStart.statements
                        .filter((s: any) => {
                            const statementDate = crDateService.dateUTCToCRString(new Date(s.date));
                            const statementDateObj = new Date(statementDate);
                            const targetDateObj = new Date(date);
                            
                            // Solo considerar statements anteriores al día actual
                            if (statementDateObj >= targetDateObj) {
                                return false;
                            }
                            
                            // ✅ CRÍTICO: Verificar que el statement corresponda al mismo vendedorId si hay filtro
                            if (filters.dimension === "vendedor" && filters.vendedorId) {
                                return s.vendedorId === filters.vendedorId;
                            }
                            
                            return true;
                        })
                        .sort((a: any, b: any) => {
                            // Ordenar por fecha DESC para obtener el más reciente
                            const dateA = new Date(crDateService.dateUTCToCRString(new Date(a.date))).getTime();
                            const dateB = new Date(crDateService.dateUTCToCRString(new Date(b.date))).getTime();
                            return dateB - dateA; // DESC
                        });
                    
                    // Tomar el más reciente (el primero después de ordenar DESC)
                    if (candidateStatements.length > 0) {
                        previousDayStatement = candidateStatements[0];
                    }
                }
                
                if (previousDayStatement) {
                    // ✅ CRÍTICO: Priorizar accumulatedBalance desde AccountStatement (fuente de verdad)
                    // Si hay bySorteo, usar el último accumulated del bySorteo (ya calculado con accumulatedBalance como base)
                    // Si no hay bySorteo, buscar el accumulatedBalance directamente desde AccountStatement
                    
                    // ✅ CORRECCIÓN CRÍTICA: Para el acumulado progresivo de sorteos, necesitamos el
                    // remainingBalance del día anterior (acumulado al FINAL del día anterior, después de todos los eventos)
                    // NO accumulatedBalance (que es al inicio del día)
                    // 
                    // PRIORIDAD:
                    // 1. Último accumulated del bySorteo del día anterior (más preciso)
                    // 2. remainingBalance del AccountStatement del día anterior (fallback rápido)
                    // 3. remainingBalance del statement calculado (fallback lento)
                    
                    // PRIORIDAD 1: Si hay bySorteo del día anterior, usar el último accumulated
                    if (previousDayStatement.bySorteo && previousDayStatement.bySorteo.length > 0) {
                        // ✅ CRÍTICO: Ordenar por tiempo ASC para obtener el último evento (más reciente)
                        const sortedBySorteo = [...previousDayStatement.bySorteo].sort((a: any, b: any) => {
                            const timeA = new Date(a.scheduledAt).getTime();
                            const timeB = new Date(b.scheduledAt).getTime();
                            if (timeA !== timeB) {
                                return timeA - timeB; // ASC por tiempo
                            }
                            // Si mismo tiempo, usar chronologicalIndex ASC (mayor índice = más reciente)
                            const indexA = a.chronologicalIndex || 0;
                            const indexB = b.chronologicalIndex || 0;
                            return indexA - indexB; // ASC por índice
                        });
                        
                        // El último elemento es el más reciente (mayor tiempo, o si igual, mayor chronologicalIndex)
                        const lastEvent = sortedBySorteo[sortedBySorteo.length - 1];
                        if (lastEvent && lastEvent.accumulated !== undefined && lastEvent.accumulated !== null) {
                            lastDayAccumulated = Number(lastEvent.accumulated);
                            
                            logger.debug({
                                layer: "service",
                                action: "GET_BY_SORTEO_USING_PREVIOUS_BYSORTEO",
                                payload: {
                                    date,
                                    previousDate: previousDateStr,
                                    lastEventAccumulated: Number(lastEvent.accumulated),
                                    lastDayAccumulated,
                                },
                            });
                        } else {
                            // Fallback: usar remainingBalance del statement
                            lastDayAccumulated = previousDayStatement.remainingBalance || 0;
                            
                            logger.debug({
                                layer: "service",
                                action: "GET_BY_SORTEO_USING_PREVIOUS_REMAINING_BALANCE",
                                payload: {
                                    date,
                                    previousDate: previousDateStr,
                                    remainingBalance: previousDayStatement.remainingBalance,
                                    lastDayAccumulated,
                                },
                            });
                        }
                    } else {
                        // PRIORIDAD 2: Si no hay bySorteo, usar remainingBalance del día anterior
                        // remainingBalance es el acumulado al final del día anterior (después de todos los eventos)
                        lastDayAccumulated = previousDayStatement.remainingBalance || 0;
                        
                        logger.debug({
                            layer: "service",
                            action: "GET_BY_SORTEO_USING_PREVIOUS_REMAINING_BALANCE_NO_BYSORTEO",
                            payload: {
                                date,
                                previousDate: previousDateStr,
                                remainingBalance: previousDayStatement.remainingBalance,
                                lastDayAccumulated,
                            },
                        });
                    }
                } else {
                    // No se encontró statement del día anterior, usar 0
                    logger.warn({
                        layer: "service",
                        action: "GET_BY_SORTEO_NO_PREVIOUS_STATEMENT",
                        payload: {
                            date,
                            previousDate: previousDateStr,
                            dimension: filters.dimension,
                            bancaId: filters.bancaId,
                            ventanaId: filters.ventanaId,
                            vendedorId: filters.vendedorId,
                            statementsFromMonthStartCount: statementsFromMonthStart?.statements?.length || 0,
                            note: "No se encontró statement del día anterior, usando 0 como initialAccumulated",
                        },
                    });
                }
                } // ✅ Cierre del bloque else que comienza en la línea 446
            } catch (error) {
                // Si hay error al obtener el día anterior (ej: no existe), usar 0
                // Esto es normal para el primer día del mes o si no hay datos previos
                lastDayAccumulated = 0;
            }
        }

        // Obtener sorteos del día usando getSorteoBreakdownBatch
        const sorteoBreakdownBatch = await getSorteoBreakdownBatch(
            [targetDate],
            filters.dimension,
            filters.ventanaId,
            filters.vendedorId,
            filters.bancaId,
            filters.userRole || "ADMIN"
        );

        // Obtener movimientos del día
        const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
            targetDate,
            new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)),
            filters.dimension,
            filters.ventanaId,
            filters.vendedorId,
            filters.bancaId
        );

        // ✅ NUEVO: Agregar movimiento especial del saldo del mes anterior para el primer día
        // ✅ NOTA: isFirstDay y firstDayOfMonthStr ya están definidos arriba (líneas 402-403)
        let previousMonthBalance = 0;
        if (isFirstDay) {
            const { getPreviousMonthFinalBalance } = await import('./accounts.calculations');
            const effectiveMonth = `${year}-${String(month).padStart(2, '0')}`;
            
            if (filters.dimension === "banca") {
                previousMonthBalance = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "banca",
                    undefined,
                    undefined,
                    filters.bancaId || null
                );
            } else if (filters.dimension === "ventana") {
                previousMonthBalance = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "ventana",
                    filters.ventanaId || null,
                    undefined,
                    filters.bancaId
                );
            } else {
                previousMonthBalance = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "vendedor",
                    undefined,
                    filters.vendedorId || null,
                    filters.bancaId
                );
            }
            
            if (previousMonthBalance !== 0) {
                const firstDayMovements = movementsByDate.get(date) || [];
                // ✅ CRÍTICO: Verificar que no exista ya un movimiento especial con el mismo ID
                const existingSpecialMovement = firstDayMovements.find((m: any) => m.id?.startsWith('previous-month-balance-'));
                if (!existingSpecialMovement) {
                    const entityId = filters.dimension === "banca" 
                        ? (filters.bancaId || 'null')
                        : filters.dimension === "ventana"
                            ? (filters.ventanaId || 'null')
                            : (filters.vendedorId || 'null');
                    
                    // ✅ CRÍTICO: El movimiento especial tiene balance: 0 porque el saldo ya está en initialAccumulated
                    // Pero amount debe ser el saldo del mes anterior para mostrarlo en el frontend
                    firstDayMovements.unshift({
                        id: `previous-month-balance-${entityId}`,
                        type: "payment" as const,
                        amount: previousMonthBalance, // ✅ Para mostrar en el frontend
                        method: "Saldo del mes anterior",
                        notes: `Saldo arrastrado del mes anterior`,
                        isReversed: false,
                        createdAt: new Date(`${date}T00:00:00.000Z`).toISOString(),
                        date: date,
                        time: "00:00",
                        balance: 0, // ✅ CRÍTICO: Balance = 0 porque ya está en initialAccumulated
                        bancaId: filters.dimension === "banca" ? (filters.bancaId || null) : null,
                        ventanaId: filters.dimension === "ventana" ? (filters.ventanaId || null) : null,
                        vendedorId: filters.dimension === "vendedor" ? (filters.vendedorId || null) : null,
                    });
                    movementsByDate.set(date, firstDayMovements);
                }
            }
        }

        // Determinar si hay agrupación
        const shouldGroupByDate =
            (filters.dimension === "banca" && (!filters.bancaId || filters.bancaId === "" || filters.bancaId === null)) ||
            (filters.dimension === "banca" && filters.bancaId && !filters.ventanaId && !filters.vendedorId) ||
            (filters.dimension === "ventana" && (!filters.ventanaId || filters.ventanaId === "" || filters.ventanaId === null)) ||
            (filters.dimension === "vendedor" && (!filters.vendedorId || filters.vendedorId === "" || filters.vendedorId === null));

        // Obtener bySorteo según agrupación
        let bySorteo: any[];
        const allMovementsForDate = movementsByDate.get(date) || [];
        let movements: any[];

        if (shouldGroupByDate) {
            // Agrupar sorteos por fecha (sumar todos los sorteos de todas las entidades)
            const sorteoMap = new Map<string, any>();
            for (const [sorteoKey, sorteoDataArray] of sorteoBreakdownBatch.entries()) {
                const sorteoDate = sorteoKey.split("_")[0];
                if (sorteoDate === date) {
                    for (const sorteoData of sorteoDataArray) {
                        const sorteoId = sorteoData.sorteoId;
                        if (sorteoId) {
                            const existing = sorteoMap.get(sorteoId);
                            if (existing) {
                                existing.sales += sorteoData.sales;
                                existing.payouts += sorteoData.payouts;
                                existing.listeroCommission += sorteoData.listeroCommission;
                                existing.vendedorCommission += sorteoData.vendedorCommission;
                                const commissionToUse = filters.vendedorId ? existing.vendedorCommission : existing.listeroCommission;
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
                                    balance: sorteoData.sales - sorteoData.payouts - (filters.vendedorId ? sorteoData.vendedorCommission : sorteoData.listeroCommission),
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
            movements = allMovementsForDate;
        } else {
            // Sin agrupación: filtrar por entidad
            const sorteoKey = filters.dimension === "banca"
                ? `${date}_${filters.bancaId || 'null'}`
                : filters.dimension === "ventana"
                    ? `${date}_${filters.ventanaId}`
                    : `${date}_${filters.vendedorId || 'null'}`;
            bySorteo = sorteoBreakdownBatch.get(sorteoKey) || [];

            // Filtrar movimientos por entidad
            movements = allMovementsForDate.filter((m: any) => {
                if (filters.dimension === "banca") {
                    return m.bancaId === filters.bancaId;
                } else if (filters.dimension === "ventana") {
                    return m.ventanaId === filters.ventanaId;
                } else {
                    return m.vendedorId === filters.vendedorId;
                }
            });
        }

        // Intercalar sorteos y movimientos
        // ✅ CRÍTICO: Para el primer día, usar previousMonthBalance como initialAccumulated
        // Para días siguientes, usar el acumulado del día anterior
        const { intercalateSorteosAndMovements } = await import('./accounts.intercalate');
        const initialAccumulated = isFirstDay ? previousMonthBalance : lastDayAccumulated;
        
        // ✅ LOGGING: Verificar que initialAccumulated tenga el valor correcto
        logger.info({
            layer: "service",
            action: "GET_BY_SORTEO_INTERCALATING",
            payload: {
                date,
                isFirstDay,
                dimension: filters.dimension,
                bancaId: filters.bancaId,
                ventanaId: filters.ventanaId,
                vendedorId: filters.vendedorId,
                previousMonthBalance: isFirstDay ? previousMonthBalance : undefined,
                lastDayAccumulated: !isFirstDay ? lastDayAccumulated : undefined,
                initialAccumulated,
                sorteosCount: bySorteo.length,
                movementsCount: movements.length,
                note: isFirstDay 
                    ? "Primer día del mes: usando previousMonthBalance como initialAccumulated"
                    : `Día siguiente: usando lastDayAccumulated (${lastDayAccumulated}) como initialAccumulated`,
            },
        });
        
        const sorteosAndMovements = intercalateSorteosAndMovements(bySorteo, movements, date, initialAccumulated);

        return sorteosAndMovements;
    },

    /**
     * Obtiene el balance acumulado actual de una ventana
     * Balance = ventas - premios - comisiones + comisiones propias - pagos realizados
     * Sin filtro de fecha (acumulado desde el inicio hasta HOY)
     */
    async getCurrentBalance(ventanaId: string) {
        const today = new Date();
        // Establecer rango desde el inicio del tiempo hasta hoy
        const startDate = new Date(Date.UTC(2020, 0, 1)); // Fecha arbitraria en el pasado
        const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));

        // Obtener información de la ventana
        const ventana = await prisma.ventana.findUnique({
            where: { id: ventanaId },
            select: { id: true, name: true },
        });

        if (!ventana) {
            throw new Error("Ventana no encontrada");
        }

        // Usar la misma lógica que getStatementDirect para calcular el balance
        // Calcular balance acumulado directamente desde tickets/jugadas
        const startDateCRStr = toCRDateString(startDate);
        const endDateCRStr = toCRDateString(endDate);

        // Construir query SQL para obtener totales acumulados
        // IMPORTANTE: Calcular sales y commissions desde jugadas (suma de todas)
        // Pero payouts debe ser la suma de totalPayout de tickets únicos (no duplicar por jugada)
        const salesAndCommissions = await prisma.$queryRaw<Array<{
            total_sales: number;
            listero_commission: number;
            vendedor_commission: number;
        }>>`
            SELECT
                COALESCE(SUM(j.amount), 0) as total_sales,
                COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission,
                COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as vendedor_commission
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            WHERE t."ventanaId" = ${ventanaId}::uuid
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t."status" != 'CANCELLED'
            AND EXISTS (
                SELECT 1 FROM "Sorteo" s
                WHERE s.id = t."sorteoId"
                AND s.status = 'EVALUATED'
            )
            AND j."deletedAt" IS NULL
            AND COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) <= ${endDateCRStr}::date
        `;

        // Calcular payouts desde tickets (no desde jugadas para evitar duplicar)
        const payoutsResult = await prisma.$queryRaw<Array<{
            total_payouts: number;
        }>>`
            SELECT
                COALESCE(SUM(t."totalPayout"), 0) as total_payouts
            FROM "Ticket" t
            WHERE t."ventanaId" = ${ventanaId}::uuid
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t."status" != 'CANCELLED'
            AND EXISTS (
                SELECT 1 FROM "Sorteo" s
                WHERE s.id = t."sorteoId"
                AND s.status = 'EVALUATED'
            )
            AND COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) <= ${endDateCRStr}::date
        `;

        const totalSales = Number(salesAndCommissions[0]?.total_sales || 0);
        const totalPayouts = Number(payoutsResult[0]?.total_payouts || 0);
        const listeroCommission = Number(salesAndCommissions[0]?.listero_commission || 0);

        // Balance = ventas - premios - comisión listero (dimensión ventana)
        const balance = totalSales - totalPayouts - listeroCommission;

        // Obtener pagos y cobros acumulados usando Prisma ORM (igual que AccountPaymentRepository)
        const payments = await prisma.accountPayment.findMany({
            where: {
                ventanaId: ventanaId,
                isReversed: false,
                date: {
                    lte: endDate,
                },
            },
            select: {
                type: true,
                amount: true,
            },
        });

        // Calcular totales
        const totalPaid = payments
            .filter(p => p.type === "payment")
            .reduce((sum, p) => sum + p.amount, 0);
        const totalCollected = payments
            .filter(p => p.type === "collection")
            .reduce((sum, p) => sum + p.amount, 0);

        // remainingBalance = balance - totalCollected + totalPaid
        const remainingBalance = balance - totalCollected + totalPaid;

        return {
            balance,
            remainingBalance,
            ventanaId: ventana.id,
            ventanaName: ventana.name,
            updatedAt: new Date().toISOString(),
        };
    },
};
