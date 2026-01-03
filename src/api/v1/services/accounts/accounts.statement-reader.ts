import prisma from "../../../../core/prismaClient";
import { AccountStatement } from "@prisma/client";
import logger from "../../../../core/logger";
import { getPreviousMonthFinalBalance } from "./accounts.calculations";

/**
 * ✅ CRÍTICO: Helper para leer AccountStatement del día anterior
 * Esto permite validar y usar datos guardados en lugar de recalcular
 */
export async function getPreviousDayAccountStatement(
    date: string, // YYYY-MM-DD
    dimension: "banca" | "ventana" | "vendedor",
    bancaId?: string,
    ventanaId?: string,
    vendedorId?: string
): Promise<AccountStatement | null> {
    try {
        const [year, month, day] = date.split('-').map(Number);
        const previousDayDate = new Date(Date.UTC(year, month - 1, day));
        previousDayDate.setUTCDate(previousDayDate.getUTCDate() - 1);
        
        let targetBancaId: string | undefined = undefined;
        let targetVentanaId: string | undefined = undefined;
        let targetVendedorId: string | undefined = undefined;
        
        if (dimension === "banca") {
            targetBancaId = bancaId || undefined;
        } else if (dimension === "ventana") {
            targetBancaId = bancaId || undefined;
            targetVentanaId = ventanaId || undefined;
        } else if (dimension === "vendedor") {
            targetBancaId = bancaId || undefined;
            targetVentanaId = ventanaId || undefined;
            targetVendedorId = vendedorId || undefined;
        }
        
        return await prisma.accountStatement.findFirst({
            where: {
                date: previousDayDate,
                bancaId: targetBancaId || null,
                ventanaId: targetVentanaId || null,
                vendedorId: targetVendedorId || null,
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
    } catch (error) {
        logger.warn({
            layer: "service",
            action: "GET_PREVIOUS_DAY_STATEMENT_ERROR",
            payload: {
                date,
                dimension,
                error: (error as Error).message,
            },
        });
        return null;
    }
}

/**
 * ✅ CRÍTICO: Validar que el remainingBalance de un statement sea correcto
 * Esto asegura que podemos confiar en los datos guardados
 */
export function isValidRemainingBalance(
    statement: AccountStatement,
    previousDayStatement: AccountStatement | null,
    previousMonthBalance: number,
    isFirstDay: boolean
): boolean {
    if (statement.remainingBalance === null) {
        return false;
    }
    
    const statementBalance = Number(statement.balance);
    const statementRemainingBalance = Number(statement.remainingBalance);
    
    if (isFirstDay) {
        const expected = previousMonthBalance + statementBalance;
        const isValid = Math.abs(statementRemainingBalance - expected) < 0.01;
        
        if (!isValid) {
            logger.warn({
                layer: "service",
                action: "INVALID_REMAINING_BALANCE_FIRST_DAY",
                payload: {
                    date: statement.date,
                    expected,
                    actual: statementRemainingBalance,
                    previousMonthBalance,
                    balance: statementBalance,
                },
            });
        }
        
        return isValid;
    }
    
    if (!previousDayStatement || previousDayStatement.remainingBalance === null) {
        return false; // No podemos validar sin día anterior
    }
    
    const previousRemainingBalance = Number(previousDayStatement.remainingBalance);
    const expected = previousRemainingBalance + statementBalance;
    const isValid = Math.abs(statementRemainingBalance - expected) < 0.01;
    
    if (!isValid) {
        logger.warn({
            layer: "service",
            action: "INVALID_REMAINING_BALANCE",
            payload: {
                date: statement.date,
                expected,
                actual: statementRemainingBalance,
                previousRemainingBalance,
                balance: statementBalance,
            },
        });
    }
    
    return isValid;
}

/**
 * ✅ CRÍTICO: Leer statement de AccountStatement si existe y es válido
 * Esto evita recalcular cuando los datos ya están guardados
 */
export async function getAccountStatementIfValid(
    date: Date,
    dimension: "banca" | "ventana" | "vendedor",
    bancaId?: string,
    ventanaId?: string,
    vendedorId?: string,
    previousMonthBalance?: number,
    effectiveMonth?: string
): Promise<AccountStatement | null> {
    try {
        let targetBancaId: string | undefined = undefined;
        let targetVentanaId: string | undefined = undefined;
        let targetVendedorId: string | undefined = undefined;
        
        if (dimension === "banca") {
            targetBancaId = bancaId || undefined;
        } else if (dimension === "ventana") {
            targetBancaId = bancaId || undefined;
            targetVentanaId = ventanaId || undefined;
        } else if (dimension === "vendedor") {
            targetBancaId = bancaId || undefined;
            targetVentanaId = ventanaId || undefined;
            targetVendedorId = vendedorId || undefined;
        }
        
        const statement = await prisma.accountStatement.findFirst({
            where: {
                date,
                bancaId: targetBancaId || null,
                ventanaId: targetVentanaId || null,
                vendedorId: targetVendedorId || null,
            },
            orderBy: {
                createdAt: 'desc',
            },
        });
        
        if (!statement) {
            return null; // No existe, hay que calcularlo
        }
        
        // ✅ VALIDAR que el remainingBalance sea correcto
        const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        const [year, month] = dateStr.split('-').map(Number);
        const firstDayOfMonthStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const isFirstDay = dateStr === firstDayOfMonthStr;
        
        // Obtener saldo del mes anterior si es el primer día
        let previousMonthBalanceValue = previousMonthBalance || 0;
        if (isFirstDay && effectiveMonth) {
            if (dimension === "banca") {
                previousMonthBalanceValue = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "banca",
                    undefined,
                    undefined,
                    bancaId || null
                );
            } else if (dimension === "ventana") {
                previousMonthBalanceValue = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "ventana",
                    ventanaId || null,
                    undefined,
                    bancaId
                );
            } else {
                previousMonthBalanceValue = await getPreviousMonthFinalBalance(
                    effectiveMonth,
                    "vendedor",
                    undefined,
                    vendedorId || null,
                    bancaId
                );
            }
        }
        
        // Obtener statement del día anterior si no es el primer día
        const previousDayStatement = isFirstDay 
            ? null 
            : await getPreviousDayAccountStatement(dateStr, dimension, bancaId, ventanaId, vendedorId);
        
        // Validar
        if (isValidRemainingBalance(statement, previousDayStatement, previousMonthBalanceValue, isFirstDay)) {
            // ✅ VÁLIDO: Usar el statement guardado
            return statement;
        }
        
        // ❌ NO VÁLIDO: Retornar null para que se recalcule
        return null;
    } catch (error) {
        logger.error({
            layer: "service",
            action: "GET_ACCOUNT_STATEMENT_IF_VALID_ERROR",
            payload: {
                date,
                dimension,
                error: (error as Error).message,
            },
        });
        return null;
    }
}
