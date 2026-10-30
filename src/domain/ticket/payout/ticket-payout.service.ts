import crypto from "crypto";
import prisma from "../../../core/prismaClient";
import { withConnectionRetry } from "../../../core/withConnectionRetry";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import ActivityService from "../../../core/activity.service";
import { ActivityType } from "../../../generated/prisma/client";
import { formatDateCRWithTZ, nowCR } from "../../../utils/datetime";
import { RegisterPaymentInput, PaymentHistoryEntry } from "../types/ticket.types";

export class TicketPayoutService {
  /**
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  static async registerPayment(
    ticketId: string,
    data: RegisterPaymentInput,
    userId: string,
    requestId?: string,
  ) {
    try {
      // Verificar que el ticket existe y es ganador
      const ticket = await withConnectionRetry(
        () =>
          prisma.ticket.findUnique({
            where: { id: ticketId },
            include: {
              jugadas: true,
              vendedor: true,
              ventana: true,
              sorteo: { select: { id: true, status: true } },
            },
          }),
        { context: "TicketPayoutService.registerPayment.fetchTicket" },
      );

      if (!ticket) throw new AppError("Ticket no encontrado", 404);
      if (!ticket.isWinner) throw new AppError("El ticket no es ganador", 409);

      // Verificar que el sorteo no esté cerrado
      if (ticket.sorteo?.status === "CLOSED") {
        throw new AppError(
          "No se pueden registrar pagos para tickets de sorteos cerrados",
          409,
        );
      }

      // Validar estado del ticket
      if (ticket.status !== "EVALUATED" && ticket.status !== "PAID") {
        throw new AppError(
          "El ticket debe estar en estado EVALUATED para pagar",
          409,
        );
      }

      // Calcular totalPayout (suma de jugadas ganadoras)
      const totalPayout = ticket.jugadas
        .filter((j) => j.isWinner)
        .reduce((acc, j) => acc + (j.payout ?? 0), 0);

      // Validar que no se exceda el monto total
      const currentPaid = ticket.totalPaid ?? 0;
      const newTotal = currentPaid + data.amountPaid;

      if (newTotal > totalPayout) {
        throw new AppError(
          `El pago excede el premio total. Total: ${totalPayout}, Pagado: ${currentPaid}, Intentado: ${data.amountPaid}`,
          400,
        );
      }

      // Idempotencia: si ya existe un pago con esta llave, retornar el existente
      if (data.idempotencyKey) {
        const existing = await withConnectionRetry(
          () =>
            prisma.ticketPayment.findUnique({
              where: { idempotencyKey: data.idempotencyKey },
              include: { ticket: true },
            }),
          { context: "TicketPayoutService.registerPayment.idempotency" },
        );
        if (existing) {
          logger.info({
            layer: "service",
            action: "PAYMENT_IDEMPOTENT",
            userId,
            requestId,
            payload: { ticketId, idempotencyKey: data.idempotencyKey },
          });
          return existing.ticket;
        }
      }

      // Calcular si es pago parcial y monto restante
      const isPartial = newTotal < totalPayout;
      const remainingAmount = isPartial ? totalPayout - newTotal : 0;

      // Determinar si el ticket debe marcarse como PAID
      const shouldMarkPaid = !isPartial || data.isFinal;

      // Obtener historial actual
      const currentHistory = (ticket.paymentHistory as any[]) || [];

      // Crear entrada para historial
      const user = await withConnectionRetry(
        () => prisma.user.findUnique({ where: { id: userId } }),
        { context: "TicketPayoutService.registerPayment.fetchUser" },
      );
      const historyEntry: PaymentHistoryEntry = {
        id: crypto.randomUUID(),
        amountPaid: data.amountPaid,
        paidAt: formatDateCRWithTZ(nowCR()),
        paidById: userId,
        paidByName: user?.name ?? "Unknown",
        method: data.method ?? "cash",
        notes: data.notes,
        isFinal: data.isFinal ?? false,
        isReversed: false,
      };

      // Actualizar en transacción
      const updated = await withConnectionRetry(
        () =>
          prisma.$transaction(async (tx) => {
            // Crear registro de auditoría en TicketPayment
            await tx.ticketPayment.create({
              data: {
                ticketId,
                amountPaid: data.amountPaid,
                paidById: userId,
                method: data.method ?? "cash",
                notes: data.notes,
                isPartial,
                remainingAmount,
                isFinal: data.isFinal ?? false,
                isReversed: false,
                completedAt: shouldMarkPaid ? new Date() : null,
                idempotencyKey: data.idempotencyKey,
              },
            });

            // Actualizar ticket con información consolidada
            return tx.ticket.update({
              where: { id: ticketId },
              data: {
                totalPayout,
                totalPaid: newTotal,
                remainingAmount,
                lastPaymentAt: new Date(),
                paidById: userId,
                paymentMethod: data.method ?? "cash",
                paymentNotes: data.notes,
                paymentHistory: [...currentHistory, historyEntry] as any,
                status: shouldMarkPaid ? "PAID" : ticket.status,
              },
              include: {
                jugadas: true,
                vendedor: true,
                ventana: true,
                paidBy: true,
                loteria: true,
                sorteo: true,
              },
            });
          }),
        { context: "TicketPayoutService.registerPayment.transaction" },
      );

      // Log de actividad
      await ActivityService.log({
        userId,
        bancaId: ticket.bancaId,
        action: ActivityType.TICKET_PAY,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          amountPaid: data.amountPaid,
          totalPaid: newTotal,
          totalPayout,
          remainingAmount,
          isPartial,
          isFinal: data.isFinal,
          newStatus: shouldMarkPaid ? "PAID" : ticket.status,
          description: `Pago de ₡${data.amountPaid.toLocaleString()} registrado para el Ticket #${ticket.ticketNumber}${isPartial ? " (Pago Parcial)" : ""}`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_PAYMENT_REGISTERED",
        userId,
        requestId,
        payload: {
          ticketId,
          amountPaid: data.amountPaid,
          totalPaid: newTotal,
          isPartial,
          shouldMarkPaid,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  }

  /**
   * Revertir el último pago de un ticket
   */
  static async reversePayment(
    ticketId: string,
    userId: string,
    reason?: string,
    requestId?: string,
  ) {
    try {
      const ticket = await withConnectionRetry(
        () =>
          prisma.ticket.findUnique({
            where: { id: ticketId },
            include: { jugadas: true },
          }),
        { context: "TicketPayoutService.reversePayment.fetchTicket" },
      );

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history =
        (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
      if (history.length === 0) {
        throw new AppError("No hay pagos para revertir", 409);
      }

      // Encontrar el último pago no revertido
      const lastPayment = [...history].reverse().find((p) => !p.isReversed);
      if (!lastPayment) {
        throw new AppError("No hay pagos activos para revertir", 409);
      }

      // Marcar como revertido en historial
      const updatedHistory = history.map((p) =>
        p.id === lastPayment.id
          ? {
            ...p,
            isReversed: true,
            reversedAt: new Date().toISOString(),
            reversedBy: userId,
          }
          : p,
      );

      // Recalcular totales
      const activePaid = updatedHistory
        .filter((p) => !p.isReversed)
        .reduce((acc, p) => acc + p.amountPaid, 0);

      const totalPayout = ticket.totalPayout ?? 0;
      const remainingAmount = totalPayout - activePaid;

      // Determinar nuevo estado
      const newStatus =
        activePaid === 0
          ? "EVALUATED"
          : activePaid >= totalPayout
            ? "PAID"
            : ticket.status;

      // Actualizar en transacción
      const updated = await prisma.$transaction(async (tx) => {
        // Marcar el TicketPayment original como revertido
        await tx.ticketPayment.updateMany({
          where: {
            ticketId,
            amountPaid: lastPayment.amountPaid,
            paidById: lastPayment.paidById,
            isReversed: false,
          },
          data: {
            isReversed: true,
            reversedAt: new Date(),
            reversedBy: userId,
          },
        });

        // Actualizar ticket
        return await tx.ticket.update({
          where: { id: ticketId },
          data: {
            totalPaid: activePaid,
            remainingAmount,
            paymentHistory: updatedHistory as any,
            status: newStatus,
            paymentNotes: reason ? `Revertido: ${reason}` : undefined,
          },
          include: {
            jugadas: true,
            vendedor: true,
            ventana: true,
            paidBy: true,
            loteria: true,
            sorteo: true,
          },
        });
      });

      // Log de actividad
      await ActivityService.log({
        userId,
        bancaId: ticket.bancaId,
        action: ActivityType.TICKET_PAYMENT_REVERSE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          amountReversed: lastPayment.amountPaid,
          reason,
          newTotalPaid: activePaid,
          newStatus,
          description: `Pago de ₡${lastPayment.amountPaid.toLocaleString()} revertido para el Ticket #${ticket.ticketNumber}${reason ? ` (Motivo: ${reason})` : ""}`,
        },
        requestId,
        layer: "service",
      });

      logger.warn({
        layer: "service",
        action: "TICKET_PAYMENT_REVERSED",
        userId,
        requestId,
        payload: {
          ticketId,
          amountReversed: lastPayment.amountPaid,
          reason,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_REVERSE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  }

  /**
   * Marcar un pago parcial como final (acepta deuda restante)
   */
  static async finalizePayment(
    ticketId: string,
    userId: string,
    notes?: string,
    requestId?: string,
  ) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true },
      });

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history =
        (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
      const lastPayment = [...history].reverse().find((p) => !p.isReversed);

      if (!lastPayment) {
        throw new AppError("No hay pagos activos para finalizar", 409);
      }

      if (lastPayment.isFinal) {
        throw new AppError("El último pago ya está marcado como final", 409);
      }

      const totalPaid = ticket.totalPaid ?? 0;
      const totalPayout = ticket.totalPayout ?? 0;

      if (totalPaid >= totalPayout) {
        throw new AppError(
          "El pago ya está completo, no es necesario finalizar",
          409,
        );
      }

      // Marcar como final en historial
      const updatedHistory = history.map((p) =>
        p.id === lastPayment.id
          ? { ...p, isFinal: true, notes: notes ?? p.notes }
          : p,
      );

      // Actualizar ticket
      const updated = await prisma.$transaction(async (tx) => {
        // Actualizar el TicketPayment original
        await tx.ticketPayment.updateMany({
          where: {
            ticketId,
            amountPaid: lastPayment.amountPaid,
            paidById: lastPayment.paidById,
            isReversed: false,
            isFinal: false,
          },
          data: {
            isFinal: true,
            completedAt: new Date(),
            notes: notes ?? undefined,
          },
        });

        // Marcar ticket como PAID
        return await tx.ticket.update({
          where: { id: ticketId },
          data: {
            paymentHistory: updatedHistory as any,
            status: "PAID",
            paymentNotes: notes ?? ticket.paymentNotes,
          },
          include: {
            jugadas: true,
            vendedor: true,
            ventana: true,
            paidBy: true,
            loteria: true,
            sorteo: true,
          },
        });
      });

      // Log de actividad
      await ActivityService.log({
        userId,
        bancaId: ticket.bancaId,
        action: ActivityType.TICKET_PAY_FINALIZE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalPaid,
          totalPayout,
          remainingAccepted: totalPayout - totalPaid,
          notes,
          description: `Pago finalizado para el Ticket #${ticket.ticketNumber}. Monto pendiente aceptado: ₡${(totalPayout - totalPaid).toLocaleString()}`,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_PAYMENT_FINALIZED",
        userId,
        requestId,
        payload: {
          ticketId,
          totalPaid,
          totalPayout,
          remainingAccepted: totalPayout - totalPaid,
        },
      });

      return updated;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_PAYMENT_FINALIZE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  }
}
