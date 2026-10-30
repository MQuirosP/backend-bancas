// src/domain/accounts/engine/statement-accumulator.engine.ts

import { Prisma, Role } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import logger from "../../../core/logger";
import { crDateService } from "../../../utils/crDateService";
import { isExclusionListEmpty } from "../../../core/exclusionListCache";
import { getPreviousMonthFinalBalance } from "../accounts.balances";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { calculateIsSettled } from "../accounts.commissions";
import {
  DayStatement,
  StatementTotals,
  StatementDimension,
} from "./types/statement.types";

export class StatementAccumulatorEngine {
  /**
   * Resuelve el acumulado inicial (initialAccumulated) para un día considerando carry-over
   */
  static resolveInitialAccumulated(params: {
    date: string;
    entityId: string;
    previousDateStr: string;
    previousDateIsDifferentMonth: boolean;
    balanceResetAtDayStr: string | null;
    runningAccumulatedByEntity: Map<string, number>;
    previousDayRemainingBalance: number | null;
    previousMonthBalance: number;
  }): number {
    const {
      date,
      entityId,
      previousDateIsDifferentMonth,
      balanceResetAtDayStr,
      runningAccumulatedByEntity,
      previousDayRemainingBalance,
      previousMonthBalance,
    } = params;

    const runningValue = runningAccumulatedByEntity.get(entityId);

    if (balanceResetAtDayStr && date === balanceResetAtDayStr) {
      return 0;
    } else if (runningValue !== undefined && runningValue !== null && !previousDateIsDifferentMonth) {
      return runningValue;
    } else if (previousDateIsDifferentMonth || runningValue === undefined) {
      if (previousDayRemainingBalance !== null) {
        return previousDayRemainingBalance;
      } else {
        return Number(previousMonthBalance);
      }
    } else {
      return 0;
    }
  }

  /**
   * Calcula monthlyAccumulated (Saldo a Hoy - acumulado desde inicio del mes actual hasta hoy)
   */
  static async calculateMonthlyAccumulated(params: {
    dimension: StatementDimension;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
    allStatementsFromMonth: DayStatement[];
    firstDayOfMonthStr: string;
    effectiveMonth: string;
    daysInMonth: number;
  }): Promise<{
    monthlyAccumulated: StatementTotals;
    monthStartDate: Date;
    monthEndDate: Date;
  }> {
    const {
      dimension,
      bancaId,
      ventanaId,
      vendedorId,
      allStatementsFromMonth,
      firstDayOfMonthStr,
      effectiveMonth,
      daysInMonth,
    } = params;

    let statements = [...allStatementsFromMonth];
    let useAccountStatementForMonthly = false;

    //  NUEVO: Calcular monthlyAccumulated (Saldo a Hoy - acumulado desde inicio del mes hasta hoy)
    // Esto es INMUTABLE respecto al período filtrado (siempre desde el día 1 del mes ACTUAL hasta hoy)
    //  CRÍTICO: monthlyAccumulated SIEMPRE debe calcularse para el mes ACTUAL, no para effectiveMonth
    // Esto es especialmente importante cuando se consulta por "week" que cruza meses
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    const currentMonthStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;

    //  CRÍTICO: Usar el mes ACTUAL para monthlyAccumulated, no effectiveMonth
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
        Prisma.sql`t."businessDate" BETWEEN ${monthStartDateCRStr}::date AND ${monthEndDateCRStr}::date`,
        //  CRÍTICO: Usar EL MISMO filtro de sorteos que la query principal (SOLO EVALUATED)
        // Esto asegura que totals y monthlyAccumulated usen exactamente los mismos datos
        Prisma.sql`EXISTS (
            SELECT 1 FROM "Sorteo" s
            WHERE s.id = t."sorteoId"
            AND s.status = 'EVALUATED'
        )`,
    ];

