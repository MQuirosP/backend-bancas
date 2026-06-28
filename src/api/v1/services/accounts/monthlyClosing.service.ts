/**
 * Servicio para cierre mensual de saldos
 * Calcula y guarda el saldo final de cada mes para vendedores, ventanas y bancas
 */

import prisma from "../../../../core/prismaClient";
import { Prisma } from "../../../../generated/prisma/client";
import logger from "../../../../core/logger";
import { crDateService } from "../../../../utils/crDateService";
import { isExclusionListEmpty } from "../../../../core/exclusionListCache";

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
        const whereClause: any = {
            month: closingMonth,
            ...(dimension === "vendedor" && vendedorId ? { vendedorId } : {}),
            ...(dimension === "ventana" && ventanaId ? { ventanaId, vendedorId: null } : {}),
            ...(dimension === "banca" && bancaId ? { bancaId, ventanaId: null, vendedorId: null } : {}),
        };

        const aggregation = await prisma.accountStatement.aggregate({
            where: whereClause,
            _sum: {
                totalSales: true,
                totalPayouts: true,
                vendedorCommission: true,
                listeroCommission: true,
                totalPaid: true,
                totalCollected: true,
                ticketCount: true
            }
        });

        const totalSales = Number(aggregation._sum.totalSales || 0);
        const totalPayouts = Number(aggregation._sum.totalPayouts || 0);
        const totalCommission = dimension === "vendedor"
            ? Number(aggregation._sum.vendedorCommission || 0)
            : Number(aggregation._sum.listeroCommission || 0);
        const totalPaid = Number(aggregation._sum.totalPaid || 0);
        const totalCollected = Number(aggregation._sum.totalCollected || 0);
        const ticketCount = Number(aggregation._sum.ticketCount || 0);

        // Calcular saldo final según comportamiento e historial original
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
        //  CRÍTICO: Prisma no permite null en constraint único del where del upsert
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
