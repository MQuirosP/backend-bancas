import { ActivityType, Role } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { isWithinSalesHours, validateTicketAgainstRules } from "../../../utils/loteriaRules";

const CUTOFF_GRACE_MS = 5000;

/**
 * Extrae la configuración de impresión de un usuario/ventana
 * Retorna un objeto con printName, printPhone, printWidth, printFooter, printBarcode
 */
function extractPrintConfig(settings: any, defaultName: string | null, defaultPhone: string | null) {
  const printSettings = (settings as any)?.print ?? {};
  return {
    printName: printSettings.name ?? defaultName,
    printPhone: printSettings.phone ?? defaultPhone,
    printWidth: printSettings.width ?? null,
    printFooter: printSettings.footer ?? null,
    printBarcode: printSettings.barcode ?? true,
  };
}

// Interfaces para pagos
interface RegisterPaymentInput {
  amountPaid: number;
  method?: string;
  notes?: string;
  isFinal?: boolean;
  idempotencyKey?: string;
}

interface PaymentHistoryEntry {
  id: string;
  amountPaid: number;
  paidAt: string;
  paidById: string;
  paidByName: string;
  method: string;
  notes?: string;
  isFinal: boolean;
  isReversed: boolean;
  reversedAt?: string;
  reversedBy?: string;
}

