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
    
    // ✅ CRÍTICO: Persistir exactamente como se recibe (no modificar)
    // El FE siempre envía en formato correcto HH:MM
    return trimmed;
}

/**
 * Registra un pago o cobro
 */
export async function registerPayment(data: {
    date: string; // YYYY-MM-DD
    time?: string; // ✅ OPCIONAL: HH:MM (si no está presente, se usa "00:00" como default según especificación FE)
    ventanaId?: string;
    vendedorId?: string;
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
    let finalBancaId: string | undefined;

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
        // Buscar por date y vendedorId (ventanaId debe ser null)
        statement = await prisma.accountStatement.findFirst({
            where: {
                date: paymentDate,
                vendedorId: data.vendedorId,
                ventanaId: null,
            },
        });
        if (!statement) {
            try {
                statement = await prisma.accountStatement.create({
                    data: {
                        date: paymentDate,
                        month,
                        ventanaId: null,
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
                    statement = await prisma.accountStatement.findFirst({
                        where: {
                            date: paymentDate,
                            vendedorId: data.vendedorId,
                            ventanaId: null,
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
    }
    if (!statement) {
        throw new AppError("No se pudo obtener o crear el estado de cuenta", 500, "STATEMENT_NOT_FOUND");
    }

    // Recalcular el statement completo desde tickets para asegurar consistencia
    const dimension: "ventana" | "vendedor" = finalVentanaId ? "ventana" : "vendedor";
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
    let processedTime: string = "00:00";
    await prisma.$transaction(async (tx) => {
        // Obtener totales actuales
        const [currentTotalPaid, currentTotalCollected] = await Promise.all([
            AccountPaymentRepository.getTotalPaid(statement.id),
            AccountPaymentRepository.getTotalCollected(statement.id),
        ]);

        const baseBalance = recalculatedStatement.balance;
        const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

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

        // Crear pago
        payment = await tx.accountPayment.create({
            data: {
                accountStatementId: statement.id,
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

        // Calcular nuevos totales
        const newTotalPaid = data.type === "payment" ? currentTotalPaid + data.amount : currentTotalPaid;
        const newTotalCollected = data.type === "collection" ? currentTotalCollected + data.amount : currentTotalCollected;
        const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;
        const isSettled = calculateIsSettled(recalculatedStatement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

        // Actualizar statement
        await tx.accountStatement.update({
            where: { id: statement.id },
            data: {
                ticketCount: recalculatedStatement.ticketCount,
                totalSales: recalculatedStatement.totalSales,
                totalPayouts: recalculatedStatement.totalPayouts,
                listeroCommission: recalculatedStatement.listeroCommission,
                vendedorCommission: recalculatedStatement.vendedorCommission,
                balance: baseBalance,
                totalPaid: newTotalPaid,
                totalCollected: newTotalCollected,
                remainingBalance: newRemainingBalance,
                isSettled,
                canEdit: !isSettled,
            },
        });
    });
    // ...existing code for post-save time-fix, sync, cache, response...

    // ...existing code for post-save time-fix, sync, cache, response...

    // ✅ Obtener totales actuales de movimientos (antes de agregar el nuevo)
    const [currentTotalPaid, currentTotalCollected] = await Promise.all([
        AccountPaymentRepository.getTotalPaid(statement.id),
        AccountPaymentRepository.getTotalCollected(statement.id),
    ]);

    // Usar balance recalculado desde tickets (ya incluye totalSales, totalPayouts, comisiones)
    const baseBalance = recalculatedStatement.balance;
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    // COBRO (banca cobra al listero): RESTA del saldo del listero
    // PAGO (banca paga al listero): SUMA al saldo del listero
    const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

    // Validar monto según el tipo de movimiento
    // Los movimientos solo afectan remainingBalance, no balance
    // Se permite registrar cualquier movimiento mientras el statement no esté saldado
    // El usuario puede seleccionar libremente el tipo (payment o collection)
    if (data.type === "payment") {
        // Payment: suma al remainingBalance (reduce CxP o aumenta CxC)
        // Efecto: newRemainingBalance = currentRemainingBalance + amount
        // Validar que el monto sea positivo
        if (data.amount <= 0) {
            throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
        }
    } else if (data.type === "collection") {
        // Collection: resta del remainingBalance (reduce CxC o aumenta CxP)
        // Efecto: newRemainingBalance = currentRemainingBalance - amount
        // Validar que el monto sea positivo
        if (data.amount <= 0) {
            throw new AppError("El monto debe ser positivo", 400, "INVALID_AMOUNT");
        }
    }

    // ✅ CRÍTICO: Procesar el campo time según especificación del FE
    // El FE siempre envía formato válido HH:MM si está presente
    // Si no está presente, usar "00:00" como default
    // processedTime is already declared above
    try {
        processedTime = processTime(data.time);
    } catch (error: any) {
        // Si hay error de validación, propagarlo
        if (error instanceof AppError) throw error;
        throw new AppError(
            `Error al procesar la hora: ${error.message}`,
            400,
            "TIME_VALIDATION_ERROR"
        );
    }

    // ✅ CRÍTICO: Crear pago con ventanaId, vendedorId y bancaId correctos
    // El repository también inferirá si es necesario, pero aquí ya los tenemos correctos
    // de la inferencia previa que se hizo para el AccountStatement
    // ⚠️ IMPORTANTE: Pasar time explícitamente (nunca undefined) para asegurar que se guarde
    payment = await AccountPaymentRepository.create({
        accountStatementId: statement.id,
        date: paymentDate,
        month,
        time: processedTime, // ✅ CRÍTICO: Siempre string (HH:MM), nunca undefined/null según especificación FE
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
    });

    // ✅ CRÍTICO: Si se registró un pago/cobro en un mes que ya tiene cierre mensual,
    // recalcular automáticamente el cierre para mantener los saldos actualizados
    // Esto se hace de forma asíncrona para no bloquear la creación del pago
    const paymentMonth = month; // month ya está en formato "YYYY-MM"
    const nowCRStr = crDateService.dateUTCToCRString(new Date());
    const [currentYear, currentMonth] = nowCRStr.split('-').map(Number);
    const paymentMonthYear = parseInt(paymentMonth.split('-')[0]);
    const paymentMonthNum = parseInt(paymentMonth.split('-')[1]);
    
    // Verificar si el mes del pago es anterior al mes actual (ya cerrado)
    const isPastMonth = paymentMonthYear < currentYear || 
                       (paymentMonthYear === currentYear && paymentMonthNum < currentMonth);
    
    if (isPastMonth) {
        // Recalcular cierre mensual de forma asíncrona (no bloquear)
        Promise.all([
            // Recalcular para vendedor si aplica
            data.vendedorId ? recalculateMonthlyClosingForDimension(
                paymentMonth,
                "vendedor",
                finalVentanaId || undefined,
                data.vendedorId,
                finalBancaId || undefined
            ) : Promise.resolve(),
            
            // Recalcular para ventana si aplica
            finalVentanaId ? recalculateMonthlyClosingForDimension(
                paymentMonth,
                "ventana",
                finalVentanaId,
                undefined,
                finalBancaId || undefined
            ) : Promise.resolve(),
            
            // Recalcular para banca si aplica
            finalBancaId ? recalculateMonthlyClosingForDimension(
                paymentMonth,
                "banca",
                undefined,
                undefined,
                finalBancaId
            ) : Promise.resolve(),
        ]).catch((error) => {
            // Log error pero no bloquear
            logger.error({
                layer: "service",
                action: "MONTHLY_CLOSING_AUTO_RECALCULATE_ERROR",
                payload: {
                    paymentId: payment.id,
                    paymentMonth,
                    error: error.message,
                },
            });
        });
    }

    // ✅ CRÍTICO: Verificar post-guardado que time se guardó correctamente
    // El FE siempre envía time (o no lo envía, en cuyo caso usamos "00:00")
    // Si no se guardó, actualizar inmediatamente (no lanzar error, el usuario no tiene la culpa)
    if (payment.time !== processedTime) {
        logger.warn({
            layer: 'service',
            action: 'PAYMENT_TIME_MISMATCH_RETRY',
            payload: {
                paymentId: payment.id,
                expectedTime: processedTime,
                actualTime: payment.time,
                originalTime: data.time,
            },
        });
        
        // ⚠️ CRÍTICO: Si el time no se guardó, actualizar inmediatamente
        // El FE siempre envía time válido o no lo envía (usamos "00:00"), así que debe guardarse SIEMPRE
        // No lanzamos error porque el usuario no tiene la culpa, es un bug del sistema
        try {
            const updatedPayment = await prisma.accountPayment.update({
                where: { id: payment.id },
                data: { time: processedTime },
            });
            
            logger.info({
                layer: 'service',
                action: 'PAYMENT_TIME_UPDATED',
                payload: {
                    paymentId: payment.id,
                    time: updatedPayment.time,
                },
            });
            
            // Actualizar el objeto payment para que tenga el time correcto en la respuesta
            payment.time = updatedPayment.time;
        } catch (updateError: any) {
            // Si falla la actualización, loggear error crítico
            // Esto es un bug del sistema que debe investigarse
            logger.error({
                layer: 'service',
                action: 'PAYMENT_TIME_UPDATE_FAILED',
                payload: {
                    paymentId: payment.id,
                    expectedTime: processedTime,
                    error: updateError.message,
                },
            });
            // ⚠️ No lanzamos error al usuario, pero loggeamos para investigar el bug
        }
    }

    // ✅ OPTIMIZACIÓN: Calcular nuevos totales directamente sin consultar la BD nuevamente
    // Ya sabemos los totales actuales, solo sumamos el nuevo pago/cobro
    const newTotalPaid = data.type === "payment" 
        ? currentTotalPaid + data.amount 
        : currentTotalPaid;
    const newTotalCollected = data.type === "collection"
        ? currentTotalCollected + data.amount
        : currentTotalCollected;

    // Fórmula: remainingBalance = balance - totalCollected + totalPaid
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;

    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    // Usar ticketCount del statement recalculado para asegurar consistencia
    const isSettled = calculateIsSettled(recalculatedStatement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ CRÍTICO: Actualizar statement con valores de tickets (desde recalculatedStatement) + movimientos
    // NOTA: accumulatedBalance se actualizará después mediante syncDayStatement para mantener consistencia
    const updatedStatement = await AccountStatementRepository.update(statement.id, {
        // Valores de tickets (recalculados desde tickets/jugadas)
        ticketCount: recalculatedStatement.ticketCount,
        totalSales: recalculatedStatement.totalSales,
        totalPayouts: recalculatedStatement.totalPayouts,
        listeroCommission: recalculatedStatement.listeroCommission,
        vendedorCommission: recalculatedStatement.vendedorCommission,
        balance: baseBalance, // Balance desde tickets (sin movimientos)
        // Valores de movimientos (actualizados con el nuevo movimiento)
        totalPaid: newTotalPaid,
        totalCollected: newTotalCollected,
        remainingBalance: newRemainingBalance,
        // ⚠️ NOTA: accumulatedBalance se actualizará después mediante syncDayStatement
        isSettled,
        canEdit: !isSettled,
    });

    // ✅ CRÍTICO: Sincronizar accumulatedBalance después de registrar el pago
    // Esto asegura que accumulatedBalance se mantenga correcto y actualizado
    try {
      const { AccountStatementSyncService } = await import('./accounts.sync.service');
      const paymentDateUTC = new Date(Date.UTC(
        parseInt(data.date.split('-')[0]),
        parseInt(data.date.split('-')[1]) - 1,
        parseInt(data.date.split('-')[2]),
        0, 0, 0, 0
      ));

      // Sincronizar statement de vendedor (si hay vendedorId)
      if (data.vendedorId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "vendedor",
          data.vendedorId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_PAYMENT_ERROR_VENDEDOR",
            payload: {
              paymentId: payment.id,
              date: data.date,
              vendedorId: data.vendedorId,
              error: (error as Error).message,
            },
          });
        });
      }

      // Sincronizar statement consolidado de ventana (si hay ventanaId)
      if (finalVentanaId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "ventana",
          finalVentanaId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_PAYMENT_ERROR_VENTANA",
            payload: {
              paymentId: payment.id,
              date: data.date,
              ventanaId: finalVentanaId,
              error: (error as Error).message,
            },
          });
        });
      }

      // Sincronizar statement consolidado de banca (si hay bancaId)
      if (finalBancaId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "banca",
          finalBancaId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_PAYMENT_ERROR_BANCA",
            payload: {
              paymentId: payment.id,
              date: data.date,
              bancaId: finalBancaId,
              error: (error as Error).message,
            },
          });
        });
      }
    } catch (error) {
      // No bloquear la creación del pago si falla la sincronización
      logger.error({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_AFTER_PAYMENT_IMPORT_ERROR",
        payload: {
          paymentId: payment.id,
          date: data.date,
          error: (error as Error).message,
        },
      });
    }

    // ✅ OPTIMIZACIÓN: Invalidar caché de estados de cuenta y bySorteo para este día
    const dateStr = data.date; // Ya está en formato YYYY-MM-DD
    Promise.all([
        invalidateAccountStatementCache({
            date: dateStr,
            ventanaId: finalVentanaId || null,
            vendedorId: data.vendedorId || null,
        }),
        invalidateBySorteoCache({
            date: dateStr,
            ventanaId: finalVentanaId || null,
            vendedorId: data.vendedorId || null,
            bancaId: finalBancaId || null,
        }),
    ]).catch(() => {
        // Ignorar errores de invalidación de caché
    });

    // ✅ OPTIMIZACIÓN: Construir statement para respuesta (evita query adicional)
    // Ya tenemos todos los datos actualizados en updatedStatement
    // Las relaciones (ventana, vendedor) no son críticas para la respuesta, el FE puede obtenerlas del statement completo si las necesita
    
    // ✅ CRÍTICO: Formatear fechas a strings YYYY-MM-DD para el frontend
    const statementForResponse: any = {
        ...updatedStatement,
        date: crDateService.postgresDateToCRString(updatedStatement.date), // Convertir Date a YYYY-MM-DD
        // month ya es string YYYY-MM, no necesita conversión
        createdAt: updatedStatement.createdAt.toISOString(),
        updatedAt: updatedStatement.updatedAt.toISOString(),
        // settledAt puede ser null, formatear solo si existe
        settledAt: updatedStatement.settledAt ? updatedStatement.settledAt.toISOString() : null,
    };

    // ✅ CRÍTICO: Formatear payment para respuesta (fechas a strings)
    const paymentForResponse: any = {
        ...payment,
        date: crDateService.postgresDateToCRString(payment.date), // Convertir Date a YYYY-MM-DD
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
        reversedAt: payment.reversedAt ? payment.reversedAt.toISOString() : null,
        // Eliminar relaciones anidadas si existen (paidBy, accountStatement, etc.)
        // El FE no las necesita en la respuesta (ya las tiene del statement)
        paidBy: undefined,
        accountStatement: undefined,
        reversedByUser: undefined,
    };
    // Limpiar campos undefined
    delete paymentForResponse.paidBy;
    delete paymentForResponse.accountStatement;
    delete paymentForResponse.reversedByUser;

    return {
        payment: paymentForResponse,
        statement: statementForResponse,
    };
}

/**
 * Revierte un pago/cobro
 * CRÍTICO: No permite revertir si el día quedaría saldado (saldo = 0)
 * 
 * @param payment - El pago a revertir (ya obtenido del repositorio)
 * @param userId - ID del usuario que revierte el pago
 * @param reason - Motivo opcional de la reversión
 */
export async function reversePayment(
    payment: Awaited<ReturnType<typeof AccountPaymentRepository.findById>>,
    userId: string,
    reason?: string
) {
    if (!payment) {
        throw new AppError("Pago no encontrado", 404, "PAYMENT_NOT_FOUND");
    }

    if (payment.isReversed) {
        throw new AppError("El pago ya está revertido", 400, "PAYMENT_ALREADY_REVERSED");
    }

    // Validar motivo si se proporciona
    if (reason && reason.length < 5) {
        throw new AppError("El motivo de reversión debe tener al menos 5 caracteres", 400, "INVALID_REASON");
    }

    // ✅ OPTIMIZACIÓN: Usar el statement ya incluido en el payment en lugar de findOrCreate
    // El payment siempre tiene accountStatement porque viene de findById con include
    if (!payment.accountStatement) {
        throw new AppError("Estado de cuenta no encontrado para este pago", 404, "STATEMENT_NOT_FOUND");
    }
    
    const statement = payment.accountStatement;

    // ✅ CRÍTICO: Recalcular el statement completo desde tickets ANTES de revertir el movimiento
    // Esto asegura que ticketCount, totalSales, totalPayouts, comisiones, etc. estén siempre correctos
    const dimension: "ventana" | "vendedor" = statement.ventanaId ? "ventana" : "vendedor";
    const paymentDate = new Date(payment.date);
    const month = paymentDate.toISOString().substring(0, 7); // YYYY-MM

    // Recalcular statement completo desde tickets para asegurar consistencia
    const recalculatedStatement = await calculateDayStatement(
        paymentDate,
        month,
        dimension,
        statement.ventanaId ?? undefined,
        statement.vendedorId ?? undefined,
        statement.bancaId ?? undefined,
        "ADMIN" // Usar ADMIN para permitir ver todos los datos
    );

    // Usar balance recalculado desde tickets (ya incluye totalSales, totalPayouts, comisiones)
    const baseBalance = recalculatedStatement.balance;

    // ✅ OPTIMIZACIÓN: Obtener totales actuales en paralelo
    const [currentTotalPaid, currentTotalCollected] = await Promise.all([
        AccountPaymentRepository.getTotalPaid(statement.id),
        AccountPaymentRepository.getTotalCollected(statement.id),
    ]);

    // Calcular saldo actual (con todos los pagos activos)
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

    // Calcular saldo después de revertir este pago
    let balanceAfterReversal: number;
    if (payment.type === "payment") {
        // Si es un pago, al revertirlo se suma al saldo (se quita el pago)
        balanceAfterReversal = currentRemainingBalance + payment.amount;
    } else {
        // Si es un cobro, al revertirlo se resta del saldo (se quita el cobro)
        balanceAfterReversal = currentRemainingBalance - payment.amount;
    }

    // CRÍTICO: Validar que el día NO quede saldado
    // FIX: Validar usando la misma lógica que isSettled (incluye hasPayments)
    // Después de revertir, si no quedan pagos activos, no debería quedar saldado
    const remainingPaymentsAfterReversal =
        (payment.type === "payment" ? currentTotalPaid - payment.amount : currentTotalPaid) +
        (payment.type === "collection" ? currentTotalCollected - payment.amount : currentTotalCollected);
    const hasPaymentsAfterReversal = remainingPaymentsAfterReversal > 0;
    const absBalance = Math.abs(balanceAfterReversal);

    // No permitir revertir si quedaría saldado (balance ≈ 0 Y hay pagos restantes)
    if (absBalance <= 0.01 && hasPaymentsAfterReversal) {
        throw new AppError(
            "No se puede revertir este pago porque el día quedaría saldado. El saldo resultante sería cero o muy cercano a cero.",
            400,
            "CANNOT_REVERSE_SETTLED_DAY"
        );
    }

    // Revertir pago
    const reversed = await AccountPaymentRepository.reverse(payment.id, userId);

    // ✅ OPTIMIZACIÓN: Calcular nuevos totales directamente sin consultar la BD nuevamente
    // Ya sabemos los totales actuales, solo restamos el pago/cobro revertido
    const newTotalPaid = payment.type === "payment"
        ? currentTotalPaid - payment.amount
        : currentTotalPaid;
    const newTotalCollected = payment.type === "collection"
        ? currentTotalCollected - payment.amount
        : currentTotalCollected;

    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;

    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    // Usar ticketCount del statement recalculado para asegurar consistencia
    const isSettled = calculateIsSettled(recalculatedStatement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ CRÍTICO: Actualizar statement con valores de tickets (desde recalculatedStatement) + movimientos
    const updatedStatement = await AccountStatementRepository.update(statement.id, {
        // Valores de tickets (recalculados desde tickets/jugadas)
        ticketCount: recalculatedStatement.ticketCount,
        totalSales: recalculatedStatement.totalSales,
        totalPayouts: recalculatedStatement.totalPayouts,
        listeroCommission: recalculatedStatement.listeroCommission,
        vendedorCommission: recalculatedStatement.vendedorCommission,
        balance: baseBalance, // Balance desde tickets (sin movimientos)
        // Valores de movimientos (actualizados con el movimiento revertido)
        totalPaid: newTotalPaid,
        totalCollected: newTotalCollected,
        remainingBalance: newRemainingBalance,
        isSettled,
        canEdit: !isSettled,
    });

    // ✅ CRÍTICO: Sincronizar accumulatedBalance después de revertir el pago
    // Esto asegura que accumulatedBalance se mantenga correcto y actualizado
    try {
      const { AccountStatementSyncService } = await import('./accounts.sync.service');
      const paymentDateUTC = payment.date; // Ya es Date UTC que representa día calendario en CR

      // Sincronizar statement de vendedor (si hay vendedorId)
      if (payment.vendedorId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "vendedor",
          payment.vendedorId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_REVERSE_ERROR_VENDEDOR",
            payload: {
              paymentId: payment.id,
              date: crDateService.postgresDateToCRString(payment.date),
              vendedorId: payment.vendedorId,
              error: (error as Error).message,
            },
          });
        });
      }

      // Sincronizar statement consolidado de ventana (si hay ventanaId)
      if (payment.ventanaId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "ventana",
          payment.ventanaId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_REVERSE_ERROR_VENTANA",
            payload: {
              paymentId: payment.id,
              date: crDateService.postgresDateToCRString(payment.date),
              ventanaId: payment.ventanaId,
              error: (error as Error).message,
            },
          });
        });
      }

      // Sincronizar statement consolidado de banca (si hay bancaId)
      if (payment.bancaId) {
        await AccountStatementSyncService.syncDayStatement(
          paymentDateUTC,
          "banca",
          payment.bancaId,
          { force: true }
        ).catch((error) => {
          logger.warn({
            layer: "service",
            action: "SYNC_DAY_STATEMENT_AFTER_REVERSE_ERROR_BANCA",
            payload: {
              paymentId: payment.id,
              date: crDateService.postgresDateToCRString(payment.date),
              bancaId: payment.bancaId,
              error: (error as Error).message,
            },
          });
        });
      }
    } catch (error) {
      // No bloquear la reversión del pago si falla la sincronización
      logger.error({
        layer: "service",
        action: "SYNC_DAY_STATEMENT_AFTER_REVERSE_IMPORT_ERROR",
        payload: {
          paymentId: payment.id,
          date: crDateService.postgresDateToCRString(payment.date),
          error: (error as Error).message,
        },
      });
    }

    // ✅ OPTIMIZACIÓN: Invalidar caché de estados de cuenta y bySorteo para este día
    const dateStr = crDateService.postgresDateToCRString(payment.date);
    Promise.all([
        invalidateAccountStatementCache({
            date: dateStr,
            ventanaId: payment.ventanaId || null,
            vendedorId: payment.vendedorId || null,
        }),
        invalidateBySorteoCache({
            date: dateStr,
            ventanaId: payment.ventanaId || null,
            vendedorId: payment.vendedorId || null,
            bancaId: payment.bancaId || null,
        }),
    ]).catch(() => {
        // Ignorar errores de invalidación de caché
    });

    // ✅ OPTIMIZACIÓN: Construir statement completo para respuesta (evita query adicional)
    // Ya tenemos todos los datos, solo combinamos con las relaciones del statement original
    // El statement viene de payment.accountStatement que no incluye relaciones, así que las omitimos
    // El FE puede obtenerlas del statement original si las necesita
    
    // ✅ CRÍTICO: Formatear fechas a strings YYYY-MM-DD para el frontend
    const statementForResponse: any = {
        ...updatedStatement,
        date: crDateService.postgresDateToCRString(updatedStatement.date), // Convertir Date a YYYY-MM-DD
        // month ya es string YYYY-MM, no necesita conversión
        createdAt: updatedStatement.createdAt.toISOString(),
        updatedAt: updatedStatement.updatedAt.toISOString(),
        // settledAt puede ser null, formatear solo si existe
        settledAt: updatedStatement.settledAt ? updatedStatement.settledAt.toISOString() : null,
    };

    // ✅ CRÍTICO: Formatear payment para respuesta (fechas a strings)
    const reversedForResponse: any = {
        ...reversed,
        date: crDateService.postgresDateToCRString(reversed.date), // Convertir Date a YYYY-MM-DD
        createdAt: reversed.createdAt.toISOString(),
        updatedAt: reversed.updatedAt.toISOString(),
        reversedAt: reversed.reversedAt ? reversed.reversedAt.toISOString() : null,
        // Eliminar relaciones anidadas si existen
        paidBy: undefined,
        accountStatement: undefined,
        reversedByUser: undefined,
    };
    // Limpiar campos undefined
    delete reversedForResponse.paidBy;
    delete reversedForResponse.accountStatement;
    delete reversedForResponse.reversedByUser;

    return {
        payment: reversedForResponse,
        statement: statementForResponse,
    };
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
