// src/domain/accounts/engine/statement.engine.ts

import { Prisma, Role, BetType } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { AccountStatementRepository } from "../../../repositories/accountStatement.repository";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { crDateService } from "../../../utils/crDateService";
import { getPreviousMonthFinalBalance } from "../accounts.balances";
import { getCachedBySorteo, setCachedBySorteo } from "../../../utils/accountStatementCache";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { getAggregatedTicketsData, getSorteoBreakdownBatch } from "../accounts.queries";
import { calculateIsSettled } from "../accounts.commissions";
import {
  ACCOUNT_PREVIOUS_MONTH_METHOD,
  ACCOUNT_CARRY_OVER_NOTES,
} from "../accounts.types";
import {
  StatementEngineParams,
  StatementResponse,
  DayStatement,
} from "./types/statement.types";
import { StatementQueryBuilder } from "./statement-query.builder";
import { StatementAccumulatorEngine } from "./statement-accumulator.engine";
import { StatementInterleavingFormatter } from "./statement-interleaving.formatter";
import { BancaStatementStrategy } from "./strategies/banca-statement.strategy";
import { VentanaStatementStrategy } from "./strategies/ventana-statement.strategy";
import { VendedorStatementStrategy } from "./strategies/vendedor-statement.strategy";
import { IDimensionStrategy } from "./strategies/dimension-strategy.interface";

