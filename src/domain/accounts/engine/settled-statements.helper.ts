// src/domain/accounts/engine/settled-statements.helper.ts

import { Prisma } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { crDateService } from "../../../utils/crDateService";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { DayStatement } from "./types/statement.types";

export async function getExcludedTicketIdsForDate(date: Date): Promise<string[]> {
    // Optimización: tabla vacía → sin exclusiones, evitar query
    if (await isExclusionListEmpty()) return [];

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
 * Obtiene los saldos finales del mes anterior para múltiples entidades en batch
 *  ESTRATEGIA HÍBRIDA: Intenta usar statements asentados, si no calcula desde fuente
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'ventana' | 'vendedor'
 * @param entityIds - Array de IDs de entidades (ventanaId o vendedorId)
 * @returns Map<entityId, saldoFinal>
 */


/**
 * Obtiene el saldo final del mes anterior para una entidad específica
 *  ESTRATEGIA HÍBRIDA: Intenta usar statements asentados, si no calcula desde fuente de verdad
 * Esto garantiza que siempre tengamos el saldo correcto, independientemente del estado de asentamiento
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'banca' | 'ventana' | 'vendedor'
 * @param ventanaId - ID de ventana (opcional)
 * @param vendedorId - ID de vendedor (opcional)
 * @param bancaId - ID de banca (opcional)
 * @returns Saldo final del mes anterior o 0 si no existe
 */


/**
 *  OPTIMIZACIÓN: Obtiene estados de cuenta asentados desde account_statements
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
            isSettled: true, //  Solo estados asentados
        };

        // Filtros según dimension
        if (dimension === "vendedor") {
            if (vendedorId) {
                where.vendedorId = vendedorId;
            } else {
                where.vendedorId = { not: null };
            }
            //  RBAC: Si hay bancaId o ventanaId, filtrar también por ellos
            if (bancaId || ventanaId) {
                where.vendedor = {};
                if (bancaId) where.vendedor.bancaId = bancaId;
                if (ventanaId) where.vendedor.ventanaId = ventanaId;
            }
        } else if (dimension === "ventana") {
            if (ventanaId) {
                where.ventanaId = ventanaId;
            } else {
                where.ventanaId = { not: null };
            }
            where.vendedorId = null; // Statements consolidados de ventana
            if (bancaId) where.bancaId = bancaId;
        } else if (dimension === "banca" && bancaId) {
            //  CRÍTICO: Incluir statements con bancaId explícito O statements que pertenecen a esa banca a través de ventanaId
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
                        banca: { select: { id: true, name: true, code: true } }, //  Para obtener banca cuando bancaId es null
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
        const movementsTotals = await AccountPaymentRepository.findPaymentsTotalsBatch(statementIds);

        //  CRÍTICO: Determinar si necesitamos agregar por fecha
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

            //  Obtener bancaId, bancaName, bancaCode (puede venir de statement.banca o statement.ventana.banca)
            const effectiveBancaId = statement.bancaId || statement.ventana?.banca?.id || null;
            const effectiveBancaName = statement.banca?.name || statement.ventana?.banca?.name || null;
            const effectiveBancaCode = statement.banca?.code || statement.ventana?.banca?.code || null;

            const dayStatement: DayStatement = {
                id: statement.id,
                date: statement.date,
                month: statement.month,
                bancaId: effectiveBancaId, //  Usar el bancaId efectivo (del statement o de ventana.banca)
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
                totalPaid: totals.totalPaid, //  Actualizado desde AccountPayment
                totalCollected: totals.totalCollected, //  Actualizado desde AccountPayment
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
                    //  Obtener bancaName y bancaCode del primer statement que los tenga, o usar null
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
                    //  CRÍTICO: Calcular balance agregado usando la comisión correcta según dimension
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
                        //  CRÍTICO: balance debe incluir movimientos (igual que en statements individuales)
                        return balanceBase + totalPaid - totalCollected;
                    })(),
                    totalPaid: statements.reduce((sum, s) => sum + s.totalPaid, 0),
                    totalCollected: statements.reduce((sum, s) => sum + s.totalCollected, 0),
                    totalPaymentsCollections: statements.reduce((sum, s) => sum + s.totalPaymentsCollections, 0),
                    //  CRÍTICO: remainingBalance debe ser igual a balance (que ya incluye movimientos)
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

        // logger.info({
        //     layer: "service",
        //     action: "GET_SETTLED_STATEMENTS",
        //     payload: {
        //         dimension,
        //         bancaId,
        //         ventanaId,
        //         vendedorId,
        //         statementsCount: settledStatements.size,
        //         rawStatementsCount: settledStatementsRaw.length,
        //         requiresGrouping,
        //     },
        // });

        return settledStatements;
    } catch (error: any) {
        // logger.error({
        //     layer: "service",
        //     action: "GET_SETTLED_STATEMENTS_ERROR",
        //     payload: {
        //         error: error.message,
        //         dimension,
        //         bancaId,
        //         ventanaId,
        //         vendedorId,
        //     },
        // });
        // Si hay error, retornar Map vacío (se calculará en tiempo real)
        return new Map();
    }
}

/**
 *  OPTIMIZACIÓN: Identifica días que NO están asentados y requieren cálculo completo
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
 *  OPTIMIZACIÓN: Combina estados asentados y calculados en tiempo real
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
        const dateKey = typeof statement.date === 'string' ? statement.date : crDateService.postgresDateToCRString(statement.date);
        combined.set(dateKey, statement);
    }

    // Convertir a array y ordenar
    const result = Array.from(combined.values())
        .filter(stmt => {
            //  CRÍTICO: Asegurar que date sea un objeto Date
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

