import { Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import { AppError } from "../../../../core/errors";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { calculateDayStatement } from "./accounts.calculations";
import { calculateIsSettled } from "./accounts.commissions";
import { invalidateAccountStatementCache, invalidateBySorteoCache } from "../../../../utils/accountStatementCache";
import { crDateService } from "../../../../utils/crDateService";
import { recalculateMonthlyClosingForDimension } from "./monthlyClosing.service";
import { getPreviousMonthFinalBalance } from "./accounts.balances";
import logger from "../../../../core/logger";

/**
 * Valida y procesa el campo time según especificación del FE
 * 
 * Especificación del FE:
 * - Campo time es opcional en el request
 * - Si está presente, siempre será un string en formato HH:MM válido (ej: "14:30", "09:00")
 * - Si está presente y es válido, debe persistirse exactamente como se recibe
 * - Formato: HH:MM donde HH: 00-23 (dos dígitos), MM: 00-59 (dos dígitos)
 * - Patrón regex: ^([01][0-9]|2[0-3]):[0-5][0-9]$
 * - Si no está presente, usar hora por defecto "00:00"
 * 
 * @param time - Hora en formato HH:MM (siempre válido si viene del FE) o undefined/null
 * @returns Hora en formato HH:MM o "00:00" si no está presente
 * @throws AppError si el formato es inválido (solo para casos edge)
 */
function processTime(time: string | undefined | null): string {
    // Si no está presente, usar hora por defecto según especificación del FE
    if (!time || typeof time !== 'string' || time.trim().length === 0) {
        return "00:00"; // Hora por defecto según especificación
    }

    const trimmed = time.trim();

    // Validar formato HH:MM estricto (según especificación del FE)
    // Patrón: ^([01][0-9]|2[0-3]):[0-5][0-9]$
    const timeRegex = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(trimmed)) {
        // El FE siempre envía formato válido, pero validamos por seguridad
        throw new AppError(
            `Formato de hora inválido: "${trimmed}". Debe ser HH:MM (24 horas, dos dígitos).`,
            400,
            "INVALID_TIME_FORMAT"
        );
    }

    //  CRÍTICO: Persistir exactamente como se recibe (no modificar)
    // El FE siempre envía en formato correcto HH:MM
    return trimmed;
}

/**
 * Registra un pago o cobro
 */
