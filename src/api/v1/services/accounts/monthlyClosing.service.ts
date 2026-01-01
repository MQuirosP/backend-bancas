/**
 * Servicio para cierre mensual de saldos
 * Calcula y guarda el saldo final de cada mes para vendedores, ventanas y bancas
 */

import prisma from "../../../../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../../../../core/logger";
import { crDateService } from "../../../../utils/crDateService";

interface MonthBalanceResult {
    remainingBalance: number;
    totalSales: number;
    totalPayouts: number;
    totalCommission: number;
    totalPaid: number;
    totalCollected: number;
    ticketCount: number;
}

/**
 * Calcula el saldo real del mes completo desde la fuente de verdad
 */
export async function calculateRealMonthBalance(
    closingMonth: string, // Formato: "YYYY-MM"
    dimension: "banca" | "ventana" | "vendedor",
    ventanaId?: string | null,
    vendedorId?: string | null,
    bancaId?: string | null
): Promise<MonthBalanceResult> {
    try {
        const [year, month] = closingMonth.split("-").map(Number);
        const lastDayNum = new Date(year, month, 0).getDate();
        
        // Fechas en zona horaria de Costa Rica (UTC-6)
        const firstDay = new Date(Date.UTC(year, month - 1, 1, 6, 0, 0, 0)); // 00:00 CR
        const lastDay = new Date(Date.UTC(year, month - 1, lastDayNum + 1, 5, 59, 59, 999)); // 23:59:59.999 CR
        
        const firstDayCRStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDayCRStr = `${year}-${String(month).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

        // Construir condiciones WHERE para tickets
        const ticketConditions: Prisma.Sql[] = [
            Prisma.sql`t."deletedAt" IS NULL`,
            Prisma.sql`t."isActive" = true`,
            Prisma.sql`t."status" != 'CANCELLED'`,
            Prisma.sql`EXISTS (SELECT 1 FROM "Sorteo" s WHERE s.id = t."sorteoId" AND s.status = 'EVALUATED')`,
            Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${firstDayCRStr}::date`,
            Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${lastDayCRStr}::date`,
        ];

        // Aplicar filtros por dimensión
        if (dimension === "vendedor" && vendedorId) {
            ticketConditions.push(Prisma.sql`t."vendedorId" = ${vendedorId}::uuid`);
        }
        if (dimension === "vendedor" && ventanaId) {
            ticketConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        if (dimension === "ventana" && ventanaId) {
            ticketConditions.push(Prisma.sql`t."ventanaId" = ${ventanaId}::uuid`);
        }
        if (dimension === "banca" && bancaId) {
            ticketConditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "Ventana" v WHERE v.id = t."ventanaId" AND v."bancaId" = ${bancaId}::uuid)`);
        }

        const ticketWhereClause = Prisma.sql`WHERE ${Prisma.join(ticketConditions, " AND ")}`;

        // 1. Ventas (desde jugadas)
        const salesResult = await prisma.$queryRaw<Array<{ total_sales: number; ticket_count: bigint }>>(
            Prisma.sql`
                SELECT 
                    COALESCE(SUM(j.amount), 0) as total_sales,
                    COUNT(DISTINCT t.id)::bigint as ticket_count
                FROM "Ticket" t
                INNER JOIN "Jugada" j ON j."ticketId" = t.id
                ${ticketWhereClause}
                AND j."deletedAt" IS NULL
                AND j."isExcluded" = false
            `
        );

        const totalSales = Number(salesResult[0]?.total_sales || 0);
        const ticketCount = Number(salesResult[0]?.ticket_count || 0);

        // 2. Premios (desde tickets, no jugadas)
        const payoutsResult = await prisma.$queryRaw<Array<{ total_payouts: number }>>(
            Prisma.sql`
                SELECT COALESCE(SUM(t."totalPayout"), 0) as total_payouts
                FROM "Ticket" t
                ${ticketWhereClause}
            `
        );

        const totalPayouts = Number(payoutsResult[0]?.total_payouts || 0);

        // 3. Comisiones
        const commissionField = dimension === "vendedor" ? "USER" : "VENTANA";
        const commissionResult = await prisma.$queryRaw<Array<{ total_commission: number }>>(
            Prisma.sql`
                SELECT 
                    COALESCE(SUM(CASE WHEN j."commissionOrigin" = ${commissionField} THEN j."commissionAmount" ELSE 0 END), 0) as total_commission
                FROM "Ticket" t
                INNER JOIN "Jugada" j ON j."ticketId" = t.id
                ${ticketWhereClause}
                AND j."deletedAt" IS NULL
                AND j."isExcluded" = false
            `
        );

        const totalCommission = Number(commissionResult[0]?.total_commission || 0);

        // 4. Pagos y cobros
        const paymentsWhere: Prisma.AccountPaymentWhereInput = {
            date: {
                gte: firstDay,
                lte: lastDay,
            },
            isReversed: false,
        };

        if (dimension === "vendedor" && vendedorId) {
            paymentsWhere.vendedorId = vendedorId;
        }
        if (dimension === "vendedor" && ventanaId) {
            paymentsWhere.ventanaId = ventanaId;
        }
        if (dimension === "ventana" && ventanaId) {
            paymentsWhere.ventanaId = ventanaId;
            paymentsWhere.vendedorId = null;
        }
        if (dimension === "banca" && bancaId) {
            paymentsWhere.bancaId = bancaId;
            paymentsWhere.vendedorId = null;
            paymentsWhere.ventanaId = null;
        }

        const payments = await prisma.accountPayment.findMany({
            where: paymentsWhere,
            select: {
                type: true,
                amount: true,
            },
        });

        const totalPaid = payments.filter((p) => p.type === "payment").reduce((sum, p) => sum + p.amount, 0);
        const totalCollected = payments.filter((p) => p.type === "collection").reduce((sum, p) => sum + p.amount, 0);

        // 5. Calcular saldo final
        const balance = totalSales - totalPayouts - totalCommission;
        const remainingBalance = balance - totalCollected + totalPaid;

        return {
            remainingBalance: parseFloat(remainingBalance.toFixed(2)),
            totalSales: parseFloat(totalSales.toFixed(2)),
            totalPayouts: parseFloat(totalPayouts.toFixed(2)),
            totalCommission: parseFloat(totalCommission.toFixed(2)),
            totalPaid: parseFloat(totalPaid.toFixed(2)),
            totalCollected: parseFloat(totalCollected.toFixed(2)),
            ticketCount,
        };
    } catch (error: any) {
        logger.error({
            layer: "service",
            action: "CALCULATE_REAL_MONTH_BALANCE_ERROR",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                error: error.message,
            },
        });
        throw error;
    }
}