export class StatementEngine {
  static async execute(params: StatementEngineParams): Promise<StatementResponse> {
    const {
      filters,
      startDate,
      endDate,
      daysInMonth,
      effectiveMonth,
      dimension,
      ventanaId,
      vendedorId,
      bancaId,
      userRole = Role.ADMIN,
      sort = "desc",
    } = params;

    const strategy: IDimensionStrategy =
      dimension === "banca"
        ? new BancaStatementStrategy()
        : dimension === "ventana"
          ? new VentanaStatementStrategy()
          : new VendedorStatementStrategy();

    // Verificar si existe fecha de corte balanceResetAt en settings del vendedor
    let balanceResetAtDayStr: string | null = null;
    if (vendedorId && !filters.ignoreReset) {
        const user = await prisma.user.findUnique({
            where: { id: vendedorId },
            select: { settings: true }
        });
        if (user?.settings && (user.settings as Record<string, any>).balanceResetAt) {
            const balanceResetAt = new Date((user.settings as Record<string, any>).balanceResetAt);
            balanceResetAtDayStr = crDateService.dateUTCToCRString(balanceResetAt);
        }
    }

    let effectiveStartDate = startDate;

    //  CORRECCIÓN: Usar servicio centralizado para conversión de fechas
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(effectiveStartDate, endDate);

    //  VALIDACIÓN DEFENSIVA: Asegurar que las fechas convertidas sean válidas
    if (!startDateCRStr || !endDateCRStr) {
        throw new Error("Error converting dates to CR timezone strings");
    }

    //  CRÍTICO: Validar que effectiveMonth sea un string válido
    if (!effectiveMonth || typeof effectiveMonth !== 'string' || !effectiveMonth.includes('-')) {
        throw new Error(`effectiveMonth debe ser un string en formato YYYY-MM, recibido: ${effectiveMonth}`);
    }

    //  CRÍTICO: Calcular inicio del mes para siempre consultar desde ahí
    // Esto permite calcular el acumulado correcto incluso cuando se filtra por un día específico
    //  DEFENSIÓN: Validar que effectiveMonth sea válido
    if (!effectiveMonth || !effectiveMonth.includes("-")) {
        throw new Error(`effectiveMonth inválido para split: ${effectiveMonth}`);
    }
    const [yearForMonth, monthForMonth] = effectiveMonth.split("-").map(Number);
    let monthStartDateForQuery = new Date(Date.UTC(yearForMonth, monthForMonth - 1, 1));
    

    
    const monthStartDateCRStrForQuery = crDateService.dateUTCToCRString(monthStartDateForQuery);
    // Helper: primer día del mes efectivo en formato YYYY-MM-DD
    const firstDayOfMonthStr = `${yearForMonth}-${String(monthForMonth).padStart(2, '0')}-01`;

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
        (dimension === "banca" && bancaId && !ventanaId && !vendedorId) || //  NUEVO: Agrupar cuando hay bancaId pero múltiples ventanas/vendedores
        (dimension === "ventana" && (!ventanaId || ventanaId === "" || ventanaId === null)) ||
        (dimension === "vendedor" && (!vendedorId || vendedorId === "" || vendedorId === null));

    //  RESOLVE ENTITY NAMES (Optimización para evitar nulls en días sin actividad)
    let resolvedBancaName: string | null = null;
    let resolvedBancaCode: string | null = null;
    let resolvedVentanaName: string | null = null;
    let resolvedVentanaCode: string | null = null;
    let resolvedVendedorName: string | null = null;
    let resolvedVendedorCode: string | null = null;

    const [b, v, ven] = await Promise.all([
        bancaId ? prisma.banca.findUnique({ where: { id: bancaId }, select: { name: true, code: true } }) : Promise.resolve(null),
        ventanaId ? prisma.user.findUnique({ where: { id: ventanaId }, select: { name: true, code: true } }) : Promise.resolve(null),
        vendedorId ? prisma.user.findUnique({ where: { id: vendedorId }, select: { name: true, code: true } }) : Promise.resolve(null)
    ]);

    if (b) { resolvedBancaName = b.name; resolvedBancaCode = b.code; }
    if (v) { resolvedVentanaName = v.name; resolvedVentanaCode = v.code as string | null; }
    if (ven) { resolvedVendedorName = ven.name; resolvedVendedorCode = ven.code as string | null; }

    //  DEBUG: Log para verificar agrupación y rendimiento
    const functionStartTime = Date.now();

    //  OPTIMIZACIÓN: Detectar si es "today" (solo un día y es hoy)
    // Para "today", NO cargar todo el mes, solo el día actual (reduce memoria 60-70%)
    const isTodayOnly = startDate.getTime() === endDate.getTime();
    const todayInCR = crDateService.postgresDateToCRString(new Date());
    const queryDateCR = startDateCRStr;
    const isToday = isTodayOnly && queryDateCR === todayInCR;

    //  PROPUESTA 4: Detectar si el período cruza meses (para optimización híbrida)
    // Dividir el período en dos: días del mes anterior + días del mes actual
    //  DEFENSIÓN: Los strings ya fueron validados en línea 650, pero asegurar que tengan el formato esperado
    const startDateParts = (startDateCRStr || "").split('-');
    const endDateParts = (endDateCRStr || "").split('-');

    if (startDateParts.length < 2 || endDateParts.length < 2) {
        // logger.error({
        //     layer: "service",
        //     action: "GET_STATEMENT_DIRECT_DATE_FORMAT_ERROR",
        //     payload: { startDateCRStr, endDateCRStr, dimension }
        // });
        throw new Error("Invalid date format from conversion service");
    }

    const startDateMonth = parseInt(startDateParts[1]);
    const endDateMonth = parseInt(endDateParts[1]);
    const startDateYear = parseInt(startDateParts[0]);
    const endDateYear = parseInt(endDateParts[0]);
    const crossesMonths = (startDateYear < endDateYear) ||
        (startDateYear === endDateYear && startDateMonth < endDateMonth);

    // Obtener mes anterior si cruza meses
    let previousMonthStr: string | null = null;
    if (crossesMonths) {
        const previousMonthDate = new Date(yearForMonth, monthForMonth - 2, 1);
        previousMonthStr = `${previousMonthDate.getUTCFullYear()}-${String(previousMonthDate.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    //  PROPUESTA 2: Verificar si podemos usar AccountStatement como caché
    // Solo si el período NO incluye hoy (para evitar problemas de invalidación)
    // y si todos los días del período tienen AccountStatement
    const periodIncludesToday = startDateCRStr <= todayInCR && endDateCRStr >= todayInCR;

    // Función helper para obtener rango de fechas entre startDate y endDate
    const getDateRangeArray = (start: string, end: string): string[] => {
        const dates: string[] = [];
        const startDate = new Date(start + 'T00:00:00.000Z');
        const endDate = new Date(end + 'T00:00:00.000Z');
        const currentDate = new Date(startDate);
        while (currentDate <= endDate) {
            dates.push(crDateService.dateUTCToCRString(currentDate));
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
        return dates;
    };

    // logger.info({
    //     layer: "service",
    //     action: "GET_STATEMENT_DIRECT_START",
    //     payload: {
    //         dimension,
    //         ventanaId: ventanaId || null,
    //         vendedorId: vendedorId || null,
    //         bancaId: bancaId || null,
    //         shouldGroupByDate,
    //         startDate: startDateCRStr,
    //         endDate: endDateCRStr,
    //         daysInRange: daysInMonth,
    //         isToday,
    //         crossesMonths,
    //         periodIncludesToday,
    //         optimized: isToday ? "yes" : "no",
    //     },
    // });

    //  PROPUESTA 2: Intentar usar AccountStatement como caché (si no incluye hoy)
    // Esto es MUY RÁPIDO pero requiere que todos los días tengan AccountStatement
    // ️ CUIDADO: Solo usar si el período NO incluye hoy (evita problemas de invalidación)
    // La invalidación se maneja automáticamente cuando se evalúan sorteos o se registran pagos
    // porque esos eventos actualizan AccountStatement directamente
    if (!periodIncludesToday && !isToday) {
        try {
            // Construir where clause para AccountStatement según dimensión
            const dateRange = getDateRangeArray(startDateCRStr, endDateCRStr);
            const accountStatementWhere: any = {
                date: {
                    gte: new Date(startDateCRStr + 'T00:00:00.000Z'),
                    lte: new Date(endDateCRStr + 'T23:59:59.999Z'),
                },
            };

            // Aplicar filtros según dimensión
            if (dimension === "banca" && bancaId) {
                accountStatementWhere.bancaId = bancaId;
                accountStatementWhere.ventanaId = null;
                accountStatementWhere.vendedorId = null;
            } else if (dimension === "ventana" && ventanaId) {
                accountStatementWhere.ventanaId = ventanaId;
                accountStatementWhere.vendedorId = null;
            } else if (dimension === "vendedor" && vendedorId) {
                accountStatementWhere.vendedorId = vendedorId;
            } else if (dimension === "banca" && !bancaId && shouldGroupByDate) {
                // Consolidado: todas las bancas (no filtrar por bancaId)
                accountStatementWhere.bancaId = { not: null };
                accountStatementWhere.ventanaId = null;
                accountStatementWhere.vendedorId = null;
            }

            // Buscar AccountStatement para todos los días del rango
            const accountStatements = await prisma.accountStatement.findMany({
                where: accountStatementWhere,
                orderBy: { date: 'asc' },
            });

            // Verificar si tenemos statements para TODOS los días del rango
            const statementsByDate = new Map<string, typeof accountStatements>();
            for (const stmt of accountStatements) {
                const dateStr = crDateService.postgresDateToCRString(stmt.date);
                if (!statementsByDate.has(dateStr)) {
                    statementsByDate.set(dateStr, []);
                }
                statementsByDate.get(dateStr)!.push(stmt);
            }

            const allDaysHaveStatements = dateRange.every(dateStr => statementsByDate.has(dateStr));

            if (allDaysHaveStatements && accountStatements.length > 0) {
                //  USAR AccountStatement directamente (MUY RÁPIDO)
                logger.info({
                    layer: "service",
                    action: "ACCOUNT_STATEMENT_CACHE_HIT",
                    payload: {
                        dimension,
                        startDate: startDateCRStr,
                        endDate: endDateCRStr,
                        statementsCount: accountStatements.length,
                        note: "Using AccountStatement as cache (all days have statements, period does not include today)",
                    },
                });

                // TODO: Formatear statements desde AccountStatement al formato esperado
                // Esto requiere convertir AccountStatement completo al formato de respuesta
                // Por ahora, continuamos con cálculo normal desde tickets
                // (PROPUESTA 2 completa requiere implementación adicional de formateo)
            }
        } catch (error) {
            logger.warn({
                layer: "service",
                action: "ACCOUNT_STATEMENT_CACHE_CHECK_ERROR",
                payload: {
                    dimension,
                    error: (error as Error).message,
                    note: "Falling back to calculation from tickets",
                },
            });
            // Continuar con cálculo normal desde tickets
        }
    }

    //  OPTIMIZACIÓN: Usar agregaciones SQL directamente en lugar de traer todas las jugadas
    const queryStartTime = Date.now();

    const aggregatedData = await getAggregatedTicketsData({
        startDate,
        endDate,
        dimension,
        bancaId,
        ventanaId,
        vendedorId,
        daysInMonth,
        shouldGroupByDate,
        sort,
        isToday,
        monthStartDateForQuery: monthStartDateCRStrForQuery
    });

    const queryEndTime = Date.now();
    // logger.info({
    //     layer: "service",
    //     action: "ACCOUNT_STATEMENT_SQL_QUERY_END",
    //     payload: {
    //         dimension,
    //         bancaId,
    //         ventanaId,
    //         vendedorId,
    //         rowsReturned: aggregatedData.length,
    //         queryTimeMs: queryEndTime - queryStartTime,
    //     },
    // });

    //  CRÍTICO: Agrupar jugadas por día y banca/ventana/vendedor, calculando comisiones jugada por jugada
    // EXACTAMENTE igual que commissions (líneas 403-492)
    //  NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha (sin separar por entidad)
    const byDateAndDimension = new Map<
        string,
        {
            bancaId: string | null; //  NUEVO: ID de banca
            bancaName: string | null; //  NUEVO: Nombre de banca
            bancaCode: string | null; //  NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; //  NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; //  NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTicketsCount: number; //  OPTIMIZACIÓN: Contador en lugar de Set (reduce memoria 20-30%)
            commissionListero: number;
            commissionVendedor: number;
            payoutTicketsCount: number; //  OPTIMIZACIÓN: Contador en lugar de Set
        }
    >();

    //  NUEVO: Mapa para desglose por entidad (byBanca/byVentana/byVendedor) cuando hay agrupación
    const breakdownByEntity = new Map<
        string, // `${dateKey}_${entityId}` o `${dateKey}_${bancaId}` o `${dateKey}_${ventanaId}` o `${dateKey}_${vendedorId}`
        {
            bancaId: string | null; //  NUEVO: ID de banca
            bancaName: string | null; //  NUEVO: Nombre de banca
            bancaCode: string | null; //  NUEVO: Código de banca
            ventanaId: string | null;
            ventanaName: string | null;
            ventanaCode: string | null; //  NUEVO: Código de ventana
            vendedorId: string | null;
            vendedorName: string | null;
            vendedorCode: string | null; //  NUEVO: Código de vendedor
            totalSales: number;
            totalPayouts: number;
            totalTicketsCount: number; //  OPTIMIZACIÓN: Contador en lugar de Set (reduce memoria 20-30%)
            commissionListero: number;
            commissionVendedor: number;
            payoutTicketsCount: number; //  OPTIMIZACIÓN: Contador en lugar de Set
        }
    >();

    //  OPTIMIZACIÓN: Procesar datos agregados en lugar de jugadas individuales
    for (const row of aggregatedData) {
        const dateKey = crDateService.postgresDateToCRString(row.business_date);

        //  NOTA: NO filtrar aquí - necesitamos todos los días del mes para calcular acumulados correctos
        // El filtro se aplicará al final después de calcular la acumulación

        //  NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
        //  CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar ese ID directamente
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
                totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
            };
            byDateAndDimension.set(groupKey, entry);
        }

        //  NUEVO: Mantener desglose por entidad cuando hay agrupación
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
                    totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                };
                breakdownByEntity.set(breakdownKey, breakdownEntry);
            }

            // Actualizar desglose por entidad (ya agregado desde SQL)
            if (breakdownEntry) {
                breakdownEntry.totalSales += Number(row.total_sales || 0);
                //  NOTA: totalPayouts se calcula desde bySorteo, NO desde SQL
                breakdownEntry.commissionListero += Number(row.commission_listero || 0);
                breakdownEntry.commissionVendedor += Number(row.commission_vendedor || 0);
                //  OPTIMIZACIÓN: Usar contador directo en lugar de Set sintético (reduce memoria)
                const ticketCount = Number(row.total_tickets || 0);
                breakdownEntry.totalTicketsCount = ticketCount;
            }
        }

        // Actualizar entrada principal (agrupada) - ya agregado desde SQL
        entry.totalSales += Number(row.total_sales || 0);
        entry.totalPayouts += Number(row.total_payouts || 0);
        entry.commissionListero += Number(row.commission_listero || 0);
        entry.commissionVendedor += Number(row.commission_vendedor || 0);
        //  OPTIMIZACIÓN: Usar contador directo en lugar de Set sintético (reduce memoria)
        //  CRÍTICO: Acumular ticketCount en lugar de asignarlo directamente
        // Cuando hay múltiples filas SQL para el mismo día (por ejemplo, vendedor en diferentes ventanas),
        // necesitamos acumular el conteo, no sobrescribirlo
        entry.totalTicketsCount += Number(row.total_tickets || 0);
    }

    //  CRÍTICO: Obtener movimientos desde el inicio del mes para calcular acumulados correctos
    const movementsByDate = await AccountPaymentRepository.findMovementsByDateRange(
        monthStartDateForQuery,
        endDate,
        dimension,
        ventanaId,
        vendedorId,
        bancaId,
        dimension === "banca" // includeChildren: true para banca para ver movimientos de listeros
    );

    //  NUEVO: Obtener saldos del mes anterior para agregarlos como movimiento especial al primer día
    // Esto permite que el saldo se intercale naturalmente con los sorteos, igual que los pagos/cobros
    // Determinar el primer día del mes objetivo para inyectar el saldo de apertura
    // Si el rango cruza de mes, el saldo de apertura debe ir en el 01 del mes nuevo dentro del rango
    const [endY, endM] = endDateCRStr.split('-').map(Number);
    const firstDayOfOpeningMonthStr = `${endY}-${String(endM).padStart(2, '0')}-01`;
    const previousMonthBalancesByEntity = new Map<string, number>();

    //  OPTIMIZACIÓN: Cache para saldos del mes anterior cuando el rango cruza meses/años
    // Clave: `${monthStr}_${dimension}_${entityId}`
    const previousMonthBalanceCache = new Map<string, number>();

    //  CRÍTICO: Obtener saldo del mes anterior ANTES de procesar statements
    // Esto asegura que el movimiento especial esté disponible incluso si no hay ventas el primer día
    let previousMonthBalanceForMovement: number = 0;
    // Calcular el string del mes objetivo (fin del rango)
    const targetMonthStr = `${endY}-${String(endM).padStart(2, '0')}`;
    // Calcular el mes anterior al mes objetivo
    const prevMonthDateForTarget = new Date(Date.UTC(endY, endM - 1, 1));
    prevMonthDateForTarget.setUTCMonth(prevMonthDateForTarget.getUTCMonth() - 1);
    const previousMonthStrForTarget = `${prevMonthDateForTarget.getUTCFullYear()}-${String(prevMonthDateForTarget.getUTCMonth() + 1).padStart(2, '0')}`;

    if (dimension === "banca") {
        if (bancaId) {
            previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
                targetMonthStr,
                "banca",
                undefined,
                undefined,
                bancaId
            );
        } else {
            // SCOPE=ALL (todas las bancas): sumar todos los cierres del mes anterior al mes objetivo
            const closings = await prisma.monthlyClosingBalance.findMany({
                where: { closingMonth: previousMonthStrForTarget, dimension: "banca" },
                select: { closingBalance: true },
            });
            previousMonthBalanceForMovement = closings.reduce((sum, c) => sum + Number((c as any).closingBalance || 0), 0);
        }
    } else if (dimension === "ventana") {
        previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
            targetMonthStr,
            "ventana",
            ventanaId || null,
            undefined,
            bancaId
        );
    } else {
        previousMonthBalanceForMovement = await getPreviousMonthFinalBalance(
            targetMonthStr,
            "vendedor",
            undefined,
            vendedorId || null,
            bancaId
        );
    }

    // Saldo del mes anterior se usará directamente en initialAccumulated
    // sin crear un movimiento virtual que ensucie la lista.

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

    //  NUEVO: Incorporar días que solo tienen movimientos (sin ventas)
    //  NOTA: NO filtrar aquí - necesitamos todos los movimientos del mes para calcular acumulados correctos
    //  CRÍTICO: Asegurar que el primer día tenga una entrada en byDateAndDimension si hay movimiento especial
    //  CORRECCIÓN: Usar la misma clave groupKey que se usa para los tickets para evitar duplicación
    {
        // Clave del día de apertura (normalmente el 01 del mes, o el reset day)
        const openingDayStr = (balanceResetAtDayStr && balanceResetAtDayStr > firstDayOfOpeningMonthStr)
            ? balanceResetAtDayStr
            : firstDayOfOpeningMonthStr;

        // Calcular la misma clave que se usaría para tickets en ese día (primer día del mes objetivo)
        const firstDayGroupKey = shouldGroupByDate
            ? openingDayStr // Solo fecha cuando hay agrupación
            : (dimension === "banca"
                ? `${openingDayStr}_${bancaId || 'null'}`
                : dimension === "ventana"
                    ? `${openingDayStr}_${ventanaId || 'null'}`
                    : `${openingDayStr}_${vendedorId || 'null'}`);

        if (!byDateAndDimension.has(firstDayGroupKey)) {
            // Crear entrada vacía para el primer día si no existe (para que el movimiento especial se muestre)
            byDateAndDimension.set(firstDayGroupKey, {
                bancaId: dimension === "banca" ? (bancaId || null) : null,
                bancaName: resolvedBancaName || null,
                bancaCode: resolvedBancaCode || null,
                ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
                ventanaName: resolvedVentanaName || null,
                ventanaCode: resolvedVentanaCode || null,
                vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
                vendedorName: resolvedVendedorName || null,
                vendedorCode: resolvedVendedorCode || null,
                totalSales: 0,
                totalPayouts: 0,
                totalTicketsCount: 0,
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTicketsCount: 0,
            });
        }
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

            //  NUEVO: Si shouldGroupByDate=true, agrupar solo por fecha; si no, por fecha + entidad
            //  CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar ese ID directamente
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
                    totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                });
            }
        }
    }

    // Eliminar entradas del mapa antes de la fecha de corte (si aplica)
    if (balanceResetAtDayStr) {
        for (const key of byDateAndDimension.keys()) {
            const dateStr = shouldGroupByDate ? key : key.split("_")[0];
            if (dateStr < balanceResetAtDayStr) {
                byDateAndDimension.delete(key);
            }
        }
    }

    // Obtener desglose por sorteo
    //  CRÍTICO: Si shouldGroupByDate=true, las claves son solo fechas; si no, son fecha_entidad
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
    //  NOTA: NO filtrar aquí - necesitamos todos los días del mes para calcular acumulados correctos
    // El filtro se aplicará al final después de calcular la acumulación
    //  CRÍTICO: Procesar días en orden SECUENCIAL (no paralelo) para arrastrar acumulados correctamente
    // El acumulado progresivo requiere que cada día se procese después del anterior
    // Mantener un mapa del último accumulated por entidad para cada día
    const lastAccumulatedByEntity = new Map<string, number>(); // Clave: `${date}_${entityId}`, Valor: último accumulated
    const runningAccumulatedByEntity = new Map<string, number>(); //  NUEVO: Clave: `${entityId}`, Valor: último accumulated (para carry-over robusto)

    // Ordenar entradas por fecha ASC para procesar en orden cronológico
    const sortedEntries = Array.from(byDateAndDimension.entries()).sort(([keyA], [keyB]) => {
        const dateA = shouldGroupByDate ? keyA : keyA.split("_")[0];
        const dateB = shouldGroupByDate ? keyB : keyB.split("_")[0];
        return dateA.localeCompare(dateB); // ASC
    });

    //  CRÍTICO: Crear entradas para días que no tienen tickets pero están entre días con tickets
    // SOLO cuando se consulta un rango completo (no para "today" o "este mes")
    // Esto asegura que días sin ventas (como el 25 en diciembre) se procesen y guarden
    // Pero NO ralentiza consultas de "today" o "este mes"
    const isFullMonthQuery = startDateCRStr === firstDayOfMonthStr && endDateCRStr >= `${yearForMonth}-${String(monthForMonth).padStart(2, '0')}-${new Date(yearForMonth, monthForMonth, 0).getDate()}`;

    //  CRÍTICO: SIEMPRE crear entradas para días faltantes para mantener secuencia progresiva
    // Esto asegura que el acumulado del día N+1 pueda encontrar el del día N
    // Sin días intermedios, el acumulado progresivo se rompe
    if (sortedEntries.length > 1) {
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
                            bancaName: resolvedBancaName || null,
                            bancaCode: resolvedBancaCode || null,
                            ventanaId: dimension === "ventana" ? (ventanaId || null) : null,
                            ventanaName: resolvedVentanaName || null,
                            ventanaCode: resolvedVentanaCode || null,
                            vendedorId: dimension === "vendedor" ? (vendedorId || null) : null,
                            vendedorName: resolvedVendedorName || null,
                            vendedorCode: resolvedVendedorCode || null,
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

    //  OPTIMIZACIÓN CRÍTICA: Pre-cargar TODOS los AccountStatement necesarios en una sola consulta
    // Esto evita hacer consultas secuenciales dentro del loop (causa principal de lentitud)
    const allDatesInRange = Array.from(new Set(sortedEntriesFinal.map(([key]) => {
        const date = shouldGroupByDate ? key : key.split("_")[0];
        return date;
    }))).sort();

    //  DEFENSIÓN: Si no hay fechas en el rango, no podemos calcular el primer/último día
    if (allDatesInRange.length === 0) {
        // Retornar respuesta vacía o con datos básicos si no hay nada que procesar
        return {
            statements: [],
            totals: {
                totalSales: 0,
                totalPayouts: 0,
                totalListeroCommission: 0,
                totalVendedorCommission: 0,
                totalBalance: 0,
                totalPaid: 0,
                totalCollected: 0,
                totalRemainingBalance: 0,
                settledDays: 0,
                pendingDays: 0,
            },
            monthlyAccumulated: {
                totalSales: 0,
                totalPayouts: 0,
                totalBalance: 0,
                totalPaid: 0,
                totalCollected: 0,
                totalRemainingBalance: 0,
                settledDays: 0,
                pendingDays: 0,
            },
            meta: {
                month: effectiveMonth,
                startDate: startDateCRStr,
                endDate: endDateCRStr,
                dimension,
                totalDays: daysInMonth,
                monthStartDate: crDateService.dateUTCToCRString(new Date(Date.UTC(yearForMonth, monthForMonth - 1, 1))),
                monthEndDate: crDateService.dateUTCToCRString(new Date(Date.UTC(yearForMonth, monthForMonth, 0))),
            },
        };
    }

    const firstDateStr = allDatesInRange[0];
    const [firstYear, firstMonth, firstDay] = firstDateStr.split('-').map(Number);
    const firstDate = new Date(Date.UTC(firstYear, firstMonth - 1, firstDay));
    const previousDayOfFirst = new Date(firstDate);
    previousDayOfFirst.setUTCDate(previousDayOfFirst.getUTCDate() - 1);

    const lastDateStr = allDatesInRange[allDatesInRange.length - 1];
    const [lastYear, lastMonth, lastDay] = lastDateStr.split('-').map(Number);
    const lastDate = new Date(Date.UTC(lastYear, lastMonth - 1, lastDay));

    // Pre-cargar todos los AccountStatement del rango (incluyendo día anterior del primero)
    const preloadedStatementsMap = new Map<string, Map<string, any>>(); // fecha -> Map<bancaId|ventanaId|vendedorId, statement>

    if (shouldGroupByDate && dimension === "banca" && !bancaId) {
        // Pre-cargar todos los statements de bancas del rango (para consolidado)
        const preloadedStatements = await prisma.accountStatement.findMany({
            where: {
                date: {
                    gte: previousDayOfFirst,
                    lte: lastDate,
                },
                bancaId: { not: null },
                ventanaId: null,
                vendedorId: null,
            },
            select: {
                date: true,
                bancaId: true,
                remainingBalance: true, //  Usar remainingBalance (más confiable)
                accumulatedBalance: true, // Fallback si remainingBalance es null
            },
        });

        // Agrupar por fecha y sumar remainingBalance (más confiable) o accumulatedBalance
        for (const stmt of preloadedStatements) {
            const balanceToUse = stmt.remainingBalance !== null ? stmt.remainingBalance : stmt.accumulatedBalance;
            if (balanceToUse !== null) {
                const dateStr = crDateService.postgresDateToCRString(stmt.date);
                if (!preloadedStatementsMap.has(dateStr)) {
                    preloadedStatementsMap.set(dateStr, new Map());
                }
                const dateMap = preloadedStatementsMap.get(dateStr)!;
                // Para consolidado, sumar todos los remainingBalance (o accumulatedBalance si no hay remainingBalance)
                const existing = dateMap.get('_consolidado') || 0;
                const existingValue = typeof existing === 'number' ? existing : (existing?.remainingBalance || existing?.accumulatedBalance || 0);
                // Para consolidado, guardamos solo el número (suma), no ID
                dateMap.set('_consolidado', existingValue + Number(balanceToUse));
            }
        }
    } else {
        // Pre-cargar statements específicos según dimensión
        const whereClause: any = {
            date: {
                gte: previousDayOfFirst,
                lte: lastDate,
            },
        };

        if (dimension === "vendedor") {
            if (vendedorId) {
                whereClause.vendedorId = vendedorId;
            } else {
                whereClause.vendedorId = { not: null };
            }
        } else if (dimension === "ventana") {
            //  CORRECCIÓN CRÍTICA: Cuando se filtra por ventana, 
            // solo buscar statements consolidados de ventana (vendedorId = null)
            if (ventanaId) {
                whereClause.ventanaId = ventanaId;
            } else {
                whereClause.ventanaId = { not: null };
            }
            whereClause.vendedorId = null;
        } else if (dimension === "banca") {
            if (bancaId) {
                whereClause.bancaId = bancaId;
            } else {
                whereClause.bancaId = { not: null };
            }
            whereClause.ventanaId = null;
            whereClause.vendedorId = null;
        }

        const preloadedStatements = await prisma.accountStatement.findMany({
            where: whereClause,
            select: {
                id: true, //  NUEVO: Necesitamos el ID para corrección automática
                date: true,
                bancaId: true,
                ventanaId: true,
                vendedorId: true,
                accumulatedBalance: true,
                remainingBalance: true, //  NUEVO: También cargar remainingBalance
                updatedAt: true, //  CRÍTICO: Necesario para usar el statement más reciente
            },
            orderBy: {
                updatedAt: 'desc', //  CRÍTICO: Ordenar por updatedAt DESC para procesar el más reciente primero
            },
        });

        //  CRÍTICO: Agrupar statements por entityKey y fecha, usando solo el más reciente (por updatedAt)
        // Esto evita que statements viejos sobrescriban los nuevos cuando hay múltiples statements para la misma entidad
        const statementsByEntityKey = new Map<string, { balance: number; updatedAt: Date }>();

        for (const stmt of preloadedStatements) {
            if (stmt.remainingBalance !== null || stmt.accumulatedBalance !== null) {
                const dateStr = crDateService.postgresDateToCRString(stmt.date);
                //  CRÍTICO: Construir entityKey según dimensión, pero asegurando que solo se guarde el statement correcto
                // Cuando dimension="banca" con bancaId, SOLO guardar statements consolidados (ventanaId=null, vendedorId=null)
                // NO guardar statements de ventanas/vendedores aunque tengan el mismo bancaId
                let entityKey: string;
                if (dimension === "banca") {
                    //  CRÍTICO: Solo guardar statements consolidados de banca (ventanaId=null, vendedorId=null)
                    // Si el statement tiene ventanaId o vendedorId, NO guardarlo (es de una ventana/vendedor, no de la banca consolidada)
                    if (stmt.ventanaId || stmt.vendedorId) {
                        continue; // Saltar statements de ventanas/vendedores
                    }
                    entityKey = stmt.bancaId || 'null';
                } else if (dimension === "ventana") {
                    //  CRÍTICO: Solo guardar statements consolidados de ventana (vendedorId=null)
                    if (stmt.vendedorId) {
                        continue; // Saltar statements de vendedores
                    }
                    entityKey = stmt.ventanaId || 'null';
                } else if (dimension === "vendedor") {
                    //  CRÍTICO: Solo guardar statements de vendedores específicos
                    // NO guardar statements consolidados de ventana o banca
                    if (!stmt.vendedorId) {
                        continue; // Saltar statements consolidados (ventana/banca)
                    }
                    entityKey = stmt.vendedorId || 'null';
                } else {
                    entityKey = stmt.vendedorId || 'null';
                }

                //  CRÍTICO: Guardar directamente el remainingBalance (o accumulatedBalance como fallback)
                // para mantener compatibilidad con código que espera un número
                const balanceToUse = stmt.remainingBalance !== null ? stmt.remainingBalance : stmt.accumulatedBalance;
                if (balanceToUse !== null) {
                    //  CRÍTICO: Si ya existe un statement para este entityKey y fecha, solo sobrescribir si este es más reciente
                    const uniqueKey = `${dateStr}_${entityKey}`;
                    const existing = statementsByEntityKey.get(uniqueKey);
                    if (!existing || stmt.updatedAt > existing.updatedAt) {
                        statementsByEntityKey.set(uniqueKey, { balance: balanceToUse, updatedAt: stmt.updatedAt });
                    }
                    // Si el statement existente es más reciente, no sobrescribir (mantener el valor correcto)
                }
            }
        }

        //  CRÍTICO: Ahora poblar el preloadedStatementsMap con solo los statements más recientes
        for (const [uniqueKey, stmtInfo] of statementsByEntityKey.entries()) {
            const [dateStr, entityKey] = uniqueKey.split('_', 2);
            if (!preloadedStatementsMap.has(dateStr)) {
                preloadedStatementsMap.set(dateStr, new Map());
            }
            const dateMap = preloadedStatementsMap.get(dateStr)!;
            dateMap.set(entityKey, stmtInfo.balance);
        }
    }

    //  CRÍTICO: Procesar en orden SECUENCIAL, no en paralelo
    // Esto asegura que el acumulado del día anterior esté disponible cuando se procesa el día actual
    const allStatementsFromMonth: any[] = [];

    for (const [key, entry] of sortedEntriesFinal) {
            //  NUEVO: Determinar ID de entidad de forma consistente para esta entrada
            const entityId = dimension === "banca" && bancaId
                ? (bancaId || entry.bancaId || 'null')
                : dimension === "ventana" && (ventanaId || entry.ventanaId)
                    ? (ventanaId || entry.ventanaId || 'null')
                    : (vendedorId || entry.vendedorId || 'null');

            const isMarcela = (entityId === 'c127ba4b-fefc-47d2-a67b-7cce92319621');

            //  NUEVO: Si shouldGroupByDate=true, la clave es solo la fecha; si no, es fecha_entidad
            const date = shouldGroupByDate ? key : key.split("_")[0];


            //  NUEVO: Obtener movimientos y desglose por sorteo según si hay agrupación
            // El movimiento especial "Saldo del mes anterior" ya está en movementsByDate para el primer día
            const allMovementsForDate = movementsByDate.get(date) || [];
            const movementsWithPreviousBalance = [...allMovementsForDate];


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
            //  CRÍTICO: Inicializar movements ANTES de cualquier uso (necesario tanto si hay caché como si no)
            // Usar movementsWithPreviousBalance que incluye el saldo del mes anterior como movimiento especial
            if (shouldGroupByDate) {
                movements = movementsWithPreviousBalance;
            } else {
                // Sin agrupación: filtrar por entidad
                //  CRÍTICO: Cuando hay un ID específico en el filtro (bancaId, ventanaId, vendedorId),
                // findMovementsByDateRange ya filtra correctamente en la BD, pero puede haber múltiples entidades
                // en byDateAndDimension. Necesitamos filtrar por la entidad específica de esta entrada.
                // PRIORIDAD: Usar el ID del filtro directamente cuando está presente (más confiable que entry.ventanaId)
                //  CRÍTICO: Usar movementsWithPreviousBalance (no allMovementsForDate) para incluir el movimiento especial
                movements = movementsWithPreviousBalance.filter((m: any) => {
                    //  CRÍTICO: El movimiento especial "Saldo del mes anterior" debe incluirse siempre si corresponde a esta entidad
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
                        //  CRÍTICO: Usar bancaId del filtro si está presente (más confiable)
                        // Si no hay filtro, usar entry.bancaId (puede ser null si hay múltiples bancas)
                        const targetBancaId = bancaId || entry.bancaId;
                        return targetBancaId ? m.bancaId === targetBancaId : true; // Si no hay target, incluir todos
                    } else if (dimension === "ventana") {
                        //  CRÍTICO: Usar ventanaId del filtro si está presente (más confiable)
                        // Esto asegura que cuando se filtra por ventanaId específico, se incluyan todos los movimientos de esa ventana
                        // findMovementsByDateRange ya filtra por ventanaId cuando dimension='ventana' y hay ventanaId,
                        // pero este filtro adicional asegura que solo se incluyan movimientos de la entidad correcta
                        const targetVentanaId = ventanaId || entry.ventanaId;
                        return targetVentanaId ? m.ventanaId === targetVentanaId : true; // Si no hay target, incluir todos
                    } else {
                        //  CRÍTICO: Usar vendedorId del filtro si está presente (más confiable)
                        const targetVendedorId = vendedorId || entry.vendedorId;
                        return targetVendedorId ? m.vendedorId === targetVendedorId : true; // Si no hay target, incluir todos
                    }
                });
            }

            //  OPTIMIZACIÓN: Intentar obtener bySorteo del caché primero (TTL 1 hora)
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

                    //  NUEVO: Agrupar bySorteo por fecha solamente (sumar todos los sorteos de todas las entidades)
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
                                        //  CORRECCIÓN: Balance usando vendedorCommission si dimension='vendedor' o vendedorId está presente
                                        const commissionToUse = (dimension === "vendedor" || vendedorId) ? existing.vendedorCommission : existing.listeroCommission;
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
                                            //  CORRECCIÓN: Balance usando vendedorCommission si dimension='vendedor' o vendedorId está presente
                                            balance: sorteoData.sales - sorteoData.payouts - ((dimension === "vendedor" || vendedorId) ? sorteoData.vendedorCommission : sorteoData.listeroCommission),
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

                    //  NOTA: sorteoAccumulated se calculará después en intercalateSorteosAndMovements
                    // para incluir movimientos en el acumulado progresivo
                } else {
                    // movements ya está inicializado arriba (línea ~1012)
                    // Obtener desglose por sorteo usando clave según dimensión
                    //  CRÍTICO: Cuando hay un ID específico en el query (bancaId, ventanaId, vendedorId), usar directamente ese ID
                    // Esto asegura que se use la misma clave que en getSorteoBreakdownBatch
                    const sorteoKey = dimension === "banca"
                        ? `${date}_${bancaId || entry.bancaId || 'null'}`
                        : dimension === "ventana"
                            ? `${date}_${ventanaId || entry.ventanaId}`
                            : `${date}_${vendedorId || entry.vendedorId || 'null'}`;
                    bySorteo = sorteoBreakdownBatch.get(sorteoKey) || [];

                    //  NOTA: sorteoAccumulated se calculará después en intercalateSorteosAndMovements
                    // para incluir movimientos en el acumulado progresivo
                }

                // Guardar en caché en background (no esperar) si hay datos
                if (bySorteo.length > 0) {
                    setCachedBySorteo(bySorteoCacheKey, bySorteo).catch(() => {
                        // Ignorar errores de caché
                    });
                }
            }

            //  CRÍTICO: Calcular totalPayouts sumando desde bySorteo en lugar de la query SQL
            // Esto evita la multiplicación por número de jugadas que ocurría en el JOIN
            const totalPayouts = bySorteo.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

            //  CRÍTICO: Usar comisión correcta según dimensión
            // - Si dimension='vendedor' → usar commissionVendedor
            // - Si dimension='banca' o 'ventana' → usar commissionListero (siempre)
            const commissionToUse = dimension === "vendedor" ? entry.commissionVendedor : entry.commissionListero;

            // Calcular totales de pagos y cobros del DÍA (para el statement diario)
            //  CRÍTICO: Excluir el movimiento especial "Saldo del mes anterior" de los totales del día
            // Solo debe afectar el acumulado, no los totales de pagos/cobros del día
            //  CORRECCIÓN CRÍTICA: Para ventanas, solo contar movimientos propios (vendedorId = null), NO de vendedores
            // Para vendedores, solo contar movimientos del vendedor específico
            //  CRÍTICO: Balance del día = ventas - premios - comisiones + movimientos
            // Los movimientos (pagos/cobros) deben participar en el balance diario
            // payment = positivo (aumenta balance), collection = negativo (disminuye balance)
            //  CRÍTICO: Extraer el saldo del mes anterior del movimiento especial (si existe)
            // Este valor participa en el balance del día pero NO en totalPaid/totalCollected
            const previousMonthBalanceMovement = movements.find((m: any) => m.id?.startsWith('previous-month-balance-'));
            const previousMonthBalanceAmount = previousMonthBalanceMovement ? Number(previousMonthBalanceMovement.amount || 0) : 0;

            const filteredMovements = movements.filter((m: any) => {
                // Excluir movimientos revertidos
                if (m.isReversed) return false;

                //  CRÍTICO: Excluir explícitamente el saldo del mes anterior (arrastre)
                // Puede venir por ID especial, por método o por notas
                if (m.id?.startsWith('previous-month-balance-')) return false;
                if (m.method === ACCOUNT_PREVIOUS_MONTH_METHOD) return false;
                if (m.notes?.includes(ACCOUNT_CARRY_OVER_NOTES)) return false;

                //  CRÍTICO: Para ventanas, solo incluir movimientos consolidados (vendedorId = null)
                // NO incluir movimientos de vendedores específicos
                if (dimension === "ventana" && ventanaId) {
                    return m.vendedorId === null || m.vendedorId === undefined;
                }

                // Para vendedores, solo incluir movimientos del vendedor específico
                if (dimension === "vendedor" && vendedorId) {
                    return m.vendedorId === vendedorId;
                }

                // Para otros casos, incluir todos
                return true;
            });

            const totalPaid = Number(filteredMovements
                .filter((m: any) => m.type === "payment")
                .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0));
            const totalCollected = Number(filteredMovements
                .filter((m: any) => m.type === "collection")
                .reduce((sum: number, m: any) => sum + Number(m.amount || 0), 0));

            //  CRÍTICO: Balance del día = ventas - premios - comisiones + movimientos operativos
            // El saldo del mes anterior (si existe) participa en el balance para el ACUMULADO progresivo
            // pero NO debe sumarse al campo 'balance' de un día operativo, para evitar inflarlo
            // payment = positivo (aumenta balance), collection = negativo (disminuye balance)
            const balance = entry.totalSales - totalPayouts - commissionToUse + totalPaid - totalCollected;

            //  CRÍTICO: remainingBalance debe ser ACUMULADO REAL hasta esta fecha
            // NO debe depender del filtro de periodo aplicado
            // Se calculará más adelante usando monthlyByDateAndDimension (línea ~1420)
            const remainingBalance = 0; // Temporal, se calcula después

            //  NUEVO: Intercalar sorteos y movimientos en una lista unificada
            // El saldo del mes anterior ya está incluido como movimiento especial en movements
            //  CRÍTICO: Obtener el acumulado del día anterior para arrastrar el acumulado progresivo
            // Para el primer día del mes, incluir el saldo del mes anterior
            // Para días siguientes, usar el último accumulated del día anterior de la misma entidad
            let initialAccumulated = 0;

            //  CORREGIDO: Calcular clave de entidad de forma consistente
            // Cuando dimension="banca" sin bancaId específico, agrupar por fecha (no por bancaId)
            // Esto asegura que el acumulado progresivo funcione correctamente cuando hay múltiples statements por día
            //  CRÍTICO: Construir entityKey considerando que cuando dimension="banca" con bancaId específico,
            // aunque shouldGroupByDate=true, debemos incluir el bancaId para distinguir entre diferentes bancas
            // Esto evita que múltiples entries (una por ventana) se sobrescriban entre sí
            const entityKey = shouldGroupByDate && dimension === "banca" && bancaId
                ? `${date}_${bancaId}` //  CRÍTICO: Incluir bancaId aunque shouldGroupByDate=true
                : shouldGroupByDate
                    ? date // Si hay agrupación sin bancaId específico, usar solo la fecha
                    : dimension === "banca" && !bancaId
                        ? date //  CORREGIDO: Si dimension=banca sin bancaId, agrupar por fecha
                        : dimension === "banca"
                            ? `${date}_${bancaId || entry.bancaId || 'null'}`
                            : dimension === "ventana"
                                ? `${date}_${ventanaId || entry.ventanaId || 'null'}`
                                : `${date}_${vendedorId || entry.vendedorId || 'null'}`;

            //  CRÍTICO: Detectar si es el primer día del mes del día actual (no solo del mes de inicio del rango)
            // Esto es importante cuando el rango cruza meses (ej: semana del 29/12 al 04/01)
            const [currentYear, currentMonth, currentDay] = date.split('-').map(Number);
            const isFirstDayOfCurrentMonth = currentDay === 1;
            const currentMonthStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

            //  CRÍTICO: Si es el primer día del mes actual, usar el saldo del mes anterior correspondiente
            if (isFirstDayOfCurrentMonth) {
                // Obtener el saldo del mes anterior para el mes del día actual

                let entityIdForPreviousMonth: string;
                if (dimension === "banca") {
                    entityIdForPreviousMonth = entry.bancaId || bancaId || 'null';
                } else if (dimension === "ventana") {
                    entityIdForPreviousMonth = entry.ventanaId || ventanaId || 'null';
                } else {
                    entityIdForPreviousMonth = entry.vendedorId || vendedorId || 'null';
                }

                //  CRÍTICO: Obtener saldo del mes anterior para el mes del día actual
                let previousMonthBalance: number;

                // Primero intentar usar el saldo pre-calculado si estamos en el mes de inicio del rango
                if (currentMonthStr === effectiveMonth && date === firstDayOfMonthStr) {
                    const cachedBalance = previousMonthBalancesByEntity.get(entityIdForPreviousMonth);
                    previousMonthBalance = (cachedBalance !== undefined && cachedBalance !== 0)
                        ? cachedBalance
                        : previousMonthBalanceForMovement;
                } else {
                    // Para otros meses (cuando el rango cruza meses), calcular dinámicamente con cache
                    const cacheKey = `${currentMonthStr}_${dimension}_${entityIdForPreviousMonth}`;

                    if (previousMonthBalanceCache.has(cacheKey)) {
                        previousMonthBalance = previousMonthBalanceCache.get(cacheKey)!;
                    } else {
                        try {
                            if (dimension === "banca") {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "banca",
                                    undefined,
                                    undefined,
                                    entry.bancaId || bancaId || null
                                );
                            } else if (dimension === "ventana") {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "ventana",
                                    entry.ventanaId || ventanaId || null,
                                    undefined,
                                    entry.bancaId || bancaId || undefined
                                );
                            } else {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "vendedor",
                                    entry.ventanaId || ventanaId || undefined,
                                    entry.vendedorId || vendedorId || null,
                                    entry.bancaId || bancaId || undefined
                                );
                            }
                            previousMonthBalance = Number(previousMonthBalance);
                            previousMonthBalanceCache.set(cacheKey, previousMonthBalance);
                        } catch (error) {
                            logger.warn({
                                layer: "service",
                                action: "PREVIOUS_MONTH_BALANCE_FETCH_ERROR",
                                payload: {
                                    date,
                                    currentMonthStr,
                                    dimension,
                                    error: (error as Error).message,
                                },
                            });
                            previousMonthBalance = 0;
                            previousMonthBalanceCache.set(cacheKey, 0);
                        }
                    }
                }

                //  CRÍTICO: Usar saldo del mes anterior directamente como acumulado inicial.
                // Ya no usamos un movimiento virtual para esto.
                initialAccumulated = Number(previousMonthBalance);

                // Reducir logs innecesarios - solo log si hay problema

            } else {
                // Calcular fecha del día anterior
                const dateParts = (date || "").split('-');
                if (dateParts.length < 3) {
                    throw new Error(`Invalid date format for split: ${date}`);
                }
                const [year, month, day] = dateParts.map(Number);
                const previousDayDate = new Date(Date.UTC(year, month - 1, day));
                previousDayDate.setUTCDate(previousDayDate.getUTCDate() - 1);
                const previousDateStr = `${previousDayDate.getUTCFullYear()}-${String(previousDayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(previousDayDate.getUTCDate()).padStart(2, '0')}`;

                //  CRÍTICO: Detectar si el día anterior está en un mes diferente
                const previousDateMonthStr = `${previousDayDate.getUTCFullYear()}-${String(previousDayDate.getUTCMonth() + 1).padStart(2, '0')}`;
                const previousDateIsDifferentMonth = previousDateMonthStr !== currentMonthStr;

                //  CRÍTICO: Obtener saldo del mes anterior para usar como fallback si no encontramos statement del día anterior
                let previousMonthBalance: number;
                try {
                    const entityIdForPreviousMonth = dimension === "banca"
                        ? (entry.bancaId || bancaId || 'null')
                        : dimension === "ventana"
                            ? (entry.ventanaId || ventanaId || 'null')
                            : (entry.vendedorId || vendedorId || 'null');

                    // Primero intentar usar el saldo pre-calculado si estamos en el mes de inicio del rango
                    if (currentMonthStr === effectiveMonth && date === firstDayOfMonthStr) {
                        const cachedBalance = previousMonthBalancesByEntity.get(entityIdForPreviousMonth);
                        previousMonthBalance = (cachedBalance !== undefined && cachedBalance !== 0)
                            ? cachedBalance
                            : previousMonthBalanceForMovement;
                    } else {
                        // Para otros meses (cuando el rango cruza meses), calcular dinámicamente con cache
                        const cacheKey = `${currentMonthStr}_${dimension}_${entityIdForPreviousMonth}`;

                        if (previousMonthBalanceCache.has(cacheKey)) {
                            previousMonthBalance = previousMonthBalanceCache.get(cacheKey)!;
                        } else {
                            if (dimension === "banca") {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "banca",
                                    undefined,
                                    undefined,
                                    entry.bancaId || bancaId || null
                                );
                            } else if (dimension === "ventana") {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "ventana",
                                    entry.ventanaId || ventanaId || null,
                                    undefined,
                                    entry.bancaId || bancaId || undefined
                                );
                            } else {
                                previousMonthBalance = await getPreviousMonthFinalBalance(
                                    currentMonthStr,
                                    "vendedor",
                                    entry.ventanaId || ventanaId || undefined,
                                    entry.vendedorId || vendedorId || null,
                                    entry.bancaId || bancaId || undefined
                                );
                            }
                            previousMonthBalance = Number(previousMonthBalance);
                            previousMonthBalanceCache.set(cacheKey, previousMonthBalance);
                        }
                    }
                } catch (error) {
                    logger.warn({
                        layer: "service",
                        action: "PREVIOUS_MONTH_BALANCE_FETCH_ERROR_FALLBACK",
                        payload: {
                            date,
                            currentMonthStr,
                            dimension,
                            error: (error as Error).message,
                        },
                    });
                    previousMonthBalance = 0;
                }

                //  CRÍTICO: SOLUCIÓN DEFINITIVA - El cálculo progresivo es la ÚNICA fuente de verdad
                // PRIORIDAD: 1) lastAccumulatedByEntity (cálculo en curso, más confiable), 2) mapa pre-cargado (fallback), 3) saldo mes anterior
                let previousDayRemainingBalance: number | null = null;

                //  CRÍTICO: Construir entityKey para buscar en lastAccumulatedByEntity usando EXACTAMENTE la misma lógica que cuando se guarda
                // Esto asegura que la clave coincida perfectamente
                const entityKeyForLastAccumulated = shouldGroupByDate
                    ? previousDateStr // Si hay agrupación, usar solo la fecha
                    : dimension === "banca" && !bancaId
                        ? previousDateStr // Si dimension=banca sin bancaId, agrupar por fecha
                        : dimension === "banca"
                            ? `${previousDateStr}_${bancaId || entry.bancaId || 'null'}`
                            : dimension === "ventana"
                                ? `${previousDateStr}_${ventanaId || entry.ventanaId || 'null'}`
                                : `${previousDateStr}_${vendedorId || entry.vendedorId || 'null'}`;

                //  PRIORIDAD 1: Buscar primero en lastAccumulatedByEntity (valores calculados en esta ejecución)
                // Este es el MÁS CONFIABLE porque es el valor que acabamos de calcular
                if (!previousDateIsDifferentMonth) {
                    const cachedAccumulated = lastAccumulatedByEntity.get(entityKeyForLastAccumulated);
                    if (cachedAccumulated !== undefined && cachedAccumulated !== null) {
                        previousDayRemainingBalance = cachedAccumulated;
                    }
                }

                //  PRIORIDAD 2: Si no está en lastAccumulatedByEntity, buscar en mapa pre-cargado (fallback)
                if (previousDayRemainingBalance === null) {
                    try {
                        if (shouldGroupByDate && dimension === "banca" && !bancaId) {
                            // Consolidado: buscar _consolidado
                            let searchDate = new Date(previousDayDate);
                            let daysSearched = 0;
                            const maxSearchDays = 30;

                            while (previousDayRemainingBalance === null && daysSearched < maxSearchDays) {
                                const searchDateStr = crDateService.postgresDateToCRString(searchDate);
                                const dateMap = preloadedStatementsMap.get(searchDateStr);

                                if (dateMap && dateMap.has('_consolidado')) {
                                    const consolidatedValue = dateMap.get('_consolidado');
                                    previousDayRemainingBalance = typeof consolidatedValue === 'number' ? consolidatedValue : null;
                                    break;
                                }

                                searchDate.setUTCDate(searchDate.getUTCDate() - 1);
                                daysSearched++;
                            }
                        } else {
                            // Statement específico
                            let targetBancaId: string | undefined = undefined;
                            let targetVentanaId: string | undefined = undefined;
                            let targetVendedorId: string | undefined = undefined;

                            if (dimension === "banca") {
                                //  CRÍTICO: Cuando dimension="banca" con bancaId específico,
                                // SOLO buscar statements consolidados de banca (ventanaId=null, vendedorId=null)
                                // NO incluir statements de ventanas/vendedores para evitar usar valores incorrectos
                                targetBancaId = bancaId || entry.bancaId || undefined;
                                //  CRÍTICO: NO incluir targetVentanaId ni targetVendedorId cuando dimension="banca"
                                // porque queremos SOLO el statement consolidado de la banca
                                targetVentanaId = undefined;
                                targetVendedorId = undefined;
                            } else if (dimension === "ventana") {
                                targetBancaId = entry.bancaId || undefined;
                                targetVentanaId = ventanaId || entry.ventanaId || undefined;
                                if (!shouldGroupByDate) {
                                    targetVendedorId = entry.vendedorId || undefined;
                                }
                            } else if (dimension === "vendedor") {
                                //  CRÍTICO: Cuando dimension="vendedor" con vendedorId específico,
                                // SOLO usar el vendedorId del filtro, NO el del entry
                                // Esto evita usar el vendedorId de otro vendedor cuando hay múltiples entries
                                targetBancaId = entry.bancaId || undefined;
                                targetVentanaId = entry.ventanaId || undefined;
                                //  CRÍTICO: Priorizar vendedorId del filtro sobre entry.vendedorId
                                targetVendedorId = vendedorId || undefined;
                            }

                            let searchDate = new Date(previousDayDate);
                            let daysSearched = 0;
                            const maxSearchDays = 30;

                            while (previousDayRemainingBalance === null && daysSearched < maxSearchDays) {
                                const searchDateStr = crDateService.postgresDateToCRString(searchDate);
                                const dateMap = preloadedStatementsMap.get(searchDateStr);

                                if (dateMap) {
                                    //  CRÍTICO: Construir entityKey según dimensión
                                    // Cuando dimension="banca" con bancaId, usar SOLO el bancaId (no ventanaId/vendedorId)
                                    // Cuando dimension="vendedor" con vendedorId, usar SOLO el vendedorId (no ventanaId/bancaId)
                                    // Esto asegura que se use el statement correcto, no el de otra entidad
                                    const entityKey = dimension === "banca" && targetBancaId
                                        ? targetBancaId //  CRÍTICO: Solo bancaId cuando dimension="banca"
                                        : dimension === "vendedor" && targetVendedorId
                                            ? targetVendedorId //  CRÍTICO: Solo vendedorId cuando dimension="vendedor"
                                            : targetVendedorId
                                                ? targetVendedorId
                                                : targetVentanaId
                                                    ? targetVentanaId
                                                    : targetBancaId || 'null';

                                    if (dateMap.has(entityKey)) {
                                        const balanceValue = dateMap.get(entityKey);
                                        //  CRÍTICO: Validar que el valor encontrado sea del tipo correcto
                                        // Si dimension="vendedor", NO usar valores de ventana/banca
                                        if (dimension === "vendedor" && targetVendedorId) {
                                            // Solo usar si el entityKey coincide exactamente con el vendedorId
                                            if (entityKey === targetVendedorId) {
                                                previousDayRemainingBalance = typeof balanceValue === 'number' ? balanceValue : null;
                                                break;
                                            }
                                        } else {
                                            previousDayRemainingBalance = typeof balanceValue === 'number' ? balanceValue : null;
                                            break;
                                        }
                                    }
                                }

                                searchDate.setUTCDate(searchDate.getUTCDate() - 1);
                                daysSearched++;
                            }

                            //  CRÍTICO: Si dimension="vendedor" y no encontramos statement del vendedor,
                            // NO usar el de la ventana. En su lugar, usar el saldo del mes anterior
                            if (dimension === "vendedor" && targetVendedorId && previousDayRemainingBalance === null) {
                                // Si no encontramos statement del vendedor, usar el saldo del mes anterior
                                // Esto evita usar el saldo de la ventana por error
                                previousDayRemainingBalance = Number(previousMonthBalance);
                            }
                        }
                    } catch (error) {
                        // Silenciar errores de búsqueda en mapa pre-cargado, continuar con saldo mes anterior
                    }
                }

                //  CRÍTICO: Asignar initialAccumulated desde previousDayRemainingBalance
                //  CRÍTICO: Si no encontramos valor previo directamente, buscar retrocediendo días en lastAccumulatedByEntity
                // Esto maneja casos donde puede haber gaps en el procesamiento
                //  CRÍTICO: Validar que cuando dimension="vendedor", NO usar valores de ventana
                // Si previousDayRemainingBalance es muy grande (como 797754.25), probablemente es de la ventana, no del vendedor


                //  CRÍTICO: Determinar initialAccumulated final para el día
                // Prioridad 1: Caché en memoria de esta ejecución (runningAccumulatedByEntity)
                // Prioridad 2: Saldo del mes anterior (si es cambio de mes o inicio de rango)
                // Prioridad 3: Fallback a BD (solo si no es el mes actual o no hay caché)

                //  NUEVO: Usar mapa simple de entityId para carry-over robusto
                const runningValue = runningAccumulatedByEntity.get(entityId);

                if (balanceResetAtDayStr && date === balanceResetAtDayStr) {
                    // Si es el día del reset, el saldo inicial acumulado empieza en 0
                    initialAccumulated = 0;
                } else if (runningValue !== undefined && runningValue !== null && !previousDateIsDifferentMonth) {
                    // Si ya calculamos algo en esta ejecución para esta entidad, usarlo (MÁS CONFIABLE)
                    initialAccumulated = runningValue;
                } else if (previousDateIsDifferentMonth || runningValue === undefined) {
                    // Si es inicio de mes o inicio de rango, intentar usar saldo del mes anterior
                    // Pero PRIMERO verificar si hay un statement en el mapa pre-cargado para el día anterior
                    if (previousDayRemainingBalance !== null) {
                        initialAccumulated = previousDayRemainingBalance;
                    } else {
                        initialAccumulated = Number(previousMonthBalance);
                    }
                } else {
                    // Fallback final: 0 si no hay nada (no debería pasar con gaps llenos)
                    initialAccumulated = 0;
                }

                //  DEBUG MARCELA: Investigar problema de acumulado

                // if (isMarcela && (date === '2026-01-01' || date === '2026-01-02' || date === '2026-01-03' || date === '2026-01-04')) {
                //     logger.info({
                //         layer: "service",
                //         action: "DEBUG_MARCELA_ACCUMULATION",
                //         payload: {
                //             date,
                //             previousDateStr,
                //             runningValue,
                //             previousDayRemainingBalance,
                //             previousMonthBalance: Number(previousMonthBalance),
                //             previousDateIsDifferentMonth,
                //             initialAccumulated,
                //         }
                //     });
                // }
            }





      const { statement, statementRemainingBalance } = StatementInterleavingFormatter.formatDay({
        date,
        entry,
        bySorteo,
        movements,
        allMovementsForDate,
        initialAccumulated,
        dimension,
        shouldGroupByDate,
        bancaId,
        ventanaId,
        vendedorId,
        breakdownByEntity,
        sorteoBreakdownBatch,
        preloadedStatementsMap,
        runningAccumulatedByEntity,
        lastAccumulatedByEntity,
        entityId,
        entityKey,
        totalPaid,
        totalCollected,
        totalPayouts,
        balance,
        userRole,
      });

      runningAccumulatedByEntity.set(entityId, statementRemainingBalance);
      lastAccumulatedByEntity.set(entityKey, statementRemainingBalance);

      allStatementsFromMonth.push(statement);


        //  CRÍTICO: Guardar el statement INMEDIATAMENTE después de calcularlo
        // Esto asegura que cuando se procesa el día siguiente, el día actual ya está guardado
        //  MEJORA: Retry loop para manejar concurrencia (Code 40001)
        let saved = false;
        let retries = 0;
        const maxRetries = 3;

        while (!saved && retries < maxRetries) {
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
                //  CRÍTICO: Solo guardar si tenemos al menos un ID (bancaId, ventanaId o vendedorId)
                // Si todos son undefined, es un consolidado global que no se guarda en AccountStatement
                if (!targetBancaId && !targetVentanaId && !targetVendedorId) {
                    saved = true;
                    continue;
                }

                const dbStatement = await AccountStatementRepository.findOrCreate({
                    date: statementDate,
                    month: monthForStatement,
                    bancaId: targetBancaId,
                    ventanaId: targetVentanaId,
                    vendedorId: targetVendedorId,
                });

                //  CRÍTICO: Usar el remainingBalance del statement (que ya fue calculado correctamente)
                // El statement.remainingBalance ya usa accountStatementAccumulated si está disponible (línea 2162)
                // El statement.accumulatedBalance también está disponible si fue calculado
                const finalRemainingBalance = statement.remainingBalance; // Ya incluye la lógica de priorizar AccountStatement

                // Actualizar con todos los valores calculados
                await AccountStatementRepository.update(dbStatement.id, {
                    totalSales: statement.totalSales,
                    totalPayouts: statement.totalPayouts,
                    listeroCommission: statement.listeroCommission,
                    vendedorCommission: statement.vendedorCommission,
                    balance: statement.balance,
                    totalPaid: statement.totalPaid,
                    totalCollected: statement.totalCollected,
                    remainingBalance: finalRemainingBalance, //  CRÍTICO: Usar el valor correcto (del AccountStatement si está disponible)
                    accumulatedBalance: finalRemainingBalance, //  CRÍTICO: También actualizar accumulatedBalance con el valor correcto
                    isSettled: statement.isSettled,
                    canEdit: statement.canEdit,
                    ticketCount: statement.ticketCount,
                });

                saved = true;
            } catch (error: any) {
                // Verificar si es error de concurrencia
                const isConcurrencyError = error?.code === '40001' ||
                    error?.message?.includes('could not serialize access') ||
                    error?.message?.includes('concurrent update');

                if (isConcurrencyError) {
                    retries++;
                    if (retries < maxRetries) {
                        // Esperar random backoff entre 50-200ms
                        const waitTime = Math.floor(Math.random() * 150) + 50;
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue; // Reintentar
                    }
                }

                // Si no es concurrencia o se acabaron los retries, loggear y salir
                logger.error({
                    layer: "service",
                    action: "ACCOUNT_STATEMENT_IMMEDIATE_SAVE_ERROR",
                    payload: {
                        date: statement.date,
                        dimension,
                        attempt: retries + 1,
                        isConcurrencyError,
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
                break; // No seguir intentando
            }
        }
    }

    // Ordenar statements por fecha
    allStatementsFromMonth.sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      return sort === "desc" ? dateB - dateA : dateA - dateB;
    });

    // Calcular monthlyAccumulated
    const {
      monthlyAccumulated,
      monthStartDate,
      monthEndDate,
    } = await StatementAccumulatorEngine.calculateMonthlyAccumulated({
      dimension,
      bancaId,
      ventanaId,
      vendedorId,
      allStatementsFromMonth,
      firstDayOfMonthStr,
      effectiveMonth,
      daysInMonth,
    });

    // Paso 3, 4, 5 y retorno de StatementResponse
    let statements = [...allStatementsFromMonth];
    //  CRÍTICO: Paso 3 - Guardar statements calculados en la base de datos
    // Asegurar que todos los campos se guarden correctamente para todas las dimensiones
    // Esto garantiza que la información esté bien registrada y sea fidedigna

    //  CRÍTICO: Cuando shouldGroupByDate=true, todos los statements del mismo día deben tener el mismo remainingBalance
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

            //  CRÍTICO: Cuando hay agrupación, todos los statements del mismo día deben tener el mismo remainingBalance
            // El remainingBalance debe ser el accumulated del último sorteo/movimiento del día (ya calculado correctamente)
            // NO tomar el máximo, sino el remainingBalance del statement que tiene sorteos (el más reciente)
            // Si hay múltiples statements, usar el que tiene el último sorteo (mayor chronologicalIndex)
            let correctRemainingBalance = 0;
            for (const statement of statementsForDate) {
                // Si el statement tiene bySorteo, tomar el accumulated del último evento
                if (statement.bySorteo && statement.bySorteo.length > 0) {
                    const sortedByChronology = [...statement.bySorteo].sort((a, b) => {
                        const indexA = a.chronologicalIndex || 0;
                        const indexB = b.chronologicalIndex || 0;
                        return indexB - indexA; // DESC por índice
                    });
                    const lastEvent = sortedByChronology[0];
                    if (lastEvent && lastEvent.accumulated !== undefined && lastEvent.accumulated !== null) {
                        const eventAccumulated = Number(lastEvent.accumulated);
                        // Usar el accumulated del último evento (más reciente)
                        if (Math.abs(eventAccumulated) > Math.abs(correctRemainingBalance)) {
                            correctRemainingBalance = eventAccumulated;
                        }
                    }
                } else {
                    // Si no tiene bySorteo, usar el remainingBalance calculado
                    if (Math.abs(statement.remainingBalance) > Math.abs(correctRemainingBalance)) {
                        correctRemainingBalance = statement.remainingBalance;
                    }
                }
            }

            // Si no encontramos un remainingBalance válido, usar el máximo de los statements
            if (correctRemainingBalance === 0) {
                for (const statement of statementsForDate) {
                    if (Math.abs(statement.remainingBalance) > Math.abs(correctRemainingBalance)) {
                        correctRemainingBalance = statement.remainingBalance;
                    }
                }
            }

            // Asignar el mismo remainingBalance a todos los statements del día
            for (const statement of statementsForDate) {
                statement.remainingBalance = parseFloat(correctRemainingBalance.toFixed(2));

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

    //  CRÍTICO: Guardar todos los statements calculados en la base de datos
    // Esto asegura que la información esté bien registrada para futuras consultas
    // Asegurar que se guarden correctamente para todas las dimensiones y escenarios

    if (shouldGroupByDate) {
        //  CRÍTICO: Cuando hay agrupación, guardar statement consolidado por día
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

            //  CRÍTICO: Sumar todos los valores de las entidades del día
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

                //  CRÍTICO: Determinar IDs según la dimensión para statement consolidado
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
                //  CRÍTICO: Solo guardar si tenemos al menos un ID (bancaId, ventanaId o vendedorId)
                if (!targetBancaId && !targetVentanaId && !targetVendedorId) {
                    continue; // Skip global consolidated view
                }

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
        //  CRÍTICO: Cuando no hay agrupación, guardar statements individuales por entidad
        // Procesar en lotes para evitar sobrecargar la BD
        const BATCH_SIZE = 50;
        for (let i = 0; i < allStatementsFromMonth.length; i += BATCH_SIZE) {
            const batch = allStatementsFromMonth.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (statement) => {
                try {
                    // Convertir date string a Date object
                    const statementDate = new Date(statement.date + 'T00:00:00.000Z');

                    //  CRÍTICO: Determinar bancaId, ventanaId, vendedorId según la dimensión
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
                    //  CRÍTICO: Solo guardar si tenemos al menos un ID
                    if (!targetBancaId && !targetVentanaId && !targetVendedorId) {
                        return; // Skip if no IDs present
                    }

                    const dbStatement = await AccountStatementRepository.findOrCreate({
                        date: statementDate,
                        month: monthForStatement,
                        bancaId: targetBancaId,
                        ventanaId: targetVentanaId,
                        vendedorId: targetVendedorId,
                    });

                    //  CRÍTICO: Usar el remainingBalance del statement (que ya fue calculado correctamente)
                    // El statement.remainingBalance ya usa accountStatementAccumulated si está disponible (línea 2162)
                    // El statement.accumulatedBalance también está disponible si fue calculado
                    const finalRemainingBalance = statement.remainingBalance; // Ya incluye la lógica de priorizar AccountStatement

                    // Actualizar con todos los valores calculados
                    await AccountStatementRepository.update(dbStatement.id, {
                        totalSales: statement.totalSales,
                        totalPayouts: statement.totalPayouts,
                        listeroCommission: statement.listeroCommission,
                        vendedorCommission: statement.vendedorCommission,
                        balance: statement.balance,
                        totalPaid: statement.totalPaid,
                        totalCollected: statement.totalCollected,
                        remainingBalance: finalRemainingBalance, //  CRÍTICO: Usar el valor correcto (del AccountStatement si está disponible)
                        accumulatedBalance: finalRemainingBalance, //  CRÍTICO: También actualizar accumulatedBalance con el valor correcto
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

    //  ELIMINADO: Paso 3.5 ya no es necesario porque el Paso 3 ahora usa directamente bySorteo
    // El remainingBalance ya está correcto después del Paso 3

    //  CRÍTICO: Paso 4 - Filtrar para retornar solo los días dentro del período solicitado
    // La acumulación ya se calculó correctamente para todos los días del mes
    // Ahora solo devolvemos los días que el usuario pidió ver
    //  CORREGIDO: statement.date ya es un string YYYY-MM-DD, no necesita conversión
    statements = allStatementsFromMonth.filter(statement => {
        const statementDateStr = statement.date; // Ya es YYYY-MM-DD
        return statementDateStr >= startDateCRStr && statementDateStr <= endDateCRStr;
    });

    //  PROPUESTA 6: Filtrar días vacíos (sin actividad, excepto día 1 del mes)
    // Un día tiene actividad si:
    // 1. Tiene tickets (ticketCount > 0), O
    // 2. Tiene movimientos (totalPaid > 0 || totalCollected > 0), O
    // 3. Es el día 1 de cualquier mes en el rango (saldo inicial) -  CORRECCIÓN: No solo del mes de inicio
    //  NOTA: startDateCRStr y endDateCRStr ya están declaradas al inicio de la función (línea 539)

    //  CRÍTICO: Detectar todos los días 1 que están en el rango (puede haber múltiples si cruza meses/años)
    const firstDaysInRange = new Set<string>();
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        const currentDateCRStr = crDateService.dateUTCToCRString(currentDate);
        const [year, month, day] = currentDateCRStr.split('-').map(Number);
        if (day === 1) {
            firstDaysInRange.add(currentDateCRStr);
        }
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    statements = statements.filter(statement => {
        const isFirstDayOfAnyMonthInRange = firstDaysInRange.has(statement.date);
        const hasTickets = (statement.ticketCount || 0) > 0;
        const hasMovements = (statement.totalPaid || 0) > 0 || (statement.totalCollected || 0) > 0;

        // Mostrar si es día 1 de cualquier mes en el rango, tiene tickets, o tiene movimientos
        return isFirstDayOfAnyMonthInRange || hasTickets || hasMovements;
    });

    //  CORRECCIÓN: Deduplicar días - puede haber múltiples statements para el mismo día
    // cuando se filtra por ventanaId/vendedorId (statements consolidados vs individuales)
    // Mantener solo el statement más relevante por día
    //  CRÍTICO: Cuando hay filtro por vendedorId específico, preferir el statement que corresponde a ese vendedorId
    const statementsByDate = new Map<string, any>();
    for (const statement of statements) {
        const dateKey = statement.date;
        const existing = statementsByDate.get(dateKey);

        if (!existing) {
            statementsByDate.set(dateKey, statement);
        } else {
            //  CRÍTICO: Si hay filtro por vendedorId, preferir el statement que tiene ese vendedorId
            if (vendedorId) {
                const currentMatchesVendedor = statement.vendedorId === vendedorId;
                const existingMatchesVendedor = existing.vendedorId === vendedorId;

                if (currentMatchesVendedor && !existingMatchesVendedor) {
                    // El actual corresponde al vendedorId filtrado, preferirlo
                    statementsByDate.set(dateKey, statement);
                    continue;
                } else if (!currentMatchesVendedor && existingMatchesVendedor) {
                    // El existente corresponde al vendedorId filtrado, mantenerlo
                    continue;
                }
            }

            // Si hay duplicado, preferir el que tiene más datos (más tickets, o más reciente remainingBalance)
            // O si son iguales en datos, mantener el primero
            const existingHasData = (existing.ticketCount || 0) > 0 || (existing.totalSales || 0) > 0;
            const currentHasData = (statement.ticketCount || 0) > 0 || (statement.totalSales || 0) > 0;

            if (currentHasData && !existingHasData) {
                // Preferir el que tiene datos
                statementsByDate.set(dateKey, statement);
            } else if (currentHasData && existingHasData) {
                //  CRÍTICO: Ambos tienen datos, preferir el que tenga el remainingBalance calculado desde sorteos
                // (el que tenga bySorteo con accumulated del último evento)
                const currentLastAccumulated = statement.bySorteo && statement.bySorteo.length > 0
                    ? (() => {
                        const sorted = [...statement.bySorteo].sort((a, b) => {
                            const indexA = a.chronologicalIndex || 0;
                            const indexB = b.chronologicalIndex || 0;
                            return indexB - indexA;
                        });
                        return sorted[0]?.accumulated;
                    })()
                    : null;
                const existingLastAccumulated = existing.bySorteo && existing.bySorteo.length > 0
                    ? (() => {
                        const sorted = [...existing.bySorteo].sort((a, b) => {
                            const indexA = a.chronologicalIndex || 0;
                            const indexB = b.chronologicalIndex || 0;
                            return indexB - indexA;
                        });
                        return sorted[0]?.accumulated;
                    })()
                    : null;

                // Si el actual tiene accumulated del último sorteo y coincide con remainingBalance, preferirlo
                if (currentLastAccumulated !== null && currentLastAccumulated !== undefined &&
                    Math.abs(currentLastAccumulated - statement.remainingBalance) < 0.01) {
                    statementsByDate.set(dateKey, statement);
                } else if (existingLastAccumulated !== null && existingLastAccumulated !== undefined &&
                    Math.abs(existingLastAccumulated - existing.remainingBalance) < 0.01) {
                    // El existente tiene accumulated del último sorteo, mantenerlo
                    continue;
                } else if (statement.remainingBalance !== null && statement.remainingBalance !== undefined &&
                    (existing.remainingBalance === null || existing.remainingBalance === undefined)) {
                    statementsByDate.set(dateKey, statement);
                } else if (statement.remainingBalance !== null && existing.remainingBalance !== null) {
                    // Ambos tienen remainingBalance, usar el que esté más cerca del accumulated del último sorteo
                    if (currentLastAccumulated !== null && existingLastAccumulated !== null) {
                        // Ambos tienen accumulated, usar el que tenga remainingBalance más cercano
                        const currentDiff = Math.abs(currentLastAccumulated - statement.remainingBalance);
                        const existingDiff = Math.abs(existingLastAccumulated - existing.remainingBalance);
                        if (currentDiff < existingDiff) {
                            statementsByDate.set(dateKey, statement);
                        }
                    } else if (currentLastAccumulated !== null) {
                        // Solo el actual tiene accumulated, preferirlo
                        statementsByDate.set(dateKey, statement);
                    }
                }
            }
            // Si ninguno tiene datos o el existente es mejor, mantener el existente
        }
    }

    // Convertir de vuelta a array y ordenar por fecha
    statements = Array.from(statementsByDate.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
    );

    //  CRÍTICO: Paso 5 - Calcular totales SOLO para los días filtrados
    const totalSales = statements.reduce((sum, s) => sum + s.totalSales, 0);
    const totalPayouts = statements.reduce((sum, s) => sum + s.totalPayouts, 0);
    const totalListeroCommission = statements.reduce((sum, s) => sum + s.listeroCommission, 0);
    const totalVendedorCommission = statements.reduce((sum, s) => sum + s.vendedorCommission, 0);
    const totalCommissionToUse = vendedorId ? totalVendedorCommission : totalListeroCommission;
    const totalBalanceBase = totalSales - totalPayouts - totalCommissionToUse;
    const totalPaid = statements.reduce((sum, s) => sum + s.totalPaid, 0);
    const totalCollected = statements.reduce((sum, s) => sum + s.totalCollected, 0);

    //  NUEVO: Obtener saldo del mes anterior para incluir en totals.totalBalance y totals.totalRemainingBalance
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

    //  CRÍTICO: totalRemainingBalance debe incluir el saldo del mes anterior si el período incluye el día 1
    // Según el requerimiento: totals.totalRemainingBalance = saldoFinalMesAnterior + SUM(statements[].remainingBalance)
    // El remainingBalance de cada statement se calcula acumulativamente, pero el del día 1 ya incluye el saldo del mes anterior
    //  CRÍTICO: totalRemainingBalance debe incluir el saldo del mes anterior si el período incluye el día 1
    // Según el requerimiento: totals.totalRemainingBalance = saldoFinalMesAnterior + totalBalance del período
    // El remainingBalance de cada statement ya incluye el saldo del mes anterior (para mostrar el balance acumulado correcto)
    // Pero el totalRemainingBalance debe ser simplemente: saldo del mes anterior + totalBalance del período
    // Esto evita duplicar el saldo del mes anterior cuando sumamos los remainingBalance de múltiples días
    //  CRÍTICO: Asegurar que periodPreviousMonthBalance sea un número
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

    //  CORRECCIÓN CRÍTICA: totalBalance debe ser la SUMA de los balances del período consultado
    // NO debe usar remainingBalance del último día porque eso es un acumulado progresivo desde el inicio del mes
    // El saldo del período (totalRemainingBalance) debe ser simplemente la suma de los balances diarios del período
    // 
    // Cada statement.balance ya incluye: sales - payouts - commission + totalPaid - totalCollected
    // Por lo tanto, totalBalance = suma de todos los statement.balance del período
    let totalBalance = 0;
    if (statements.length > 0) {
        //  CORRECCIÓN: Sumar los balances de todos los statements del período
        // Esto representa el saldo neto del período consultado (no acumulado desde inicio del mes)
        totalBalance = statements.reduce((sum, s) => sum + Number(s.balance || 0), 0);
    } else {
        // Si no hay statements, calcular desde balance base + movimientos
        const totalBalanceBase = totalSales - totalPayouts - totalCommissionToUse;
        totalBalance = Number(totalBalanceBase) + Number(totalPaid) - Number(totalCollected);
    }

    //  CORRECCIÓN: totalRemainingBalance debe ser igual a totalBalance
    // Ambos representan la suma de los balances del período consultado (no el acumulado del mes)
    // El acumulado del mes se calcula en monthlyAccumulated.totalRemainingBalance
    const totalRemainingBalance = Number(totalBalance);

    const functionEndTime = Date.now();
    // logger.info({
    //     layer: "service",
    //     action: "GET_STATEMENT_DIRECT_END",
    //     payload: {
    //         dimension,
    //         bancaId,
    //         ventanaId,
    //         vendedorId,
    //         statementsCount: statements.length,
    //         totalTimeMs: functionEndTime - functionStartTime,
    //     },
    // });

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
        monthlyAccumulated,  //  NUEVO: Saldo a Hoy (acumulado del mes)
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
}