export async function registerPayment(data: {
    date: string; // YYYY-MM-DD
    time?: string; //  OPCIONAL: HH:MM (si no está presente, se usa "00:00" como default según especificación FE)
    ventanaId?: string | null; //  Updated to allow null explicitly
    vendedorId?: string | null; //  Updated to allow null explicitly
    bancaId?: string | null; //  NUEVO: Agregado bancaId
    amount: number;
    type: "payment" | "collection";
    method: "cash" | "transfer" | "check" | "other";
    notes?: string;
    isFinal?: boolean;
    idempotencyKey?: string;
    paidById: string;
    paidByName: string;
}) {
    const paymentDate = new Date(data.date + "T00:00:00.000Z");
    const month = data.date.substring(0, 7); // YYYY-MM

    // Validar idempotencia
    if (data.idempotencyKey) {
        const existing = await AccountPaymentRepository.findByIdempotencyKey(data.idempotencyKey);
        if (existing) {
            (existing as any).cached = true;
            // Obtener el statement actualizado para la respuesta
            let statement: any = undefined;
            if (existing.accountStatementId) {
                statement = await AccountStatementRepository.findById(existing.accountStatementId);
            }
            // Formatear fechas para respuesta
            const paymentForResponse: any = {
                ...existing,
                date: crDateService.postgresDateToCRString(existing.date),
                createdAt: existing.createdAt.toISOString(),
                updatedAt: existing.updatedAt.toISOString(),
                reversedAt: existing.reversedAt ? existing.reversedAt.toISOString() : null,
            };
            if (paymentForResponse.paidBy) delete paymentForResponse.paidBy;
            if (paymentForResponse.accountStatement) delete paymentForResponse.accountStatement;
            if (paymentForResponse.reversedByUser) delete paymentForResponse.reversedByUser;
            let statementForResponse: any = statement ? {
                ...statement,
                date: crDateService.postgresDateToCRString(statement.date),
                createdAt: statement.createdAt.toISOString(),
                updatedAt: statement.updatedAt.toISOString(),
                settledAt: statement.settledAt ? statement.settledAt.toISOString() : null,
            } : undefined;
            return {
                payment: paymentForResponse,
                statement: statementForResponse,
            };
        }
    }

    // Inferir ventanaId y bancaId
    let finalVentanaId = data.ventanaId;
    let finalBancaId: string | undefined = data.bancaId || undefined;

    if (!finalVentanaId && data.vendedorId) {
        const vendedor = await prisma.user.findUnique({
            where: { id: data.vendedorId },
            select: { ventanaId: true },
        });
        if (vendedor?.ventanaId) {
            finalVentanaId = vendedor.ventanaId;
        }
    }

    if (finalVentanaId) {
        const ventana = await prisma.ventana.findUnique({
            where: { id: finalVentanaId },
            select: { bancaId: true },
        });
        if (ventana?.bancaId) {
            finalBancaId = ventana.bancaId;
        }
    }

    // Buscar o crear el AccountStatement de forma segura
    let statement;
    if (data.vendedorId) {
        // Buscar por date y vendedorId (constraint único: date + vendedorId)
        // NO filtrar por ventanaId porque pueden existir statements históricos con ventanaId != null
        statement = await prisma.accountStatement.findFirst({
            where: {
                date: paymentDate,
                vendedorId: data.vendedorId,
            },
        });
        if (!statement) {
            try {
                statement = await prisma.accountStatement.create({
                    data: {
                        date: paymentDate,
                        month,
                        ventanaId: null, // Nuevos statements de vendedor siempre con ventanaId=null
                        vendedorId: data.vendedorId,
                        bancaId: finalBancaId ?? null,
                        ticketCount: 0,
                        totalSales: 0,
                        totalPayouts: 0,
                        listeroCommission: 0,
                        vendedorCommission: 0,
                        balance: 0,
                        totalPaid: 0,
                        totalCollected: 0,
                        remainingBalance: 0,
                        isSettled: false,
                        canEdit: true,
                    },
                });
            } catch (err: any) {
                if (err.code === 'P2002') {
                    // Retry: buscar sin filtro de ventanaId (puede ser statement histórico)
                    statement = await prisma.accountStatement.findFirst({
                        where: {
                            date: paymentDate,
                            vendedorId: data.vendedorId,
                        },
                    });
                } else {
                    throw err;
                }
            }
        }
    } else if (finalVentanaId) {
        // Buscar por date y ventanaId (vendedorId debe ser null)
        statement = await prisma.accountStatement.findFirst({
            where: {
                date: paymentDate,
                ventanaId: finalVentanaId,
                vendedorId: null,
            },
        });
        if (!statement) {
            try {
                statement = await prisma.accountStatement.create({
                    data: {
                        date: paymentDate,
                        month,
                        ventanaId: finalVentanaId,
                        vendedorId: null,
                        bancaId: finalBancaId ?? null,
                        ticketCount: 0,
                        totalSales: 0,
                        totalPayouts: 0,
                        listeroCommission: 0,
                        vendedorCommission: 0,
                        balance: 0,
                        totalPaid: 0,
                        totalCollected: 0,
                        remainingBalance: 0,
                        isSettled: false,
                        canEdit: true,
                    },
                });
            } catch (err: any) {
                if (err.code === 'P2002') {
                    statement = await prisma.accountStatement.findFirst({
                        where: {
                            date: paymentDate,
                            ventanaId: finalVentanaId,
                            vendedorId: null,
                        },
                    });
                } else {
                    throw err;
                }
            }
        }
    } else if (finalBancaId) {
        // NUEVO: Soporte para pagos directos a BANCA (ventanaId=null, vendedorId=null)
        // Buscar por date y bancaId (ventanaId=null, vendedorId=null)
        statement = await prisma.accountStatement.findFirst({
            where: {
                date: paymentDate,
                bancaId: finalBancaId,
                ventanaId: null,
                vendedorId: null,
            },
        });
        if (!statement) {
            try {
                statement = await prisma.accountStatement.create({
                    data: {
                        date: paymentDate,
                        month,
                        bancaId: finalBancaId,
                        ventanaId: null,
                        vendedorId: null,
                        ticketCount: 0,
                        totalSales: 0,
                        totalPayouts: 0,
                        listeroCommission: 0,
                        vendedorCommission: 0,
                        balance: 0,
                        totalPaid: 0,
                        totalCollected: 0,
                        remainingBalance: 0,
                        isSettled: false,
                        canEdit: true,
                    },
                });
            } catch (err: any) {
                if (err.code === 'P2002') {
                    statement = await prisma.accountStatement.findFirst({
                        where: {
                            date: paymentDate,
                            bancaId: finalBancaId,
                            ventanaId: null,
                            vendedorId: null,
                        },
                    });
                } else {
                    throw err;
                }
            }
        }
    }

    if (!statement) {
        throw new AppError("No se pudo obtener o crear el estado de cuenta. Se requiere al menos un ID de Vendedor, Ventana o Banca.", 500, "STATEMENT_NOT_FOUND");
    }

    // Recalcular el statement completo desde tickets para asegurar consistencia
    const dimension: "banca" | "ventana" | "vendedor" = data.vendedorId ? "vendedor" : (finalVentanaId ? "ventana" : "banca");
    const recalculatedStatement = await calculateDayStatement(
        paymentDate,
        month,
        dimension,
        finalVentanaId ?? undefined,
        data.vendedorId ?? undefined,
        finalBancaId,
        "ADMIN"
    );

    // Envolver en transacción: crear pago y actualizar statement
    let payment: any = undefined;
    let updatedStatement: any = undefined;
    let processedTime: string = "00:00";
    await prisma.$transaction(async (tx) => {
        //  CRÍTICO: Obtener estado actual del statement DENTRO de la transacción
        // Esto previene race conditions y asegura que usemos el canal correcto (tx)
        const currentStatement = await tx.accountStatement.findUnique({
            where: { id: statement.id },
            select: {
                id: true,
                date: true,
                vendedorId: true,
                ventanaId: true,
                bancaId: true,
                accumulatedBalance: true
            }
        });

        if (!currentStatement) {
            throw new AppError("Estado de cuenta no encontrado en la transacción", 500, "STATEMENT_TRANSACTION_ERROR");
        }

        // Obtener totales actuales usando el cliente de la transacción
        //  REGLA CRÍTICA: NO usar repositorios globales dentro de tx que usan el prisma global
        const [totalP, totalC] = await Promise.all([
            tx.accountPayment.aggregate({
                where: {
                    accountStatementId: currentStatement.id,
                    isReversed: false,
                    type: "payment",
                    NOT: {
                        OR: [
                            { notes: { contains: 'Saldo arrastrado del mes anterior' } },
                            { method: 'Saldo del mes anterior' }
                        ]
                    }
                },
                _sum: { amount: true }
            }),
            tx.accountPayment.aggregate({
                where: {
                    accountStatementId: currentStatement.id,
                    isReversed: false,
                    type: "collection",
                    NOT: {
                        OR: [
                            { notes: { contains: 'Saldo arrastrado del mes anterior' } },
                            { method: 'Saldo del mes anterior' }
                        ]
                    }
                },
                _sum: { amount: true }
            })
        ]);

        const currentTotalPaid = totalP._sum.amount || 0;
        const currentTotalCollected = totalC._sum.amount || 0;

        const baseBalance = recalculatedStatement.balance;

        // Validar monto
        if (data.type === "payment" && data.amount <= 0) {
            throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
        }
        if (data.type === "collection" && data.amount <= 0) {
            throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
        }

        // Procesar time
        try {
            processedTime = processTime(data.time);
        } catch (error: any) {
            if (error instanceof AppError) throw error;
            throw new AppError(`Error al procesar la hora: ${error.message}`, 400, "TIME_VALIDATION_ERROR");
        }

        // VALIDACIÓN PREVENTIVA: Asegurar integridad de IDs
        if (data.vendedorId && currentStatement.vendedorId !== data.vendedorId) {
            throw new AppError(`Error de integridad: Vendedor mismatch.`, 500, "STATEMENT_VENDEDOR_MISMATCH");
        }

        // 1. Crear el registro de pago
        payment = await tx.accountPayment.create({
            data: {
                accountStatementId: currentStatement.id,
                date: paymentDate,
                month,
                time: processedTime,
                ventanaId: finalVentanaId,
                vendedorId: data.vendedorId,
                bancaId: finalBancaId,
                amount: data.amount,
                type: data.type,
                method: data.method,
                notes: data.notes,
                isFinal: data.isFinal || false,
                idempotencyKey: data.idempotencyKey,
                paidById: data.paidById,
                paidByName: data.paidByName,
            },
        });

        // 2. Calcular nuevos totales operativos
        const newTotalPaid = data.type === "payment" ? currentTotalPaid + data.amount : currentTotalPaid;
        const newTotalCollected = data.type === "collection" ? currentTotalCollected + data.amount : currentTotalCollected;
        //  CRÍTICO: El balance operativo del día (sin acumular)
        const newDayBalance = baseBalance - newTotalCollected + newTotalPaid;

        // 3.  CRÍTICO: Calcular accumulatedBalance ATÓMICAMENTE
        // Obtenemos el balance del día anterior dentro de la transacción de forma segura
        let newAccumulatedBalance = 0;
        const [year, monthNum, dayNum] = data.date.split('-').map(Number);

        if (dayNum === 1) {
            // Primer día del mes: usar saldo del mes anterior
            const prevMonthBalance = await getPreviousMonthFinalBalance(
                month,
                dimension,
                finalVentanaId || undefined,
                data.vendedorId || undefined,
                finalBancaId || undefined
            );
            newAccumulatedBalance = prevMonthBalance + baseBalance - newTotalCollected + newTotalPaid;
        } else {
            // No es el primer día: buscar acumulado del día anterior EXACTO
            const previousDayDate = new Date(Date.UTC(year, monthNum - 1, dayNum - 1));

            const prevStatement = await tx.accountStatement.findFirst({
                where: dimension === "vendedor" && data.vendedorId
                    ? { date: previousDayDate, vendedorId: data.vendedorId }
                    : dimension === "ventana" && finalVentanaId
                        ? { date: previousDayDate, ventanaId: finalVentanaId, vendedorId: null }
                        : { date: previousDayDate, bancaId: finalBancaId, ventanaId: null, vendedorId: null },
                select: { accumulatedBalance: true }
            });

            const prevAccumulated = Number(prevStatement?.accumulatedBalance || 0);

            // Si el día anterior no existe, usamos el saldo del mes como fallback
            if (!prevStatement) {
                const prevMonthBalance = await getPreviousMonthFinalBalance(
                    month,
                    dimension,
                    finalVentanaId || undefined,
                    data.vendedorId || undefined,
                    finalBancaId || undefined
                );
                newAccumulatedBalance = prevMonthBalance + baseBalance - newTotalCollected + newTotalPaid;
            } else {
                newAccumulatedBalance = prevAccumulated + baseBalance - newTotalCollected + newTotalPaid;
            }
        }

        // 4.  CRÍTICO: remainingBalance = accumulatedBalance (saldo acumulativo, NO solo del día)
        // Esto asegura que el saldo mostrado sea el acumulado real desde el mes anterior
        const newRemainingBalance = newAccumulatedBalance;

        // 5. Calcular isSettled usando el saldo acumulado (remainingBalance)
        const isSettled = calculateIsSettled(recalculatedStatement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

        // 6. Actualizar statement con todos los campos calculados
        updatedStatement = await tx.accountStatement.update({
            where: { id: currentStatement.id },
            data: {
                ticketCount: recalculatedStatement.ticketCount,
                totalSales: recalculatedStatement.totalSales,
                totalPayouts: recalculatedStatement.totalPayouts,
                listeroCommission: recalculatedStatement.listeroCommission,
                vendedorCommission: recalculatedStatement.vendedorCommission,
                balance: newDayBalance, //  balance operativo del día (para totales de período)
                totalPaid: newTotalPaid,
                totalCollected: newTotalCollected,
                remainingBalance: newRemainingBalance, //  CORREGIDO: saldo acumulativo
                accumulatedBalance: newAccumulatedBalance, //  Redundante pero explícito
                isSettled,
                canEdit: !isSettled,
            },
        });
    });

    // Validar que statement esté definido (defensivo)
    if (!updatedStatement) {
        // Fallback: Si por alguna razón la transacción no retornó el statement actualizado, obtenerlo de la DB
        updatedStatement = await AccountStatementRepository.findById(statement.id);
    }

    // Validar que payment esté definido (defensivo)
    if (!payment) {
        throw new AppError("Error al registrar el pago: la transacción no retornó el pago creado.", 500, "PAYMENT_CREATION_ERROR");
    }

    //  CRÍTICO: Si se registró un pago/cobro en un mes que ya tiene cierre mensual,
    // recalcular automáticamente el cierre para mantener los saldos actualizados
    const paymentMonth = month;
    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const [currentYear, currentMonth] = nowCRStr.split('-').map(Number);
    const [pYear, pMonth] = paymentMonth.split('-').map(Number);

    if (pYear < currentYear || (pYear === currentYear && pMonth < currentMonth)) {
        Promise.all([
            data.vendedorId ? recalculateMonthlyClosingForDimension(paymentMonth, "vendedor", finalVentanaId || undefined, data.vendedorId, finalBancaId || undefined) : Promise.resolve(),
            finalVentanaId ? recalculateMonthlyClosingForDimension(paymentMonth, "ventana", finalVentanaId, undefined, finalBancaId || undefined) : Promise.resolve(),
            finalBancaId ? recalculateMonthlyClosingForDimension(paymentMonth, "banca", undefined, undefined, finalBancaId) : Promise.resolve(),
        ]).catch((error) => {
            logger.error({ layer: "service", action: "MONTHLY_CLOSING_AUTO_RECALCULATE_ERROR", payload: { paymentId: payment.id, error: error.message } });
        });
    }

    // Invalidar caché
    updateCacheAfterMovement(data.date, finalVentanaId, data.vendedorId, finalBancaId);

    return {
        payment: {
            ...payment,
            date: crDateService.postgresDateToCRString(payment.date),
            createdAt: payment.createdAt.toISOString(),
            updatedAt: payment.updatedAt.toISOString(),
        },
        statement: {
            ...updatedStatement,
            date: crDateService.postgresDateToCRString(updatedStatement.date),
            createdAt: updatedStatement.createdAt.toISOString(),
            updatedAt: updatedStatement.updatedAt.toISOString(),
            settledAt: updatedStatement.settledAt ? updatedStatement.settledAt.toISOString() : null,
        },
    };
}

/**
 * Revierte un pago/cobro
 */
export async function reversePayment(
    payment: Awaited<ReturnType<typeof AccountPaymentRepository.findById>>,
    userId: string,
    reason?: string
) {
    if (!payment) throw new AppError("Pago no encontrado", 404, "PAYMENT_NOT_FOUND");
    if (payment.isReversed) throw new AppError("El pago ya está revertido", 400, "PAYMENT_ALREADY_REVERSED");
    if (reason && reason.length < 5) throw new AppError("El motivo debe tener al menos 5 caracteres", 400, "INVALID_REASON");

    const statement = payment.accountStatement;
    if (!statement) throw new AppError("Estado de cuenta no encontrado", 404, "STATEMENT_NOT_FOUND");

    const dimension: "banca" | "ventana" | "vendedor" = statement.vendedorId ? "vendedor" : (statement.ventanaId ? "ventana" : "banca");
    const paymentDate = new Date(payment.date);
    const month = paymentDate.toISOString().substring(0, 7);
    const dateStr = crDateService.postgresDateToCRString(payment.date);

    const recalculatedStatement = await calculateDayStatement(paymentDate, month, dimension, statement.ventanaId ?? undefined, statement.vendedorId ?? undefined, statement.bancaId ?? undefined, "ADMIN");
    const baseBalance = recalculatedStatement.balance;

    let updatedStatement: any = undefined;
    await prisma.$transaction(async (tx) => {
        const currentStatement = await tx.accountStatement.findUnique({
            where: { id: statement.id },
            select: { id: true, date: true, vendedorId: true, ventanaId: true, bancaId: true, accumulatedBalance: true }
        });

        if (!currentStatement) throw new AppError("Statement not found in tx", 500);

        const [totalP, totalC] = await Promise.all([
            tx.accountPayment.aggregate({
                where: { accountStatementId: currentStatement.id, isReversed: false, type: "payment", NOT: { OR: [{ notes: { contains: 'Saldo arrastrado' } }, { method: 'Saldo del mes anterior' }] } },
                _sum: { amount: true }
            }),
            tx.accountPayment.aggregate({
                where: { accountStatementId: currentStatement.id, isReversed: false, type: "collection", NOT: { OR: [{ notes: { contains: 'Saldo arrastrado' } }, { method: 'Saldo del mes anterior' }] } },
                _sum: { amount: true }
            })
        ]);

        const currentTotalPaid = totalP._sum.amount || 0;
        const currentTotalCollected = totalC._sum.amount || 0;

        await tx.accountPayment.update({
            where: { id: payment.id },
            data: { isReversed: true, reversedAt: new Date(), reversedBy: userId }
        });

        const newTotalPaid = payment.type === "payment" ? currentTotalPaid - payment.amount : currentTotalPaid;
        const newTotalCollected = payment.type === "collection" ? currentTotalCollected - payment.amount : currentTotalCollected;
        //  CRÍTICO: Balance operativo del día (sin acumular)
        const newDayBalance = baseBalance - newTotalCollected + newTotalPaid;

        let newAccumulatedBalance = 0;
        const [year, monthNum, dayNum] = dateStr.split('-').map(Number);

        if (dayNum === 1) {
            const prevMonthBalance = await getPreviousMonthFinalBalance(month, dimension, currentStatement.ventanaId || undefined, currentStatement.vendedorId || undefined, currentStatement.bancaId || undefined);
            newAccumulatedBalance = prevMonthBalance + baseBalance - newTotalCollected + newTotalPaid;
        } else {
            const previousDayDate = new Date(Date.UTC(year, monthNum - 1, dayNum - 1));
            const prevStatement = await tx.accountStatement.findFirst({
                where: dimension === "vendedor" ? { date: previousDayDate, vendedorId: currentStatement.vendedorId } : dimension === "ventana" ? { date: previousDayDate, ventanaId: currentStatement.ventanaId, vendedorId: null } : { date: previousDayDate, bancaId: currentStatement.bancaId, ventanaId: null, vendedorId: null },
                select: { accumulatedBalance: true }
            });

            if (!prevStatement) {
                const prevMonthBalance = await getPreviousMonthFinalBalance(month, dimension, currentStatement.ventanaId || undefined, currentStatement.vendedorId || undefined, currentStatement.bancaId || undefined);
                newAccumulatedBalance = prevMonthBalance + baseBalance - newTotalCollected + newTotalPaid;
            } else {
                newAccumulatedBalance = Number(prevStatement.accumulatedBalance || 0) + baseBalance - newTotalCollected + newTotalPaid;
            }
        }

        //  CRÍTICO: remainingBalance = accumulatedBalance (saldo acumulativo)
        const newRemainingBalance = newAccumulatedBalance;
        const isSettled = calculateIsSettled(recalculatedStatement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

        updatedStatement = await tx.accountStatement.update({
            where: { id: currentStatement.id },
            data: { ticketCount: recalculatedStatement.ticketCount, totalSales: recalculatedStatement.totalSales, totalPayouts: recalculatedStatement.totalPayouts, listeroCommission: recalculatedStatement.listeroCommission, vendedorCommission: recalculatedStatement.vendedorCommission, balance: newDayBalance, totalPaid: newTotalPaid, totalCollected: newTotalCollected, remainingBalance: newRemainingBalance, accumulatedBalance: newAccumulatedBalance, isSettled, canEdit: !isSettled }
        });
    });

    updateCacheAfterMovement(dateStr, statement.ventanaId, statement.vendedorId, statement.bancaId);

    return {
        payment: { ...payment, isReversed: true, reversedAt: new Date().toISOString(), reversedBy: userId, date: dateStr },
        statement: { ...updatedStatement, date: crDateService.postgresDateToCRString(updatedStatement.date), createdAt: updatedStatement.createdAt.toISOString(), updatedAt: updatedStatement.updatedAt.toISOString(), settledAt: updatedStatement.settledAt ? updatedStatement.settledAt.toISOString() : null }
    };
}

/**
 * Helper para invalidar caché después de un movimiento
 */
function updateCacheAfterMovement(date: string, ventanaId?: string | null, vendedorId?: string | null, bancaId?: string | null) {
    Promise.all([
        invalidateAccountStatementCache({ date, ventanaId: ventanaId || null, vendedorId: vendedorId || null }),
        invalidateBySorteoCache({ date, ventanaId: ventanaId || null, vendedorId: vendedorId || null, bancaId: bancaId || null }),
    ]).catch(() => { });
}

/**
 * Elimina un estado de cuenta si no tiene tickets ni pagos
 */
export async function deleteStatement(id: string) {
    const statement = await AccountStatementRepository.findById(id);

    if (!statement) {
        throw new AppError("Estado de cuenta no encontrado", 404, "STATEMENT_NOT_FOUND");
    }

    // Validar que no tenga tickets
    if (statement.ticketCount > 0) {
        throw new AppError("No se puede eliminar un estado de cuenta con tickets", 400, "STATEMENT_HAS_TICKETS");
    }

    // Validar que no tenga pagos activos
    const totalPaid = await AccountPaymentRepository.getTotalPaid(id);
    const totalCollected = await AccountPaymentRepository.getTotalCollected(id);

    if (totalPaid > 0 || totalCollected > 0) {
        throw new AppError("No se puede eliminar un estado de cuenta con pagos o cobros activos", 400, "STATEMENT_HAS_PAYMENTS");
    }

    // Eliminar
    await AccountStatementRepository.delete(id);

    return { success: true };
}
