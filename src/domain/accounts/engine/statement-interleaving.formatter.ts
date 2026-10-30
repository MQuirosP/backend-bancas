// src/domain/accounts/engine/statement-interleaving.formatter.ts

import { calculateIsSettled } from "../accounts.commissions";
import { intercalateSorteosAndMovements } from "../accounts.intercalate";
import {
  DayStatement,
  StatementDimension,
  AggregatedDimensionEntry,
} from "./types/statement.types";
import { Role } from "../../../generated/prisma/client";

export class StatementInterleavingFormatter {
  /**
   * Intercala sorteos y movimientos para una fecha específica y construye el DayStatement
   */
  static formatDay(params: {
    date: string;
    entry: AggregatedDimensionEntry;
    bySorteo: any[];
    movements: any[];
    allMovementsForDate: any[];
    initialAccumulated: number;
    dimension: StatementDimension;
    shouldGroupByDate: boolean;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
    breakdownByEntity: Map<string, any>;
    sorteoBreakdownBatch: Map<string, any[]>;
    preloadedStatementsMap: Map<string, Map<string, any>>;
    runningAccumulatedByEntity: Map<string, number>;
    lastAccumulatedByEntity: Map<string, number>;
    entityId: string;
    entityKey: string;
    totalPaid: number;
    totalCollected: number;
    totalPayouts: number;
    balance: number;
    userRole?: Role;
  }): {
    statement: DayStatement;
    statementRemainingBalance: number;
  } {
    const {
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
    } = params;

            const sorteosAndMovements = intercalateSorteosAndMovements(bySorteo, movements, date, initialAccumulated);

            //  CRÍTICO: Guardar el último accumulated de este día para el siguiente día
            //  NOTA: Cuando shouldGroupByDate=true o dimension="banca" sin bancaId,
            // entityKey es solo la fecha, así que solo hay una entrada por día.
            // El lastAccumulated ya incluye el acumulado progresivo correcto desde initialAccumulated.
            //  CORREGIDO: Cuando hay agrupación, solo actualizar lastAccumulatedByEntity una vez por día
            // (usar el máximo accumulated de todos los sorteos/movimientos del día)
            //  CRÍTICO: Intentar obtener el accumulatedBalance desde AccountStatement del día actual (fuente de verdad)
            // Si existe, usarlo en lugar del calculado, porque es más confiable
            let statementRemainingBalance = initialAccumulated; // Default: usar acumulado del día anterior
            let accountStatementAccumulated: number | null = null;

            //  OPTIMIZACIÓN: Usar statements pre-cargados para referencia (pero remainingBalance del día se calcula desde sorteos)
            // El accountStatementAccumulated es solo para referencia/comparación, el remainingBalance real viene del cálculo progresivo
            const currentDateMap = preloadedStatementsMap.get(date);
            let accountStatementId: string | null = null; //  NUEVO: ID para corrección automática

            if (shouldGroupByDate && dimension === "banca" && !bancaId) {
                // Consolidado: usar suma pre-cargada (remainingBalance)
                // Para consolidado, no tenemos un ID específico porque es suma de múltiples statements
                if (currentDateMap && currentDateMap.has('_consolidado')) {
                    //  RESTAURADO: El mapa guarda directamente el número (suma de accumulatedBalance)
                    const consolidatedValue = currentDateMap.get('_consolidado');
                    accountStatementAccumulated = typeof consolidatedValue === 'number' ? consolidatedValue : null;
                    // accountStatementId queda null para consolidado (no se puede corregir individualmente)
                }
            } else if (currentDateMap) {
                // Statement específico
                const entityKey = dimension === "vendedor" && (vendedorId || entry.vendedorId)
                    ? (vendedorId || entry.vendedorId || 'null')
                    : dimension === "ventana" && (ventanaId || entry.ventanaId)
                        ? (ventanaId || entry.ventanaId || 'null')
                        : dimension === "banca" && (bancaId || entry.bancaId)
                            ? (bancaId || entry.bancaId || 'null')
                            : null;

                if (entityKey && currentDateMap.has(entityKey)) {
                    //  CORRECCIÓN: El mapa guarda directamente el número (remainingBalance o accumulatedBalance)
                    const balanceValue = currentDateMap.get(entityKey);
                    accountStatementAccumulated = typeof balanceValue === 'number' ? balanceValue : null;
                    // accountStatementId queda null porque no guardamos el ID (no es necesario)
                }
            }

            //  CRÍTICO: SIEMPRE calcular desde sorteos/movimientos (fuente de verdad)
            // NO usar accountStatementAccumulated del preloadedStatementsMap porque puede estar incorrecto
            // El acumulado progresivo secuencial del día debe ser el accumulated del último sorteo/movimiento del día
            // (ordenado por chronologicalIndex, que representa el orden de procesamiento)
            if (sorteosAndMovements.length > 0) {
                //  CORRECCIÓN CRÍTICA: Encontrar el evento MÁS RECIENTE cronológicamente
                // Ordenar por scheduledAt DESC y luego por chronologicalIndex DESC
                // El chronologicalIndex representa el orden de procesamiento (mayor índice = procesado después)
                const sortedByChronology = [...sorteosAndMovements].sort((a, b) => {
                    const timeA = new Date(a.scheduledAt).getTime();
                    const timeB = new Date(b.scheduledAt).getTime();
                    if (timeB !== timeA) {
                        return timeB - timeA; // DESC por tiempo
                    }
                    // Si mismo tiempo, usar chronologicalIndex DESC (mayor índice = más reciente)
                    const indexA = a.chronologicalIndex || 0;
                    const indexB = b.chronologicalIndex || 0;
                    return indexB - indexA; // DESC por índice
                });

                // El primer elemento es el más reciente (mayor timestamp, o si igual, mayor chronologicalIndex)
                const mostRecentEvent = sortedByChronology[0];

                //  CRÍTICO: El accumulated del último evento es el acumulado progresivo secuencial del día
                if (mostRecentEvent && mostRecentEvent.accumulated !== undefined && mostRecentEvent.accumulated !== null && !isNaN(Number(mostRecentEvent.accumulated))) {
                    statementRemainingBalance = Number(mostRecentEvent.accumulated);
                }
            } else {
                // Si no hay sorteos/movimientos, mantener el accumulated del día anterior
                statementRemainingBalance = initialAccumulated;
            }

            //  DEBUG MARCELA: Investigar por qué el resumen difiere del último sorteo
            // if (isMarcela && (date === '2026-01-01' || date === '2026-01-02' || date === '2026-01-03' || date === '2026-01-04')) {
            //     logger.info({
            //         layer: "service",
            //         action: "DEBUG_MARCELA_RESULT",
            //         payload: {
            //             date,
            //             dailyBalance: balance,
            //             initialAccumulated,
            //             statementRemainingBalance,
            //             lastEventAccumulated: (sorteosAndMovements.length > 0) ? sorteosAndMovements[0].accumulated : 'EMPTY'
            //         }
            //     });
            // }

            //  CRÍTICO: SIEMPRE actualizar caches con el statementRemainingBalance correcto
            runningAccumulatedByEntity.set(entityId, statementRemainingBalance);
            lastAccumulatedByEntity.set(entityKey, statementRemainingBalance);


            const statement: any = {
                date,
                bancaId: entry.bancaId, //  NUEVO: Solo si dimension='banca' o si hay filtro por banca
                bancaName: entry.bancaName, //  NUEVO
                bancaCode: entry.bancaCode, //  NUEVO
                ventanaId: entry.ventanaId,
                ventanaName: entry.ventanaName,
                ventanaCode: entry.ventanaCode, //  NUEVO: Código de ventana
                vendedorId: entry.vendedorId,
                vendedorName: entry.vendedorName,
                vendedorCode: entry.vendedorCode, //  NUEVO: Código de vendedor
                totalSales: parseFloat(entry.totalSales.toFixed(2)),
                totalPayouts: parseFloat(totalPayouts.toFixed(2)),
                listeroCommission: parseFloat(entry.commissionListero.toFixed(2)),
                vendedorCommission: parseFloat(entry.commissionVendedor.toFixed(2)),
                dailyBalance: parseFloat(balance.toFixed(2)), //  NUEVO: Balance del día (ventas - premios - comisiones + movimientos) - para referencia
                balance: parseFloat(balance.toFixed(2)), //  CORRECCIÓN: balance es el balance del día (Daily Net) para consistencia con totales
                totalPaid: parseFloat(totalPaid.toFixed(2)),
                totalCollected: parseFloat(totalCollected.toFixed(2)),
                totalPaymentsCollections: parseFloat((totalPaid - totalCollected).toFixed(2)), //  CORREGIDO: totalPaid - totalCollected
                remainingBalance: parseFloat(statementRemainingBalance.toFixed(2)), //  CRÍTICO: remainingBalance es el acumulado progresivo
                accumulatedBalance: parseFloat(statementRemainingBalance.toFixed(2)), //  CRÍTICO: accumulatedBalance es el acumulado progresivo
                progressiveSequentialBalance: parseFloat(statementRemainingBalance.toFixed(2)), //  NUEVO: Acumulado progresivo secuencial del último sorteo del día (para uso del frontend)
                isSettled: calculateIsSettled(entry.totalTicketsCount, statementRemainingBalance, totalPaid, totalCollected),
                canEdit: !calculateIsSettled(entry.totalTicketsCount, statementRemainingBalance, totalPaid, totalCollected),
                ticketCount: entry.totalTicketsCount,
                bySorteo: sorteosAndMovements, //  Sorteos + Movimientos intercalados (incluye accumulated, calculado desde initialAccumulated correcto)
                hasSorteos: sorteosAndMovements.length > 0, //  NUEVO: Flag para lazy loading (FE puede usar para saber si hay sorteos)
            };

            //  DEBUG MARCELA FINAL: ¿Por qué el acumulado del día no coincide con el último sorteo?
            // if (isMarcela && (date === '2026-01-01' || date === '2026-01-02' || date === '2026-01-03' || date === '2026-01-04')) {
            //     logger.info({
            //         layer: "service",
            //         action: "DEBUG_MARCELA_FINAL_STATEMENT",
            //         payload: {
            //             date,
            //             dailyBalance: balance,
            //             initialAccumulated,
            //             statementRemainingBalance,
            //             topLevelRemainingBalance: statement.remainingBalance,
            //             lastEventAccumulated: sorteosAndMovements.length > 0 ? sorteosAndMovements[0].accumulated : 'N/A',
            //             firstEventAccumulated: sorteosAndMovements.length > 0 ? sorteosAndMovements[sorteosAndMovements.length - 1].accumulated : 'N/A'
            //         }
            //     });
            // }


            //  NUEVO: Agregar desglose por entidad cuando hay agrupación
            if (shouldGroupByDate) {
                if (dimension === "banca") {
                    //  NUEVO: Construir byBanca desde breakdownByEntity
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
                        totalTicketsCount: number; //  OPTIMIZACIÓN: Contador en lugar de Set
                    }>();

                    for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                        const breakdownDate = breakdownKey.split("_")[0];
                        if (breakdownDate === date && breakdownEntry.bancaId) {
                            //  CRÍTICO: Calcular totalPayouts desde sorteos agrupados por banca
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
                                    totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                                };
                                bancaMap.set(breakdownEntry.bancaId, bancaGroup);
                            }

                            // Agregar a totales de banca (bancaGroup está garantizado que no es undefined aquí)
                            const group = bancaGroup;
                            group.totalSales += breakdownEntry.totalSales;
                            //  NOTA: totalPayouts se calculará después desde sorteoBreakdownBatch al construir byVentana/byVendedor
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
                                        totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                                    };
                                    group.ventanas.set(ventanaKey, ventanaGroup);
                                }
                                ventanaGroup.totalSales += breakdownEntry.totalSales;
                                //  NOTA: totalPayouts no se puede calcular aquí porque los sorteos están agrupados por banca
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
                                        totalTicketsCount: 0, //  OPTIMIZACIÓN: Contador en lugar de Set
                                    };
                                    group.vendedores.set(vendedorKey, vendedorGroup);
                                }
                                vendedorGroup.totalSales += breakdownEntry.totalSales;
                                //  NOTA: totalPayouts no se puede calcular aquí porque los sorteos están agrupados por banca
                                // Se usará el totalPayouts de la banca distribuido proporcionalmente
                                vendedorGroup.commissionListero += breakdownEntry.commissionListero;
                                vendedorGroup.commissionVendedor += breakdownEntry.commissionVendedor;
                                vendedorGroup.totalTicketsCount += breakdownEntry.totalTicketsCount;
                            }
                        }
                    }

                    // Construir byBanca con byVentana y byVendedor
                    for (const [bancaId, bancaGroup] of bancaMap.entries()) {
                        //  CORRECCIÓN: Calcular totalPayouts desde sorteoBreakdownBatch (agrupado por banca)
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
                            //  CORRECCIÓN: Calcular totalPayouts desde sorteos de la banca (proporcional a ventas de esta ventana)
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
                            //  CORRECCIÓN: Cuando dimension=banca sin bancaId, NO mostrar sorteos individuales por ventana
                            // Los sorteos ya están agrupados por banca en el nivel principal (statement.bySorteo)
                            // El breakdown por entidad muestra solo totales, no sorteos individuales para evitar duplicados
                            const ventanaSorteos: any[] = []; // Vacío: sorteos ya mostrados en nivel principal

                            byVentana.push({
                                ventanaId: ventanaGroup.ventanaId,
                                ventanaName: ventanaGroup.ventanaName,
                                ventanaCode: ventanaGroup.ventanaCode,
                                bancaId: bancaGroup.bancaId, //  NUEVO: ID de banca
                                bancaName: bancaGroup.bancaName, //  NUEVO: Nombre de banca
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
                            //  CORRECCIÓN: Balance de vendedor usando vendedorCommission
                            //  CORRECCIÓN: Calcular totalPayouts desde sorteos de la banca (proporcional a ventas de este vendedor)
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
                            //  CORRECCIÓN: Cuando dimension=banca sin bancaId, NO mostrar sorteos individuales por vendedor
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
                                bancaId: bancaGroup.bancaId, //  NUEVO: ID de banca
                                bancaName: bancaGroup.bancaName, //  NUEVO: Nombre de banca
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
                            //  CRÍTICO: Obtener sorteos específicos de esta ventana
                            const ventanaSorteoKey = `${date}_${breakdownEntry.ventanaId}`;
                            const ventanaSorteos = sorteoBreakdownBatch.get(ventanaSorteoKey) || [];

                            //  CRÍTICO: Calcular totalPayouts sumando desde sorteos
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

                            //  CRÍTICO: Obtener movimientos específicos de esta ventana
                            const ventanaMovementsFiltered = allMovementsForDate.filter((m: any) => m.ventanaId === breakdownEntry.ventanaId);

                            ventanaBreakdown.push({
                                ventanaId: breakdownEntry.ventanaId,
                                ventanaName: breakdownEntry.ventanaName,
                                ventanaCode: breakdownEntry.ventanaCode, //  NUEVO: Código de ventana
                                bancaId: breakdownEntry.bancaId, //  NUEVO: ID de banca (si está disponible)
                                bancaName: breakdownEntry.bancaName, //  NUEVO: Nombre de banca (si está disponible)
                                totalSales: breakdownEntry.totalSales,
                                totalPayouts: ventanaTotalPayouts,
                                listeroCommission: breakdownEntry.commissionListero,
                                vendedorCommission: breakdownEntry.commissionVendedor,
                                balance: breakdownBalance,
                                totalPaid: ventanaTotalPaid,
                                totalCollected: ventanaTotalCollected,
                                remainingBalance: ventanaRemainingBalance,
                                ticketCount: breakdownEntry.totalTicketsCount,
                                //  CRÍTICO: Sorteos específicos de esta ventana (NO agrupados con otras ventanas)
                                bySorteo: ventanaSorteos,
                                //  CRÍTICO: Movimientos específicos de esta ventana (NO agrupados con otras ventanas)
                                movements: ventanaMovementsFiltered,
                            });
                        }
                    }
                    statement.byVentana = ventanaBreakdown.sort((a, b) => a.ventanaName.localeCompare(b.ventanaName));
                } else {
                    // Special case: when a VENTANA user requests dimension='vendedor' without a vendedorId
                    // we should present aggregated by-sorteo totals across all vendors ("por sorteo").
                    // To avoid the frontend showing a "por vendedor" breakdown, skip populating
                    // the per-vendedor breakdown in that specific case and keep the aggregated bySorteo.
                    if (dimension === "vendedor" && shouldGroupByDate && userRole === "VENTANA" && ventanaId && !vendedorId) {
                        statement.byVendedor = [];
                    } else {
                        // Construir byVendedor desde breakdownByEntity
                        const vendedorBreakdown: any[] = [];
                        for (const [breakdownKey, breakdownEntry] of breakdownByEntity.entries()) {
                            const breakdownDate = breakdownKey.split("_")[0];
                            if (breakdownDate === date) {
                                //  CRÍTICO: Obtener sorteos específicos de este vendedor
                                const vendedorSorteoKey = `${date}_${breakdownEntry.vendedorId || 'null'}`;
                                const vendedorSorteos = sorteoBreakdownBatch.get(vendedorSorteoKey) || [];

                                //  CRÍTICO: Calcular totalPayouts sumando desde sorteos
                                const vendedorTotalPayouts = vendedorSorteos.reduce((sum: number, sorteo: any) => sum + (sorteo.payouts || 0), 0);

                                //  CORRECCIÓN: Balance de vendedor usando vendedorCommission
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

                                //  CRÍTICO: Obtener movimientos específicos de este vendedor
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
                                    //  CRÍTICO: Sorteos específicos de este vendedor (NO agrupados con otros vendedores)
                                    bySorteo: vendedorSorteos,
                                    //  CRÍTICO: Movimientos específicos de este vendedor (NO agrupados con otros vendors)
                                    movements: vendedorMovementsFiltered,
                                });
                            }
                        }
                        statement.byVendedor = vendedorBreakdown.sort((a, b) => a.vendedorName.localeCompare(b.vendedorName));
                    }
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

// end statement build
// end statement build


    return {
      statement,
      statementRemainingBalance,
    };
  }
}
