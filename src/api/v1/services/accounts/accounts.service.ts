import { AccountsFilters, DayStatement } from "./accounts.types";
import { resolveDateRange } from "../../../../utils/dateRange";
import { getMonthDateRange, toCRDateString } from "./accounts.dates.utils";
import { getMovementsForDay, getSorteoBreakdownBatch } from "./accounts.queries";
import { getStatementDirect, calculateDayStatement, getSettledStatements, getDatesNotSettled } from "./accounts.calculations";
import { registerPayment, reversePayment, deleteStatement } from "./accounts.movements";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import prisma from "../../../../core/prismaClient";
import { getCachedStatement, setCachedStatement } from "../../../../utils/accountStatementCache";
import { crDateService } from "../../../../utils/crDateService";
import logger from "../../../../core/logger";

/**
 * Accounts Service
 * Proporciona endpoints para consultar y gestionar estados de cuenta
 * Refactorizado para usar módulos especializados
 */
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
            // ✅ CRÍTICO: monthlyRemainingBalance debe ser igual a monthlyTotalBalance (que ya incluye movimientos)
            // En statements individuales: remainingBalance = balance (que ya incluye movimientos)
            const monthlyRemainingBalance = monthlyTotalBalance;

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
            // ✅ CRÍTICO: totalBalance debe incluir movimientos (igual que balance en statements individuales)
            // balance = balanceBase + totalPaid - totalCollected, donde balanceBase = totalSales - totalPayouts - commission
            const totalBalanceBase = totalSales - totalPayouts - totalCommissionToUse;
            const totalPaid = optimizedStatements.reduce((sum, s) => sum + s.totalPaid, 0);
            const totalCollected = optimizedStatements.reduce((sum, s) => sum + s.totalCollected, 0);
            const totalBalance = totalBalanceBase + totalPaid - totalCollected;
            // ✅ CRÍTICO: totalRemainingBalance = totalBalance (que ya incluye movimientos)
            // NO usar suma de remainingBalance porque esos valores son acumulados progresivamente
            const totalRemainingBalance = totalBalance;

            result = {
                statements: optimizedStatements,
                totals: {
                    totalSales: parseFloat(totalSales.toFixed(2)),
                    totalPayouts: parseFloat(totalPayouts.toFixed(2)),
                    totalListeroCommission: parseFloat(totalListeroCommission.toFixed(2)),
                    totalVendedorCommission: parseFloat(totalVendedorCommission.toFixed(2)),
                    totalBalance: parseFloat(totalBalance.toFixed(2)),
                    totalPaid: parseFloat(totalPaid.toFixed(2)),
                    totalCollected: parseFloat(totalCollected.toFixed(2)),
                    totalRemainingBalance: parseFloat(totalRemainingBalance.toFixed(2)),
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
     */
    async getBySorteo(
        date: string, // YYYY-MM-DD
        filters: {
            dimension: "banca" | "ventana" | "vendedor";
            ventanaId?: string;
            vendedorId?: string;
            bancaId?: string;
            userRole?: "ADMIN" | "VENTANA" | "VENDEDOR";
        }
    ) {
        // Convertir fecha string a Date
        const [year, month, day] = date.split('-').map(Number);
        const targetDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

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
        const { intercalateSorteosAndMovements } = await import('./accounts.intercalate');
        const sorteosAndMovements = intercalateSorteosAndMovements(bySorteo, movements, date);

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
