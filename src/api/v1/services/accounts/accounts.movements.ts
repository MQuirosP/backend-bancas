import { Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import { AppError } from "../../../../core/errors";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { calculateDayStatement } from "./accounts.calculations";
import { calculateIsSettled } from "./accounts.commissions";
import { invalidateAccountStatementCache } from "../../../../utils/accountStatementCache";

/**
 * Registra un pago o cobro
 */
export async function registerPayment(data: {
    date: string; // YYYY-MM-DD
    time?: string; // ✅ NUEVO: HH:MM (opcional, hora del movimiento en CR)
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
            // Agregar propiedad temporal para indicar que es respuesta cacheada
            (existing as any).cached = true;
            return existing;
        }
    }

    // ✅ CRÍTICO: Inferir ventanaId desde vendedorId si no está presente
    // y bancaId desde ventanaId para garantizar que siempre se persistan
    // Esto debe hacerse ANTES de crear/buscar el AccountStatement para asegurar
    // que el statement también tenga los campos correctos
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

    // ✅ CRÍTICO: Recalcular el statement completo desde tickets ANTES de registrar el movimiento
    // Esto asegura que ticketCount, totalSales, totalPayouts, comisiones, etc. estén siempre correctos
    const dimension: "ventana" | "vendedor" = finalVentanaId ? "ventana" : "vendedor";

    // Recalcular statement completo desde tickets para asegurar consistencia
    const recalculatedStatement = await calculateDayStatement(
        paymentDate,
        month,
        dimension,
        finalVentanaId ?? undefined,
        data.vendedorId ?? undefined,
        finalBancaId,
        "ADMIN" // Usar ADMIN para permitir ver todos los datos
    );

    // Obtener el statement persistido (calculateDayStatement ya lo creó/actualizó)
    const statement = await AccountStatementRepository.findByDate(paymentDate, {
        ventanaId: finalVentanaId ?? undefined,
        vendedorId: data.vendedorId ?? undefined,
    });

    if (!statement) {
        throw new AppError("No se pudo obtener el estado de cuenta", 500, "STATEMENT_NOT_FOUND");
    }

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

    // ✅ CRÍTICO: Crear pago con ventanaId, vendedorId y bancaId correctos
    // El repository también inferirá si es necesario, pero aquí ya los tenemos correctos
    // de la inferencia previa que se hizo para el AccountStatement
    const payment = await AccountPaymentRepository.create({
        accountStatementId: statement.id,
        date: paymentDate,
        month,
        time: data.time || null, // ✅ NUEVO: Almacenar hora si se proporciona
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
        isSettled,
        canEdit: !isSettled,
    });

    // ✅ OPTIMIZACIÓN: Invalidar caché de estados de cuenta para este día
    const dateStr = data.date; // Ya está en formato YYYY-MM-DD
    invalidateAccountStatementCache({
        date: dateStr,
        ventanaId: data.ventanaId || null,
        vendedorId: data.vendedorId || null,
    }).catch(() => {
        // Ignorar errores de invalidación de caché
    });

    // ✅ OPTIMIZACIÓN: Construir statement para respuesta (evita query adicional)
    // Ya tenemos todos los datos actualizados en updatedStatement
    // Las relaciones (ventana, vendedor) no son críticas para la respuesta, el FE puede obtenerlas del statement completo si las necesita
    const statementForResponse: any = {
        ...updatedStatement,
    };

    return {
        payment,
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

    // ✅ OPTIMIZACIÓN: Invalidar caché de estados de cuenta para este día
    const dateStr = payment.date.toISOString().split('T')[0]; // Convertir Date a YYYY-MM-DD
    invalidateAccountStatementCache({
        date: dateStr,
        ventanaId: payment.ventanaId || null,
        vendedorId: payment.vendedorId || null,
    }).catch(() => {
        // Ignorar errores de invalidación de caché
    });

    // ✅ OPTIMIZACIÓN: Construir statement completo para respuesta (evita query adicional)
    // Ya tenemos todos los datos, solo combinamos con las relaciones del statement original
    // El statement viene de payment.accountStatement que no incluye relaciones, así que las omitimos
    // El FE puede obtenerlas del statement original si las necesita
    const statementForResponse: any = {
        ...updatedStatement,
    };

    return {
        payment: reversed,
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
