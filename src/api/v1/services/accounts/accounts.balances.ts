import { Prisma, Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import logger from "../../../../core/logger";
import { getCachedPreviousMonthBalance, setCachedPreviousMonthBalance } from "../../../../utils/accountStatementCache";
import { crDateService } from "../../../../utils/crDateService";

/**
 * Interface para los parámetros de cálculo de saldo anterior desde fuente
 */
interface BalanceFromSourceParams {
    ventanaId?: string | null;
    vendedorId?: string | null;
    bancaId?: string | null;
}

/**
 * Calcula el saldo del mes anterior desde la fuente de verdad (tickets + pagos)
 *  CONTABLEMENTE ROBUSTO: Siempre correcto porque calcula desde datos fuente
 * @param effectiveMonth - Mes actual en formato YYYY-MM
 * @param dimension - 'banca' | 'ventana' | 'vendedor'
 * @param filters - Filtros de dimensión
 * @returns Saldo final del mes anterior calculado desde fuente
 */
async function calculatePreviousMonthBalanceFromSource(
    effectiveMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    filters: BalanceFromSourceParams
): Promise<number> {
    try {
        //  Validar que effectiveMonth sea un string válido
        if (!effectiveMonth || typeof effectiveMonth !== 'string' || !effectiveMonth.includes('-')) {
            logger.warn({
                layer: "service",
                action: "GET_PREVIOUS_MONTH_BALANCE_INVALID_MONTH",
                payload: {
                    effectiveMonth,
                    dimension,
                    ventanaId: filters.ventanaId,
                    vendedorId: filters.vendedorId,
                    bancaId: filters.bancaId,
                    note: "effectiveMonth is invalid, returning 0",
                },
            });
            return 0;
        }

        const [year, month] = effectiveMonth.split("-").map(Number);
        const previousYear = month === 1 ? year - 1 : year;
        const previousMonth = month === 1 ? 12 : month - 1;
        const lastDayOfPreviousMonth = new Date(previousYear, previousMonth, 0).getDate();

        const firstDayCRStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}-01`;
        const lastDayCRStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}-${String(lastDayOfPreviousMonth).padStart(2, '0')}`;

        // Construir condiciones WHERE para tickets
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
        const salesResult = await prisma.$queryRaw<Array<{ total_sales: number }>>`
            SELECT COALESCE(SUM(j.amount), 0) as total_sales
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            ${ticketWhereClause}
            AND j."deletedAt" IS NULL
            AND j."isExcluded" = false
        `;

        // 2. Calcular premios desde tickets
        const payoutsResult = await prisma.$queryRaw<Array<{ total_payouts: number }>>`
            SELECT COALESCE(SUM(t."totalPayout"), 0) as total_payouts
            FROM "Ticket" t
            ${ticketWhereClause}
        `;

        // 3. Calcular comisiones según dimensión
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
        const paymentsWhere: Prisma.AccountPaymentWhereInput = {
            date: {
                gte: new Date(firstDayCRStr + "T00:00:00.000Z"),
                lte: new Date(lastDayCRStr + "T23:59:59.999Z"),
            },
            isReversed: false,
        };

        if (filters.vendedorId) {
            paymentsWhere.vendedorId = filters.vendedorId;
        } else if (filters.ventanaId) {
            paymentsWhere.ventanaId = filters.ventanaId;
        } else if (filters.bancaId) {
            paymentsWhere.bancaId = filters.bancaId;
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

        return remainingBalance;
    } catch (error) {
        logger.error({
            layer: "service",
            action: "PREVIOUS_MONTH_BALANCE_FROM_SOURCE_ERROR",
            payload: { effectiveMonth, dimension, error: error instanceof Error ? error.message : String(error) },
        });
        return 0;
    }
}

/**
 * Obtiene el saldo final del mes anterior para una entidad específica
 */
export async function getPreviousMonthFinalBalance(
    effectiveMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    ventanaId?: string | null,
    vendedorId?: string | null,
    bancaId?: string | null
): Promise<number> {
    try {
        if (!effectiveMonth || typeof effectiveMonth !== 'string' || !effectiveMonth.includes('-')) {
            return 0;
        }

        const [year, month] = effectiveMonth.split("-").map(Number);
        const previousYear = month === 1 ? year - 1 : year;
        const previousMonth = month === 1 ? 12 : month - 1;
        const previousMonthStr = `${previousYear}-${String(previousMonth).padStart(2, '0')}`;

        // PASO 1: Buscar en AccountStatement (fuente de verdad)
        // Priorizar accumulatedBalance del último día del mes anterior
        const lastDayNum = new Date(previousYear, previousMonth, 0).getDate();
        const firstDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, 1, 6, 0, 0, 0));
        const lastDayOfPreviousMonth = new Date(Date.UTC(previousYear, previousMonth - 1, lastDayNum + 1, 5, 59, 59, 999));

        let isConsolidated = false;
        const where: Prisma.AccountStatementWhereInput = {
            date: { gte: firstDayOfPreviousMonth, lte: lastDayOfPreviousMonth },
        };

        if (dimension === "vendedor") {
            if (vendedorId) {
                where.vendedorId = vendedorId;
            } else {
                isConsolidated = true;
                if (ventanaId) where.ventanaId = ventanaId;
                if (bancaId) where.bancaId = bancaId;
            }
        } else if (dimension === "ventana") {
            where.vendedorId = null;
            if (ventanaId) {
                where.ventanaId = ventanaId;
            } else {
                isConsolidated = true;
                if (bancaId) where.bancaId = bancaId;
            }
        } else if (dimension === "banca") {
            where.vendedorId = null;
            where.ventanaId = null;
            if (bancaId) {
                where.bancaId = bancaId;
            } else {
                isConsolidated = true;
            }
        }

        if (!isConsolidated) {
            // Buscar el último statement del mes anterior (sin importar si está asentado)
            const lastStatement = await prisma.accountStatement.findFirst({
                where,
                orderBy: { date: "desc" },
                select: { accumulatedBalance: true },
            });

            if (lastStatement) {
                return Number(lastStatement.accumulatedBalance || 0);
            }
        } else {
            // Para consolidados, sumar los accumulatedBalance del último día de cada entidad
            const statements = await prisma.accountStatement.findMany({
                where,
                orderBy: { date: "desc" },
                distinct: dimension === "vendedor" ? ["vendedorId"] : dimension === "ventana" ? ["ventanaId"] : ["bancaId"],
                select: { accumulatedBalance: true },
            });

            if (statements.length > 0) {
                const total = statements.reduce((sum, s) => sum + Number(s.accumulatedBalance || 0), 0);
                return total;
            }
        }

        // PASO 3: Caché
        const cacheKey = { effectiveMonth, dimension, ventanaId, vendedorId, bancaId };
        const cachedBalance = await getCachedPreviousMonthBalance(cacheKey);
        if (cachedBalance !== null) return cachedBalance;

        // PASO 4: Calcular desde fuente
        const balance = await calculatePreviousMonthBalanceFromSource(effectiveMonth, dimension, { ventanaId, vendedorId, bancaId });
        
        await setCachedPreviousMonthBalance(cacheKey, balance, 300).catch(() => {});
        
        return balance;
    } catch (error) {
        logger.error({
            layer: "service",
            action: "GET_PREVIOUS_MONTH_FINAL_BALANCE_ERROR",
            payload: { effectiveMonth, dimension, error: error instanceof Error ? error.message : String(error) },
        });
        return 0;
    }
}

/**
 * Obtiene los saldos finales del mes anterior para un lote de entidades
 */
export async function getPreviousMonthFinalBalancesBatch(
    effectiveMonth: string,
    dimension: "ventana" | "vendedor",
    entityIds: string[],
    bancaId?: string | null
): Promise<Map<string, number>> {
    const balancesMap = new Map<string, number>();
    
    // Implementación batch real para mejor rendimiento
    // Por simplicidad en este paso usamos el loop, pero en una versión final se debería optimizar con IN queries
    for (const entityId of entityIds) {
        const balance = await getPreviousMonthFinalBalance(
            effectiveMonth,
            dimension,
            dimension === "ventana" ? entityId : null,
            dimension === "vendedor" ? entityId : null,
            bancaId
        );
        balancesMap.set(entityId, balance);
    }
    
    return balancesMap;
}