export const TicketService = {
  async create(data: any, userId: string, requestId?: string) {
    try {
      const { loteriaId, sorteoId } = data;
      if (!loteriaId || !sorteoId) throw new AppError("Missing loteriaId/sorteoId", 400);

      // Actor autenticado
      const actor = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, ventanaId: true, isActive: true },
      });
      if (!actor) throw new AppError("Authenticated user not found", 401);

      // Resolver vendedor efectivo (impersonación opcional para ADMIN/VENTANA)
      const requestedVendedorId: string | undefined = data?.vendedorId;
      let effectiveVendedorId: string;
      let ventanaId: string;

      if (requestedVendedorId) {
        if (actor.role !== Role.ADMIN && actor.role !== Role.VENTANA) {
          throw new AppError("vendedorId no permitido para este rol", 403);
        }
        const target = await prisma.user.findUnique({
          where: { id: requestedVendedorId },
          select: { id: true, role: true, ventanaId: true, isActive: true },
        });
        if (!target || !target.isActive) throw new AppError("Vendedor no encontrado o inactivo", 404);
        if (target.role !== Role.VENDEDOR) throw new AppError("vendedorId debe pertenecer a un usuario con rol VENDEDOR", 400);
        if (!target.ventanaId) throw new AppError("El vendedor seleccionado no tiene Ventana asignada", 400);
        if (actor.role === Role.VENTANA) {
          if (!actor.ventanaId || actor.ventanaId !== target.ventanaId) {
            throw new AppError("vendedorId no pertenece a tu Ventana", 403);
          }
        }
        effectiveVendedorId = target.id;
        ventanaId = target.ventanaId;
      } else {
        if (actor.role === Role.VENDEDOR) {
          if (!actor.ventanaId) throw new AppError("El vendedor no tiene una Ventana asignada", 400);
          effectiveVendedorId = actor.id;
          ventanaId = actor.ventanaId;
        } else {
          throw new AppError("vendedorId es requerido para este rol", 400);
        }
      }

      // Ventana válida
      const ventana = await prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { id: true, bancaId: true, isActive: true },
      });
      if (!ventana || !ventana.isActive) throw new AppError("La Ventana no existe o está inactiva", 404);

      // Sorteo válido + obtener lotería desde sorteo
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: sorteoId },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          loteriaId: true,
          loteria: { select: { id: true, name: true, rulesJson: true } },
        },
      });
      if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

      // Validar que loteriaId del request coincida con loteriaId del sorteo
      if (loteriaId !== sorteo.loteriaId) {
        throw new AppError(
          `loteriaId mismatch: request=${loteriaId}, sorteo=${sorteo.loteriaId}`,
          400
        );
      }

      // ⏱ cutoff efectivo (rules → RestrictionRuleRepository)
      const cutoff = await RestrictionRuleRepository.resolveSalesCutoff({
        bancaId: ventana.bancaId,
        ventanaId,
        userId,
        defaultCutoff: 5,
      });

      const now = new Date();
      const cutoffMs = cutoff.minutes * 60_000;
      const limitTime = new Date(sorteo.scheduledAt.getTime() - cutoffMs);
      const effectiveLimitTime = new Date(limitTime.getTime() + CUTOFF_GRACE_MS);

      logger.info({
        layer: "service",
        action: "TICKET_CUTOFF_DIAG",
        userId,
        requestId,
        payload: {
          cutOff: { minutes: cutoff.minutes, source: cutoff.source },
          nowISO: now.toISOString(),
          scheduledAtISO: sorteo.scheduledAt.toISOString(),
          limitTimeISO: limitTime.toISOString(),
          effectiveLimitTimeISO: effectiveLimitTime.toISOString(),
          sorteoStatus: sorteo.status,
        },
      });

      if (now >= effectiveLimitTime) {
        const minsLeft = Math.max(0, Math.ceil((sorteo.scheduledAt.getTime() - now.getTime()) / 60_000));
        throw new AppError(
          `Venta bloqueada: faltan ${minsLeft} min para el sorteo (cutoff=${cutoff.minutes} min, source=${cutoff.source})`,
          409
        );
      }

      // 🎯 Jugadas (el validador ya corrió)
      const jugadasIn: Array<{
        type?: "NUMERO" | "REVENTADO";
        number?: string;
        reventadoNumber?: string | null;
        amount: number;
      }> = Array.isArray(data.jugadas) ? data.jugadas : [];
      if (jugadasIn.length === 0) throw new AppError("At least one jugada is required", 400);

      // Seguridad extra: reventado apunta a un NUMERO del mismo ticket
      const numeros = new Set(
        jugadasIn
          .filter((j) => (j.type ?? "NUMERO") === "NUMERO")
          .map((j) => {
            if (!j.number) throw new AppError("NUMERO jugada requires 'number'", 400);
            return j.number;
          })
      );
      for (const j of jugadasIn) {
        const type = j.type ?? "NUMERO";
        if (type === "REVENTADO") {
          const target = j.reventadoNumber ?? j.number;
          if (!target) throw new AppError("REVENTADO requires 'reventadoNumber'", 400);
          if (!numeros.has(target)) {
            throw new AppError(`Debe existir una jugada NUMERO para ${target} en el mismo ticket`, 400);
          }
        }
      }

      // 🔒 Validaciones por rulesJson de la Lotería (horarios + reglas de jugadas)
      // Nota: loteria ya fue obtenida del sorteo arriba
      const rules = (sorteo.loteria?.rulesJson ?? {}) as any;

      // 1) horario
      if (!isWithinSalesHours(now, rules)) {
        throw new AppError("Fuera del horario de ventas para hoy", 409);
      }

      // 2) reglas del ticket
      const rulesCheck = validateTicketAgainstRules({
        loteriaRules: rules,
        jugadas: jugadasIn.map((j) => ({
          type: (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO",
          number: j.number ?? j.reventadoNumber ?? "",
          amount: j.amount,
          reventadoNumber: j.reventadoNumber ?? undefined,
        })),
      });
      if (!rulesCheck.ok) {
        throw new AppError(rulesCheck.reason, 400);
      }

      // 🧩 Normalizar para repo
      const ticket = await TicketRepository.create(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          totalAmount: 0,
          jugadas: jugadasIn.map((j) => {
            const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
            const isNumero = type === "NUMERO";
            const number = isNumero ? j.number! : (j.reventadoNumber ?? j.number)!;
            return {
              type,
              number,
              reventadoNumber: isNumero ? null : number,
              amount: j.amount,
              multiplierId: "",
              finalMultiplierX: 0,
            };
          }),
        } as any,
        effectiveVendedorId
      );

      // 🖨️ Obtener configuraciones de impresión del vendedor y ventana
      const vendedor = await prisma.user.findUnique({
        where: { id: effectiveVendedorId },
        select: { name: true, phone: true, settings: true },
      });
      const ventanaData = await prisma.ventana.findUnique({
        where: { id: ventanaId },
        select: { name: true, phone: true, settings: true },
      });

      // Enriquecer respuesta con configuraciones de impresión
      const response = {
        ...ticket,
        vendedor: {
          id: effectiveVendedorId,
          ...extractPrintConfig(vendedor?.settings, vendedor?.name || null, vendedor?.phone || null),
        },
        ventana: {
          id: ventanaId,
          ...extractPrintConfig(ventanaData?.settings, ventanaData?.name || null, ventanaData?.phone || null),
        },
      };

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: ticket.jugadas.length,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: { ticketId: ticket.id, totalAmount: ticket.totalAmount, jugadas: ticket.jugadas.length },
      });

      return response;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_CREATE_FAIL",
        userId,
        requestId,
        payload: { message: err.message },
      });
      throw err;
    }
  },

  async getById(id: string) {
    const ticket = await TicketRepository.getById(id);

    if (!ticket) {
      throw new AppError("Ticket no encontrado", 404);
    }

    // 🖨️ Obtener configuraciones de impresión del vendedor y ventana
    const vendedor = await prisma.user.findUnique({
      where: { id: ticket.vendedorId },
      select: { name: true, phone: true, settings: true },
    });
    const ventanaData = await prisma.ventana.findUnique({
      where: { id: ticket.ventanaId },
      select: { name: true, phone: true, settings: true },
    });

    // Enriquecer respuesta con configuraciones de impresión
    return {
      ...ticket,
      vendedor: ticket.vendedor ? {
        ...ticket.vendedor,
        ...extractPrintConfig(vendedor?.settings, vendedor?.name || null, vendedor?.phone || null),
      } : undefined,
      ventana: ticket.ventana ? {
        ...ticket.ventana,
        ...extractPrintConfig(ventanaData?.settings, ventanaData?.name || null, ventanaData?.phone || null),
      } : undefined,
    };
  },

  async list(page = 1, pageSize = 10, filters: any = {}): Promise<ReturnType<typeof TicketRepository.list>> {
    return TicketRepository.list(page, pageSize, filters);
  },

  async cancel(id: string, userId: string, requestId?: string) {
    const ticket = await TicketRepository.cancel(id, userId);

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_CANCEL,
      targetType: "TICKET",
      targetId: id,
      details: { reason: "Cancelled by user" },
      requestId,
      layer: "service",
    });

    logger.warn({
      layer: "service",
      action: "TICKET_CANCEL",
      userId,
      requestId,
      payload: { ticketId: id },
    });

    return ticket;
  },

  // ==================== MÉTODOS DE PAGO ====================

  /**
   * Registrar un pago (total o parcial) en un ticket ganador
   */
  async registerPayment(
    ticketId: string,
    data: RegisterPaymentInput,
    userId: string,
    requestId?: string
  ) {
    try {
      // Verificar que el ticket existe y es ganador
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true, vendedor: true, ventana: true },
      });

      if (!ticket) throw new AppError("Ticket no encontrado", 404);
      if (!ticket.isWinner) throw new AppError("El ticket no es ganador", 409);

      // Validar estado del ticket
      if (ticket.status !== "EVALUATED" && ticket.status !== "PAID") {
        throw new AppError("El ticket debe estar en estado EVALUATED para pagar", 409);
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
          400
        );
      }

      // Idempotencia: si ya existe un pago con esta llave, retornar el existente
      if (data.idempotencyKey) {
        const existing = await prisma.ticketPayment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { ticket: true },
        });
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
      const user = await prisma.user.findUnique({ where: { id: userId } });
      const historyEntry: PaymentHistoryEntry = {
        id: crypto.randomUUID(),
        amountPaid: data.amountPaid,
        paidAt: new Date().toISOString(),
        paidById: userId,
        paidByName: user?.name ?? "Unknown",
        method: data.method ?? "cash",
        notes: data.notes,
        isFinal: data.isFinal ?? false,
        isReversed: false,
      };

      // Actualizar en transacción
      const updated = await prisma.$transaction(async (tx) => {
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
            isReversed: false, // Explícitamente false para nuevo pago
            completedAt: shouldMarkPaid ? new Date() : null,
            idempotencyKey: data.idempotencyKey,
          },
        });

        // Actualizar ticket con información consolidada
        return await tx.ticket.update({
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
      });

      // Log de actividad
      await ActivityService.log({
        userId,
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
  },

  /**
   * Revertir el último pago de un ticket
   */
  async reversePayment(ticketId: string, userId: string, reason?: string, requestId?: string) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true },
      });

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history = (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
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
          : p
      );

      // Recalcular totales
      const activePaid = updatedHistory
        .filter((p) => !p.isReversed)
        .reduce((acc, p) => acc + p.amountPaid, 0);

      const totalPayout = ticket.totalPayout ?? 0;
      const remainingAmount = totalPayout - activePaid;

      // Determinar nuevo estado
      const newStatus = activePaid === 0 ? "EVALUATED" : activePaid >= totalPayout ? "PAID" : ticket.status;

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
        action: ActivityType.TICKET_PAYMENT_REVERSE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          amountReversed: lastPayment.amountPaid,
          reason,
          newTotalPaid: activePaid,
          newStatus,
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
  },

  /**
   * Marcar un pago parcial como final (acepta deuda restante)
   */
  async finalizePayment(ticketId: string, userId: string, notes?: string, requestId?: string) {
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { jugadas: true },
      });

      if (!ticket) throw new AppError("Ticket no encontrado", 404);

      const history = (ticket.paymentHistory as unknown as PaymentHistoryEntry[]) || [];
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
        throw new AppError("El pago ya está completo, no es necesario finalizar", 409);
      }

      // Marcar como final en historial
      const updatedHistory = history.map((p) =>
        p.id === lastPayment.id ? { ...p, isFinal: true, notes: notes ?? p.notes } : p
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
        action: ActivityType.TICKET_PAY_FINALIZE,
        targetType: "TICKET",
        targetId: ticketId,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalPaid,
          totalPayout,
          remainingAccepted: totalPayout - totalPaid,
          notes,
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
  },
};

export default TicketService;