/**
 * Guarda el saldo de cierre mensual
 */
export async function saveMonthlyClosingBalance(
    closingMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    balance: MonthBalanceResult,
    ventanaId?: string | null,
    vendedorId?: string | null,
    bancaId?: string | null
): Promise<void> {
    try {
        // ✅ CRÍTICO: Prisma no permite null en constraint único del where del upsert
        // Usar findFirst + create/update en su lugar
        const existing = await prisma.monthlyClosingBalance.findFirst({
            where: {
                closingMonth,
                dimension,
                vendedorId: vendedorId || null,
                ventanaId: ventanaId || null,
                bancaId: bancaId || null,
            },
        });

        const data = {
            closingMonth,
            dimension,
            vendedorId: vendedorId || null,
            ventanaId: ventanaId || null,
            bancaId: bancaId || null,
            closingBalance: balance.remainingBalance,
            totalSales: balance.totalSales,
            totalPayouts: balance.totalPayouts,
            totalCommission: balance.totalCommission,
            totalPaid: balance.totalPaid,
            totalCollected: balance.totalCollected,
            ticketCount: balance.ticketCount,
            closingDate: new Date(),
        };

        if (existing) {
            await prisma.monthlyClosingBalance.update({
                where: { id: existing.id },
                data,
            });
        } else {
            await prisma.monthlyClosingBalance.create({
                data,
            });
        }

        logger.info({
            layer: "service",
            action: "MONTHLY_CLOSING_BALANCE_SAVED",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                closingBalance: balance.remainingBalance,
                ticketCount: balance.ticketCount,
            },
        });
    } catch (error: any) {
        logger.error({
            layer: "service",
            action: "SAVE_MONTHLY_CLOSING_BALANCE_ERROR",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                error: error.message,
            },
        });
        throw error;
    }
}