    // Excluir tickets de listas bloqueadas (solo si hay exclusiones activas)
    if (!await isExclusionListEmpty()) {
        monthlyWhereConditions.push(Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
        )`);
    }

    // Reutilizar filtros RBAC/banca
    if (bancaId) {
        monthlyWhereConditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v
      WHERE v.id = t."ventanaId"
      AND v."bancaId" = CAST(${bancaId} AS uuid)
    )`);
    }

    if (dimension === "vendedor") {
        if (vendedorId) {
            monthlyWhereConditions.push(Prisma.sql`t."vendedorId" = CAST(${vendedorId} AS uuid)`);
        }
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = CAST(${ventanaId} AS uuid)`);
        }
    } else if (dimension === "ventana") {
        if (ventanaId) {
            monthlyWhereConditions.push(Prisma.sql`t."ventanaId" = CAST(${ventanaId} AS uuid)`);
        }
    }

    const monthlyWhereClause = Prisma.sql`WHERE ${Prisma.join(monthlyWhereConditions, " AND ")}`;

    //  OPTIMIZACIÓN: Calcular límite dinámico para query mensual
    // Estimación: ~200 tickets/día × días en mes × 5 jugadas/ticket promedio × 2 (margen seguridad)
    // Mínimo 50000 para mantener compatibilidad
    const monthlyDynamicLimit = Math.max(50000, daysInMonth * 200 * 5 * 2);

    //  OPTIMIZACIÓN CRÍTICA: Intentar usar AccountStatement para calcular monthlyAccumulated
    // Esto es mucho más rápido que recalcular desde tickets (como hace Dashboard)
    useAccountStatementForMonthly = false;
    const monthlyQueryStartTime = Date.now();

    // Verificar si tenemos AccountStatement para todos los días del mes actual
    //  CRÍTICO: Cuando dimension="ventana" sin ventanaId, solo traer statements consolidados de ventanas
    // NO incluir statements de vendedores (vendedorId != null)
    const monthlyStatements = await prisma.accountStatement.findMany({
        where: {
            date: {
                gte: monthStartDate,
                lte: monthEndDate,
            },
            ...(dimension === "banca" && bancaId
                ? { bancaId, ventanaId: null, vendedorId: null }
                : dimension === "banca" && !bancaId
                    ? { bancaId: { not: null }, ventanaId: null, vendedorId: null } //  CRÍTICO: Solo statements consolidados de bancas
                    : dimension === "ventana" && ventanaId
                        ? { ventanaId, vendedorId: null }
                        : dimension === "ventana" && !ventanaId
                            ? { ventanaId: { not: null }, vendedorId: null, bancaId: null } //  CRÍTICO: Solo statements consolidados de ventanas (NO bancas)
                            : dimension === "vendedor" && vendedorId
                                ? { vendedorId, ...(bancaId ? { bancaId } : {}) } //  RBAC: Filtrar por bancaId activa para que una banca no vea datos de otra banca
                                : {}),
        },
        select: {
            date: true,
            totalSales: true,
            totalPayouts: true,
            listeroCommission: true,
            vendedorCommission: true,
            totalPaid: true,
            totalCollected: true,
            remainingBalance: true,
            accumulatedBalance: true, //  CRÍTICO: Usar para monthlyAccumulated.totalRemainingBalance
            ventanaId: true, //  CRÍTICO: Necesario para agrupar por ventana cuando dimension="ventana" sin ventanaId
            vendedorId: true, //  CRÍTICO: Necesario para filtrar statements de vendedores
            bancaId: true, //  CRÍTICO: Necesario para agrupar por banca cuando dimension="banca" sin bancaId
        },
        orderBy: { date: 'asc' },
    });

    //  OPTIMIZACIÓN: Si tenemos statements para el mes, usarlos directamente (mucho más rápido)
    let monthlyTotalSales = 0;
    let monthlyTotalPayouts = 0;
    let monthlyTotalListeroCommission = 0;
    let monthlyTotalVendedorCommission = 0;
    let monthlyTotalPaid = 0;
    let monthlyTotalCollected = 0;
    let monthlySettledDays = 0;
    let monthlyPendingDays = 0;
    let monthlyTotalBalance = 0;
    let monthlyRemainingBalanceFromStatements: number | undefined = undefined; //  CRÍTICO: Declarar aquí para usar más abajo

    //  CORRECCIÓN CRÍTICA: Activar uso de AccountStatement cuando esté disponible y sea confiable
    // Verificar si tenemos statements completos para el mes y si tienen remainingBalance válido
    // Solo usar AccountStatement si:
    // 1. Tenemos statements para el período consultado
    // 2. Los statements tienen remainingBalance válido (no null)
    // 3. El job de asentamiento ya NO corrompe los datos (corregido)
    const expectedDays = Math.ceil((monthEndDate.getTime() - monthStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const hasAllDays = monthlyStatements.length >= expectedDays;
    const allHaveRemainingBalance = monthlyStatements.every(s => s.remainingBalance !== null && s.remainingBalance !== undefined);

    useAccountStatementForMonthly = hasAllDays && allHaveRemainingBalance && monthlyStatements.length > 0;

    //  VALIDACIÓN CRÍTICA: Verificar que los statements sean de la entidad correcta
    // Esto previene mezcla de datos entre entidades (ej: mostrar datos de vendedor en ventana)
    if (monthlyStatements.length > 0) {
        let filteredStatements = monthlyStatements;

        if (dimension === "vendedor" && vendedorId) {
            const wrongStatements = monthlyStatements.filter(s => s.vendedorId !== vendedorId);
            if (wrongStatements.length > 0) {
                logger.error({
                    layer: "service",
                    action: "MONTHLY_STATEMENTS_WRONG_ENTITY_VENDEDOR",
                    payload: {
                        dimension,
                        expectedVendedorId: vendedorId,
                        foundVendedorIds: [...new Set(wrongStatements.map(s => s.vendedorId))],
                        wrongCount: wrongStatements.length,
                        totalCount: monthlyStatements.length
                    }
                });
                filteredStatements = monthlyStatements.filter(s => s.vendedorId === vendedorId);
            }
        } else if (dimension === "ventana" && ventanaId) {
            const wrongStatements = monthlyStatements.filter(s =>
                s.ventanaId !== ventanaId || s.vendedorId !== null
            );
            if (wrongStatements.length > 0) {
                logger.error({
                    layer: "service",
                    action: "MONTHLY_STATEMENTS_WRONG_ENTITY_VENTANA",
                    payload: {
                        dimension,
                        expectedVentanaId: ventanaId,
                        foundVentanaIds: [...new Set(wrongStatements.map(s => s.ventanaId))],
                        wrongCount: wrongStatements.length,
                        totalCount: monthlyStatements.length
                    }
                });
                filteredStatements = monthlyStatements.filter(s =>
                    s.ventanaId === ventanaId && s.vendedorId === null
                );
            }
        } else if (dimension === "banca" && bancaId) {
            const wrongStatements = monthlyStatements.filter(s =>
                s.bancaId !== bancaId || s.ventanaId !== null || s.vendedorId !== null
            );
            if (wrongStatements.length > 0) {
                logger.error({
                    layer: "service",
                    action: "MONTHLY_STATEMENTS_WRONG_ENTITY_BANCA",
                    payload: {
                        dimension,
                        expectedBancaId: bancaId,
                        foundBancaIds: [...new Set(wrongStatements.map(s => s.bancaId))],
                        wrongCount: wrongStatements.length,
                        totalCount: monthlyStatements.length
                    }
                });
                filteredStatements = monthlyStatements.filter(s =>
                    s.bancaId === bancaId && s.ventanaId === null && s.vendedorId === null
                );
            }
        }

        // Reemplazar con statements filtrados
        monthlyStatements.length = 0;
        monthlyStatements.push(...filteredStatements);

        // Recalcular validación después del filtrado
        const expectedDaysAfterFilter = Math.ceil((monthEndDate.getTime() - monthStartDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        const hasAllDaysAfterFilter = monthlyStatements.length >= expectedDaysAfterFilter;
        const allHaveRemainingBalanceAfterFilter = monthlyStatements.every(s => s.remainingBalance !== null && s.remainingBalance !== undefined);
        useAccountStatementForMonthly = hasAllDaysAfterFilter && allHaveRemainingBalanceAfterFilter && monthlyStatements.length > 0;
    }

    if (useAccountStatementForMonthly) {
        //  OPTIMIZACIÓN: Usar AccountStatement directamente (mucho más rápido)
        // logger.info({
        //     layer: "service",
        //     action: "ACCOUNT_STATEMENT_MONTHLY_USED",
        //     payload: {
        //         dimension,
        //         bancaId,
        //         month: currentMonthStr,
        //         statementsCount: monthlyStatements.length,
        //         expectedDays,
        //         note: "Using AccountStatement for monthly totals (optimization)",
        //     },
        // });

        // Sumar totales desde AccountStatement
        monthlyTotalSales = monthlyStatements.reduce((sum, s) => sum + Number(s.totalSales || 0), 0);
        monthlyTotalPayouts = monthlyStatements.reduce((sum, s) => sum + Number(s.totalPayouts || 0), 0);
        monthlyTotalListeroCommission = monthlyStatements.reduce((sum, s) => sum + Number(s.listeroCommission || 0), 0);
        monthlyTotalVendedorCommission = monthlyStatements.reduce((sum, s) => sum + Number(s.vendedorCommission || 0), 0);
        monthlyTotalPaid = monthlyStatements.reduce((sum, s) => sum + Number(s.totalPaid || 0), 0);
        monthlyTotalCollected = monthlyStatements.reduce((sum, s) => sum + Number(s.totalCollected || 0), 0);

        // Contar días saldados
        //  NOTA: Para isSettled, necesitaríamos consultar isSettled desde AccountStatement
        // Por ahora, contar como pending si no tenemos esa info en la query
        monthlySettledDays = 0; // Se podría agregar isSettled al select si es necesario
        monthlyPendingDays = monthlyStatements.length;

        // Calcular monthlyTotalBalance
        const monthlyTotalCommissionToUse = dimension === "vendedor" ? monthlyTotalVendedorCommission : monthlyTotalListeroCommission;
        const monthlyTotalBalanceBase = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalCommissionToUse;
        monthlyTotalBalance = monthlyTotalBalanceBase + monthlyTotalPaid - monthlyTotalCollected;

        //  CRÍTICO: Para monthlyRemainingBalance (Saldo a Hoy), usar accumulatedBalance del último día registrado
        // accumulatedBalance es la fuente de verdad para el saldo acumulado de la entidad
        // - Si dimension="ventana" sin ventanaId (shouldGroupByDate=true): SUMAR accumulatedBalance de todas las ventanas
        // - Si dimension="ventana" con ventanaId: usar accumulatedBalance del último día de esa ventana
        // - Si dimension="vendedor" con vendedorId: usar accumulatedBalance del último día de ese vendedor
        // - Si dimension="banca" sin bancaId: SUMAR accumulatedBalance de todas las bancas
        // - Si dimension="banca" con bancaId: usar accumulatedBalance del último día de esa banca
        //  CRÍTICO: Declarar fuera del bloque para que esté disponible más abajo
        monthlyRemainingBalanceFromStatements = 0;

        if (dimension === "banca" && !bancaId) {
            //  CRÍTICO: Sumar accumulatedBalance de TODAS las bancas (consolidado)
            // Agrupar por bancaId y tomar el último accumulatedBalance de cada una, luego sumar
            const bancasMap = new Map<string, number>();
            for (const stmt of monthlyStatements) {
                if (stmt.bancaId && !stmt.ventanaId && !stmt.vendedorId) {
                    // Tomar el accumulatedBalance más reciente de cada banca (ordenado por date ASC, el último es el más reciente)
                    bancasMap.set(stmt.bancaId, Number(stmt.accumulatedBalance || 0));
                }
            }
            monthlyRemainingBalanceFromStatements = Array.from(bancasMap.values()).reduce((sum, balance) => sum + balance, 0);
        } else if (dimension === "ventana" && !ventanaId) {
            //  CRÍTICO: Sumar accumulatedBalance de TODAS las ventanas (consolidado)
            // Agrupar por ventanaId y tomar el último accumulatedBalance de cada una, luego sumar
            //  CRÍTICO: Excluir statements de bancas (bancaId presente, ventanaId null)
            const ventanasMap = new Map<string, number>();
            for (const stmt of monthlyStatements) {
                if (stmt.ventanaId && !stmt.vendedorId && !stmt.bancaId) {
                    //  CRÍTICO: Solo statements de ventanas (ventanaId presente, vendedorId null, bancaId null)
                    // Tomar el accumulatedBalance más reciente de cada ventana (ordenado por date ASC, el último es el más reciente)
                    ventanasMap.set(stmt.ventanaId, Number(stmt.accumulatedBalance || 0));
                }
            }
            monthlyRemainingBalanceFromStatements = Array.from(ventanasMap.values()).reduce((sum, balance) => sum + balance, 0);
        } else {
            // Para dimension específica (vendedor, ventana con ID, banca con ID), usar accumulatedBalance del último día
            const lastStatementOfMonth = monthlyStatements[monthlyStatements.length - 1];
            monthlyRemainingBalanceFromStatements = Number(lastStatementOfMonth?.accumulatedBalance || 0);
        }

        // logger.info({
        //     layer: "service",
        //     action: "ACCOUNT_STATEMENT_MONTHLY_CALCULATED",
        //     payload: {
        //         dimension,
        //         month: currentMonthStr,
        //         monthlyTotalSales,
        //         monthlyTotalPayouts,
        //         monthlyTotalBalance,
        //         monthlyRemainingBalance: monthlyRemainingBalanceFromStatements,
        //         note: "Calculated from AccountStatement",
        //     },
        // });
    } else if (!useAccountStatementForMonthly) {
        // Fallback: calcular desde tickets (más lento)
        // logger.info({
        //     layer: "service",
        //     action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_START",
        //     payload: {
        //         dimension,
        //         bancaId,
        //         month: currentMonthStr,
        //         monthlyDynamicLimit,
        //         note: "Using tickets calculation (no AccountStatement found)",
        //     },
        // });

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
    --  OPTIMIZACIÓN: Límite dinámico basado en días del mes (evita truncamiento)
    LIMIT ${monthlyDynamicLimit}
  `;

        const monthlyQueryEndTime = Date.now();
        // logger.info({
        //     layer: "service",
        //     action: "ACCOUNT_STATEMENT_MONTHLY_QUERY_END",
        //     payload: {
        //         dimension,
        //         bancaId,
        //         month: currentMonthStr,
        //         rowsReturned: monthlyJugadas.length,
        //         queryTimeMs: monthlyQueryEndTime - monthlyQueryStartTime,
        //     },
        // });

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
                totalTicketsCount: number;
                commissionListero: number;
                commissionVendedor: number;
                payoutTicketsCount: number;
                processedPayoutTicketIds: Set<string>;
            }
        >();

        // Procesar jugadas del mes
        for (const jugada of monthlyJugadas) {
            const commissionListeroFinal = Number(jugada.listero_commission_amount || 0);
            const dateKey = crDateService.postgresDateToCRString(jugada.business_date);
            const key = dimension === "banca"
                ? `${dateKey}_null`
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
                    totalTicketsCount: 0,
                    commissionListero: 0,
                    commissionVendedor: 0,
                    payoutTicketsCount: 0,
                    processedPayoutTicketIds: new Set<string>(),
                };
                monthlyByDateAndDimension.set(key, entry);
            }

            entry.totalSales += jugada.amount;
            entry.totalTicketsCount += 1;
            entry.commissionListero += commissionListeroFinal;
            if (jugada.commission_origin === "USER") {
                entry.commissionVendedor += Number(jugada.commission_amount || 0);
            }
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

        //  NUEVO: Incorporar días que solo tienen movimientos al mapa mensual
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
                        totalTicketsCount: 0,
                        commissionListero: 0,
                        commissionVendedor: 0,
                        payoutTicketsCount: 0,
                        processedPayoutTicketIds: new Set<string>(),
                    });
                }
            }
        }

        // Calcular totales mensuales desde tickets
        monthlyTotalSales = Array.from(monthlyByDateAndDimension.values()).reduce(
            (sum, entry) => sum + entry.totalSales,
            0
        );
        monthlyTotalPayouts = Array.from(monthlyByDateAndDimension.values()).reduce(
            (sum, entry) => sum + entry.totalPayouts,
            0
        );
        monthlyTotalListeroCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
            (sum, entry) => sum + entry.commissionListero,
            0
        );
        monthlyTotalVendedorCommission = Array.from(monthlyByDateAndDimension.values()).reduce(
            (sum, entry) => sum + entry.commissionVendedor,
            0
        );

        // Calcular totales de pagos/cobros del mes
        for (const movements of monthlyMovementsByDate.values()) {
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

        // Calcular monthlyTotalBalance
        const monthlyTotalCommissionToUse = dimension === "vendedor" ? monthlyTotalVendedorCommission : monthlyTotalListeroCommission;
        const monthlyTotalBalanceBase = monthlyTotalSales - monthlyTotalPayouts - monthlyTotalCommissionToUse;
        monthlyTotalBalance = monthlyTotalBalanceBase + monthlyTotalPaid - monthlyTotalCollected;

        // Contar días saldados
        monthlySettledDays = Array.from(monthlyByDateAndDimension.entries())
            .filter(([key, entry]) => {
                const date = key.split("_")[0];
                const allMovements = monthlyMovementsByDate.get(date) || [];
                let movements = allMovements;
                if (dimension === "banca" && bancaId) {
                    movements = allMovements.filter((m: any) => m.bancaId === bancaId);
                } else if (dimension === "ventana") {
                    //  CRÍTICO: Solo movimientos propios de la ventana (vendedorId = null)
                    movements = allMovements.filter((m: any) =>
                        m.ventanaId === entry.ventanaId && (m.vendedorId === null || m.vendedorId === undefined)
                    );
                } else {
                    movements = allMovements.filter((m: any) => m.vendedorId === entry.vendedorId);
                }

                const totalPaid = movements
                    .filter((m: any) => m.type === "payment" && !m.isReversed)
                    .reduce((sum: number, m: any) => sum + m.amount, 0);
                const totalCollected = movements
                    .filter((m: any) => m.type === "collection" && !m.isReversed)
                    .reduce((sum: number, m: any) => sum + m.amount, 0);

                const commission = dimension === "vendedor" ? entry.commissionVendedor : entry.commissionListero;
                const remainingBalance = entry.totalSales - entry.totalPayouts - commission - totalCollected + totalPaid;
                return calculateIsSettled(entry.totalTicketsCount, remainingBalance, totalPaid, totalCollected);
            }).length;
        monthlyPendingDays = monthlyByDateAndDimension.size - monthlySettledDays;
    }

    //  CRÍTICO: Calcular comisión total a usar según dimension (fuera del bloque if)
    const monthlyTotalCommissionToUse = dimension === "vendedor" ? monthlyTotalVendedorCommission : monthlyTotalListeroCommission;

    //  CORRECCIÓN: Calcular remainingBalance según fuente
    let monthlyRemainingBalance: number;
    let previousMonthBalanceNum = 0;

    //  CRÍTICO: Para totalRemainingBalance (Saldo a Hoy), obtener directamente el accumulatedBalance
    // del último día registrado en AccountStatement para la entidad específica DENTRO DEL MES
    // Usa monthStartDate y monthEndDate ya calculadas arriba (líneas ~2972-2975)

    if (dimension === "vendedor" && vendedorId) {
        const lastStatement = await prisma.accountStatement.findFirst({
            where: {
                vendedorId,
                date: { gte: monthStartDate, lte: monthEndDate }
            },
            select: { accumulatedBalance: true },
            orderBy: { date: 'desc' },
        });
        if (lastStatement) {
            monthlyRemainingBalance = Number(lastStatement.accumulatedBalance || 0);
        } else {
            const prev = await getPreviousMonthFinalBalance(currentMonthStr, "vendedor", undefined, vendedorId, undefined);
            monthlyRemainingBalance = Number(prev || 0) + monthlyTotalBalance;
        }
    } else if (dimension === "ventana" && ventanaId) {
        const lastStatement = await prisma.accountStatement.findFirst({
            where: {
                ventanaId,
                vendedorId: null,
                date: { gte: monthStartDate, lte: monthEndDate }
            },
            select: { accumulatedBalance: true },
            orderBy: { date: 'desc' },
        });
        if (lastStatement) {
            monthlyRemainingBalance = Number(lastStatement.accumulatedBalance || 0);
        } else {
            const prev = await getPreviousMonthFinalBalance(currentMonthStr, "ventana", ventanaId, undefined, undefined);
            monthlyRemainingBalance = Number(prev || 0) + monthlyTotalBalance;
        }
    } else if (dimension === "banca" && bancaId) {
        const lastStatement = await prisma.accountStatement.findFirst({
            where: {
                bancaId,
                ventanaId: null,
                vendedorId: null,
                date: { gte: monthStartDate, lte: monthEndDate }
            },
            select: { accumulatedBalance: true },
            orderBy: { date: 'desc' },
        });
        if (lastStatement) {
            monthlyRemainingBalance = Number(lastStatement.accumulatedBalance || 0);
        } else {
            const prev = await getPreviousMonthFinalBalance(currentMonthStr, "banca", undefined, undefined, bancaId);
            monthlyRemainingBalance = Number(prev || 0) + monthlyTotalBalance;
        }
    } else if (dimension === "banca" && !bancaId) {
        // Sumar accumulatedBalance del último día de CADA banca DENTRO DEL MES
        const allBancaIds = await prisma.accountStatement.findMany({
            where: {
                bancaId: { not: null },
                ventanaId: null,
                vendedorId: null,
                date: { gte: monthStartDate, lte: monthEndDate }
            },
            select: { bancaId: true },
            distinct: ['bancaId'],
        });

        let totalAccumulated = 0;
        for (const { bancaId: bId } of allBancaIds) {
            if (bId) {
                const lastStmt = await prisma.accountStatement.findFirst({
                    where: {
                        bancaId: bId,
                        ventanaId: null,
                        vendedorId: null,
                        date: { gte: monthStartDate, lte: monthEndDate }
                    },
                    select: { accumulatedBalance: true },
                    orderBy: { date: 'desc' },
                });
                totalAccumulated += Number(lastStmt?.accumulatedBalance || 0);
            }
        }
        monthlyRemainingBalance = totalAccumulated;
    } else if (dimension === "ventana" && !ventanaId) {
        // Sumar accumulatedBalance del último día de CADA ventana DENTRO DEL MES
        const allVentanaIds = await prisma.accountStatement.findMany({
            where: {
                ventanaId: { not: null },
                vendedorId: null,
                bancaId: null,
                date: { gte: monthStartDate, lte: monthEndDate }
            },
            select: { ventanaId: true },
            distinct: ['ventanaId'],
        });

        let totalAccumulated = 0;
        for (const { ventanaId: vId } of allVentanaIds) {
            if (vId) {
                const lastStmt = await prisma.accountStatement.findFirst({
                    where: {
                        ventanaId: vId,
                        vendedorId: null,
                        date: { gte: monthStartDate, lte: monthEndDate }
                    },
                    select: { accumulatedBalance: true },
                    orderBy: { date: 'desc' },
                });
                totalAccumulated += Number(lastStmt?.accumulatedBalance || 0);
            }
        }
        monthlyRemainingBalance = totalAccumulated;
    } else {
        // Fallback: Si no hay AccountStatement, calcular desde datos base
        const previousMonthBalance = await getPreviousMonthFinalBalance(
            currentMonthStr,
            dimension,
            ventanaId,
            vendedorId,
            bancaId
        );
        previousMonthBalanceNum = Number(previousMonthBalance);
        monthlyRemainingBalance = previousMonthBalanceNum + monthlyTotalBalance;
    }


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


    return {
      monthlyAccumulated,
      monthStartDate,
      monthEndDate,
    };
  }
}
