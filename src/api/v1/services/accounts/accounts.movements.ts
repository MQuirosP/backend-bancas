import { Role } from "@prisma/client";
import prisma from "../../../../core/prismaClient";
import { AppError } from "../../../../core/errors";
import { AccountPaymentRepository } from "../../../../repositories/accountPayment.repository";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import { calculateDayStatement } from "./accounts.calculations";
import { calculateIsSettled } from "./accounts.commissions";

/**
 * Registra un pago o cobro
 */
export async function registerPayment(data: {
    date: string; // YYYY-MM-DD
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

    // Recalcular el estado de cuenta antes de validar el pago
    const dimension: "ventana" | "vendedor" = data.ventanaId ? "ventana" : "vendedor";

    // ✅ CRÍTICO: Obtener rol del usuario que está creando el pago
    const user = await prisma.user.findUnique({
        where: { id: data.paidById },
        select: { role: true },
    });
    const userRole = user?.role || Role.ADMIN;

    const statement = await calculateDayStatement(
        paymentDate,
        month,
        dimension,
        data.ventanaId ?? undefined,
        data.vendedorId ?? undefined,
        undefined, // bancaId
        userRole // ✅ CRÍTICO: Pasar rol del usuario
    );

    // Validar que se puede editar
    if (!statement.canEdit) {
        throw new AppError("El estado de cuenta ya está saldado", 400, "STATEMENT_SETTLED");
    }

    // FIX: Usar el saldo recalculado del statement para validar pagos/cobros
    const baseBalance = statement.balance || 0;
    const currentTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const currentTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);
    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const currentRemainingBalance = baseBalance - currentTotalCollected + currentTotalPaid;

    // Validar que el statement no esté saldado
    if (statement.isSettled) {
        throw new AppError("El estado de cuenta ya está saldado", 400, "STATEMENT_SETTLED");
    }

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

    // Crear pago
    const payment = await AccountPaymentRepository.create({
        accountStatementId: statement.id,
        date: paymentDate,
        month,
        ventanaId: data.ventanaId,
        vendedorId: data.vendedorId,
        amount: data.amount,
        type: data.type,
        method: data.method,
        notes: data.notes,
        isFinal: data.isFinal || false,
        idempotencyKey: data.idempotencyKey,
        paidById: data.paidById,
        paidByName: data.paidByName,
    });

    // Recalcular total pagado y cobrado después de crear el pago (solo pagos activos)
    const newTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const newTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

    // FIX: Reutilizar baseBalance ya calculado arriba (línea 1039)
    // Fórmula según tipo de movimiento:
    // - payment: suma al remainingBalance (reduce CxP o aumenta CxC)
    // - collection: resta del remainingBalance (reduce CxC o aumenta CxP)
    // Fórmula: remainingBalance = balance - totalCollected + totalPaid
    // Esto es equivalente a:
    // - payment: remainingBalance += amount (porque totalPaid aumenta)
    // - collection: remainingBalance -= amount (porque totalCollected aumenta)
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;

    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    const isSettled = calculateIsSettled(statement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ FIX: Actualizar también totalCollected cuando se registra un movimiento
    await AccountStatementRepository.update(statement.id, {
        totalPaid: newTotalPaid,
        totalCollected: newTotalCollected, // ✅ NUEVO: Actualizar totalCollected
        remainingBalance: newRemainingBalance,
        isSettled,
        canEdit: !isSettled,
    });

    return payment;
}

/**
 * Revierte un pago/cobro
 * CRÍTICO: No permite revertir si el día quedaría saldado (saldo = 0)
 */
export async function reversePayment(paymentId: string, userId: string, reason?: string) {
    const payment = await AccountPaymentRepository.findById(paymentId);

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

    // Obtener el estado de cuenta del día
    const statement = await AccountStatementRepository.findOrCreate({
        date: payment.date,
        month: payment.month,
        ventanaId: payment.ventanaId ?? undefined,
        vendedorId: payment.vendedorId ?? undefined,
    });

    // Calcular saldo base del día (sin pagos/cobros)
    // Según dimensión:
    // - Dimensión ventana: Ventas - Premios - Comisión Listero
    // - Dimensión vendedor: Ventas - Premios - Comisión Vendedor
    const baseBalance = statement.ventanaId && !statement.vendedorId
        ? statement.totalSales - statement.totalPayouts - (statement.listeroCommission || 0)
        : statement.totalSales - statement.totalPayouts - (statement.vendedorCommission || 0);

    // FIX: Eliminar cálculo redundante - usar directamente el repositorio para obtener totales actuales
    const currentTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const currentTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

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
    const reversed = await AccountPaymentRepository.reverse(paymentId, userId);

    // Recalcular total pagado y cobrado después de la reversión (solo pagos activos)
    const newTotalPaid = await AccountPaymentRepository.getTotalPaid(statement.id);
    const newTotalCollected = await AccountPaymentRepository.getTotalCollected(statement.id);

    // Fórmula correcta: remainingBalance = balance - totalCollected + totalPaid
    const newRemainingBalance = baseBalance - newTotalCollected + newTotalPaid;

    // FIX: Usar helper para cálculo consistente de isSettled (incluye validación de hasPayments y ticketCount)
    const isSettled = calculateIsSettled(statement.ticketCount, newRemainingBalance, newTotalPaid, newTotalCollected);

    // ✅ FIX: Actualizar también totalCollected cuando se revierte un movimiento
    await AccountStatementRepository.update(statement.id, {
        totalPaid: newTotalPaid,
        totalCollected: newTotalCollected, // ✅ NUEVO: Actualizar totalCollected
        remainingBalance: newRemainingBalance,
        isSettled,
        canEdit: !isSettled,
    });

    return reversed;
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