/**
 * Procesa el cierre mensual para todos los vendedores activos
 */
export async function processMonthlyClosingForVendedores(closingMonth: string): Promise<{ success: number; errors: number }> {
    let success = 0;
    let errors = 0;

    try {
        const vendedores = await prisma.user.findMany({
            where: {
                role: "VENDEDOR",
                isActive: true,
                deletedAt: null,
            },
            select: {
                id: true,
                ventanaId: true,
                ventana: {
                    select: {
                        bancaId: true,
                    },
                },
            },
        });

        logger.info({
            layer: "service",
            action: "MONTHLY_CLOSING_START_VENDEDORES",
            payload: {
                closingMonth,
                totalVendedores: vendedores.length,
            },
        });

        for (const vendedor of vendedores) {
            try {
                const balance = await calculateRealMonthBalance(
                    closingMonth,
                    "vendedor",
                    vendedor.ventanaId || undefined,
                    vendedor.id,
                    vendedor.ventana?.bancaId || undefined
                );

                await saveMonthlyClosingBalance(
                    closingMonth,
                    "vendedor",
                    balance,
                    vendedor.ventanaId || undefined,
                    vendedor.id,
                    vendedor.ventana?.bancaId || undefined
                );

                success++;
            } catch (error: any) {
                errors++;
                logger.error({
                    layer: "service",
                    action: "MONTHLY_CLOSING_VENDEDOR_ERROR",
                    payload: {
                        closingMonth,
                        vendedorId: vendedor.id,
                        error: error.message,
                    },
                });
            }
        }

        logger.info({
            layer: "service",
            action: "MONTHLY_CLOSING_COMPLETE_VENDEDORES",
            payload: {
                closingMonth,
                success,
                errors,
            },
        });

        return { success, errors };
    } catch (error: any) {
        logger.error({
            layer: "service",
            action: "MONTHLY_CLOSING_PROCESS_ERROR",
            payload: {
                closingMonth,
                dimension: "vendedor",
                error: error.message,
            },
        });
        throw error;
    }
}

/**
 * Recalcula el cierre mensual para una dimensión específica cuando se detecta un cambio
 * en datos del mes (ej: se registra un pago/cobro después del cierre)
 */
export async function recalculateMonthlyClosingForDimension(
    closingMonth: string,
    dimension: "banca" | "ventana" | "vendedor",
    ventanaId?: string | null,
    vendedorId?: string | null,
    bancaId?: string | null
): Promise<void> {
    try {
        logger.info({
            layer: "service",
            action: "MONTHLY_CLOSING_RECALCULATE_START",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                reason: "data_change_after_closing",
            },
        });

        const balance = await calculateRealMonthBalance(
            closingMonth,
            dimension,
            ventanaId || undefined,
            vendedorId || undefined,
            bancaId || undefined
        );

        await saveMonthlyClosingBalance(
            closingMonth,
            dimension,
            balance,
            ventanaId || undefined,
            vendedorId || undefined,
            bancaId || undefined
        );

        logger.info({
            layer: "service",
            action: "MONTHLY_CLOSING_RECALCULATE_COMPLETE",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                closingBalance: balance.remainingBalance,
            },
        });
    } catch (error: any) {
        logger.error({
            layer: "service",
            action: "MONTHLY_CLOSING_RECALCULATE_ERROR",
            payload: {
                closingMonth,
                dimension,
                ventanaId,
                vendedorId,
                bancaId,
                error: error.message,
            },
        });
        // No lanzar error, solo loguear - no queremos bloquear la creación del pago
    }
}
