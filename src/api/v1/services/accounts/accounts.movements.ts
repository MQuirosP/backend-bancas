import { Role, ActivityType } from "@prisma/client";
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
import { AccountStatementSyncService } from "./accounts.sync.service";
import ActivityService from "../../../../core/activity.service";
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

    // Determinar dimensión para el sync service
    const dimension: "banca" | "ventana" | "vendedor" = data.vendedorId ? "vendedor" : (finalVentanaId ? "ventana" : "banca");
    const entityId = data.vendedorId || finalVentanaId || finalBancaId;

    // Envolver en transacción: crear pago y recalcular statement usando el sync service
    let payment: any = undefined;
    let updatedStatement: any = undefined;
    let processedTime: string = "00:00";
    await prisma.$transaction(async (tx) => {
        //  CRÍTICO: Obtener estado actual del statement DENTRO de la transacción
        const currentStatement = await tx.accountStatement.findUnique({
            where: { id: statement.id },
            select: {
                id: true,
                date: true,
                vendedorId: true,
                ventanaId: true,
                bancaId: true,
            }
        });

        if (!currentStatement) {
            throw new AppError("Estado de cuenta no encontrado en la transacción", 500, "STATEMENT_TRANSACTION_ERROR");
        }



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

        // 2. Usar el sync service para recalcular correctamente el statement
        //    Esto evita la duplicación de lógica y asegura cálculos consistentes
        await AccountStatementSyncService.syncDayStatement(
            paymentDate,
            dimension,
            entityId || undefined,
            { force: true, tx }
        );

        // 3. Obtener el statement actualizado
        updatedStatement = await tx.accountStatement.findUnique({
            where: { id: currentStatement.id }
        });

        if (!updatedStatement) {
            throw new AppError("Error al obtener statement actualizado", 500, "STATEMENT_UPDATE_ERROR");
        }
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

    // CRÍTICO: Propagar cambios a días posteriores si el pago se registró en un día pasado
    // Esto asegura que los accumulatedBalance de días posteriores se actualicen correctamente
    const todayCR = crDateService.dateUTCToCRString(new Date());
    if (data.date < todayCR) {
        try {
            await AccountStatementSyncService.propagateBalanceChange(
                paymentDate,
                dimension,
                entityId || undefined
            );
            logger.info({
                layer: "service",
                action: "PAYMENT_BALANCE_PROPAGATION_SUCCESS",
                payload: {
                    paymentId: payment.id,
                    date: data.date,
                    todayCR,
                    dimension,
                    entityId
                }
            });
        } catch (error) {
            const errorMessage = (error as Error).message;
            logger.error({
                layer: "service",
                action: "PAYMENT_BALANCE_PROPAGATION_ERROR",
                payload: {
                    paymentId: payment.id,
                    date: data.date,
                    dimension,
                    entityId,
                    error: errorMessage,
                    stack: (error as Error).stack
                }
            });

            // CRÍTICO: Registrar en ActivityLog para auditoría empresarial
            try {
                await ActivityService.log({
                    userId: data.paidById,
                    action: ActivityType.ACCOUNT_STATEMENT_VIEW, // Usar el más cercano disponible
                    targetType: "ACCOUNT_PAYMENT",
                    targetId: payment.id,
                    details: {
                        action: "BALANCE_PROPAGATION_ERROR",
                        paymentId: payment.id,
                        date: data.date,
                        dimension,
                        entityId,
                        error: errorMessage,
                        severity: "ERROR",
                        note: "Error en propagación automática de saldos. El pago se registró correctamente pero los saldos posteriores pueden necesitar recálculo manual."
                    },
                    layer: "service",
                });
            } catch (activityLogError) {
                // Si el ActivityLog falla, al menos logear el error doble
                logger.error({
                    layer: "service",
                    action: "ACTIVITY_LOG_FAILED_DURING_PROPAGATION_ERROR",
                    payload: {
                        originalError: errorMessage,
                        activityLogError: (activityLogError as Error).message,
                        paymentId: payment.id
                    }
                });
            }
            // No relanzar el error - el pago se registró correctamente
        }
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
    const dateStr = crDateService.postgresDateToCRString(payment.date);
    const entityId = statement.vendedorId || statement.ventanaId || statement.bancaId;

    let updatedStatement: any = undefined;
    await prisma.$transaction(async (tx) => {
        const currentStatement = await tx.accountStatement.findUnique({
            where: { id: statement.id },
            select: { id: true, date: true, vendedorId: true, ventanaId: true, bancaId: true }
        });

        if (!currentStatement) throw new AppError("Statement not found in tx", 500);

        // 1. Marcar el pago como revertido
        await tx.accountPayment.update({
            where: { id: payment.id },
            data: { isReversed: true, reversedAt: new Date(), reversedBy: userId }
        });

        // 2. Usar el sync service para recalcular correctamente el statement
        //    Esto evita la duplicación de lógica y asegura cálculos consistentes
        await AccountStatementSyncService.syncDayStatement(
            paymentDate,
            dimension,
            entityId || undefined,
            { force: true, tx }
        );

        // 3. Obtener el statement actualizado
        updatedStatement = await tx.accountStatement.findUnique({
            where: { id: currentStatement.id }
        });

        if (!updatedStatement) {
            throw new AppError("Error al obtener statement actualizado después de reversión", 500, "REVERSE_STATEMENT_UPDATE_ERROR");
        }
    });

    // CRÍTICO: Propagar cambios a días posteriores si el pago se revirtió en un día pasado
    // Esto asegura que los accumulatedBalance de días posteriores se actualicen correctamente
    const todayCR = crDateService.dateUTCToCRString(new Date());
    if (dateStr < todayCR) {
        try {
            await AccountStatementSyncService.propagateBalanceChange(
                paymentDate,
                dimension,
                entityId || undefined
            );
            logger.info({
                layer: "service",
                action: "REVERSE_BALANCE_PROPAGATION_SUCCESS",
                payload: {
                    paymentId: payment.id,
                    date: dateStr,
                    todayCR,
                    dimension,
                    entityId
                }
            });
        } catch (error) {
            const errorMessage = (error as Error).message;
            logger.error({
                layer: "service",
                action: "REVERSE_BALANCE_PROPAGATION_ERROR",
                payload: {
                    paymentId: payment.id,
                    date: dateStr,
                    dimension,
                    entityId,
                    error: errorMessage,
                    stack: (error as Error).stack
                }
            });

            // CRÍTICO: Registrar en ActivityLog para auditoría empresarial
            try {
                await ActivityService.log({
                    userId: userId,
                    action: ActivityType.ACCOUNT_PAYMENT_REVERSE, // Más específico para reversiones
                    targetType: "ACCOUNT_PAYMENT",
                    targetId: payment.id,
                    details: {
                        action: "BALANCE_PROPAGATION_ERROR_ON_REVERSE",
                        paymentId: payment.id,
                        date: dateStr,
                        dimension,
                        entityId,
                        error: errorMessage,
                        severity: "ERROR",
                        note: "Error en propagación automática de saldos después de reversión. La reversión se completó correctamente pero los saldos posteriores pueden necesitar recálculo manual."
                    },
                    layer: "service",
                });
            } catch (activityLogError) {
                // Si el ActivityLog falla, al menos logear el error doble
                logger.error({
                    layer: "service",
                    action: "ACTIVITY_LOG_FAILED_DURING_REVERSE_PROPAGATION_ERROR",
                    payload: {
                        originalError: errorMessage,
                        activityLogError: (activityLogError as Error).message,
                        paymentId: payment.id
                    }
                });
            }
            // No relanzar el error - la reversión se completó correctamente
        }
    }

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
