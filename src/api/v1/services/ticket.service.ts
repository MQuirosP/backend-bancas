import { ActivityType, Role } from "@prisma/client";
import TicketRepository from "../../../repositories/ticket.repository";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import { RestrictionRuleRepository } from "../../../repositories/restrictionRule.repository";
import { isWithinSalesHours, validateTicketAgainstRules } from "../../../utils/loteriaRules";
import { prepareCommissionContext, preCalculateCommissions } from "../../../utils/commissionPrecalc";
import { resolveDateRange } from "../../../utils/dateRange";

const CUTOFF_GRACE_MS = 5000;
// Updated: Added clienteNombre field support

/**
 * Extrae la configuración de impresión de un usuario/ventana
 * Retorna un objeto con printName, printPhone, printWidth, printFooter, printBarcode, printBluetoothMacAddress
 */
function extractPrintConfig(settings: any, defaultName: string | null, defaultPhone: string | null) {
  const printSettings = (settings as any)?.print ?? {};
  return {
    printName: printSettings.name ?? defaultName,
    printPhone: printSettings.phone ?? defaultPhone,
    printWidth: printSettings.width ?? null,
    printFooter: printSettings.footer ?? null,
    printBarcode: printSettings.barcode ?? true,
    printBluetoothMacAddress: printSettings.bluetoothMacAddress ?? null,
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
  async create(
    data: any,
    userId: string,
    requestId?: string,
    actorRole: Role = Role.VENDEDOR
  ) {
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
          scheduledAtISO: sorteo.scheduledAt ? sorteo.scheduledAt.toISOString() : null,
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

      // 🚀 OPTIMIZACIÓN: Pre-calcular comisiones fuera de la transacción
      // Obtener políticas de comisión (una sola vez)
      const [user, ventanaWithBanca] = await Promise.all([
        prisma.user.findUnique({
          where: { id: effectiveVendedorId },
          select: { commissionPolicyJson: true },
        }),
        prisma.ventana.findUnique({
          where: { id: ventanaId },
          select: {
            commissionPolicyJson: true,
            banca: {
              select: {
                commissionPolicyJson: true,
              },
            },
          },
        }),
      ]);

      // Preparar contexto de comisiones (parsear y cachear políticas)
      const commissionContext = await prepareCommissionContext(
        effectiveVendedorId,
        ventanaId,
        ventana.bancaId,
        user?.commissionPolicyJson ?? null,
        ventanaWithBanca?.commissionPolicyJson ?? null,
        ventanaWithBanca?.banca?.commissionPolicyJson ?? null
      );

      // 🧩 Normalizar jugadas para repo (sin comisiones aún)
      const normalizedJugadas = jugadasIn.map((j) => {
        const type = (j.type ?? "NUMERO") as "NUMERO" | "REVENTADO";
        const isNumero = type === "NUMERO";
        const number = isNumero ? j.number! : (j.reventadoNumber ?? j.number)!;
        return {
          type,
          number,
          reventadoNumber: isNumero ? null : number,
          amount: j.amount,
          multiplierId: isNumero ? ((j as any).multiplierId ?? null) : null,
          finalMultiplierX: 0, // Se calculará en el repo
        };
      });

      // 🧩 Crear ticket con método optimizado
      const { ticket, warnings } = await TicketRepository.createOptimized(
        {
          loteriaId,
          sorteoId,
          ventanaId,
          clienteNombre: data.clienteNombre ?? null,
          jugadas: normalizedJugadas,
        },
        effectiveVendedorId,
        {
          actorRole,
          commissionContext, // Pasar contexto para cálculo rápido
          scheduledAt: sorteo.scheduledAt,
        }
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

      // Obtener número de jugadas (el ticket incluye jugadas pero TypeScript no lo infiere)
      const jugadasCount = (ticket as any).jugadas?.length ?? jugadasIn.length;

      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_CREATE,
        targetType: "TICKET",
        targetId: ticket.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          totalAmount: ticket.totalAmount,
          jugadas: jugadasCount,
        },
        requestId,
        layer: "service",
      });

      logger.info({
        layer: "service",
        action: "TICKET_CREATE",
        userId,
        requestId,
        payload: { ticketId: ticket.id, totalAmount: ticket.totalAmount, jugadas: jugadasCount },
      });

      if (warnings && warnings.length > 0) {
        logger.warn({
          layer: "service",
          action: "TICKET_CREATE_WARNINGS",
          userId,
          requestId,
          payload: { warnings },
        });
      }

      if (warnings && warnings.length > 0) {
        (response as any).warnings = warnings;
      }

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
    const enriched = {
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
    return enriched;
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

  /**
   * Obtiene resumen de números del 00 al 99 con montos por tipo (NÚMERO vs REVENTADO)
   * GET /api/v1/tickets/numbers-summary
   */
  async numbersSummary(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      dimension?: string;
      ventanaId?: string | null;
      vendedorId?: string | null;
      loteriaId?: string;
      sorteoId?: string;
    },
    role: string,
    userId: string
  ) {
    try {
      // Resolver rango de fechas
      const dateRange = resolveDateRange(
        params.date || "today",
        params.fromDate,
        params.toDate
      );

      // Construir filtro para tickets según dimension y scope
      const ticketWhere: any = {
        deletedAt: null,
        createdAt: {
          gte: dateRange.fromAt,
          lte: dateRange.toAt,
        },
        ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        ...(params.sorteoId ? { sorteoId: params.sorteoId } : {}),
      };

      // Aplicar filtros según dimension y scope
      if (params.dimension === "listero" && params.ventanaId) {
        ticketWhere.ventanaId = params.ventanaId;
      } else if (params.dimension === "vendedor" && params.vendedorId) {
        ticketWhere.vendedorId = params.vendedorId;
      } else if (params.ventanaId) {
        // ventanaId viene de RBAC o del request
        ticketWhere.ventanaId = params.ventanaId;
      } else if (params.vendedorId) {
        // vendedorId viene de RBAC o del request
        ticketWhere.vendedorId = params.vendedorId;
      } else if (params.scope === "mine") {
        // Si scope='mine' y no hay filtros específicos, usar userId según rol
        if (role === "VENDEDOR") {
          ticketWhere.vendedorId = userId;
        } else if (role === "VENTANA") {
          // Para VENTANA, el ventanaId debería venir en params.ventanaId desde RBAC
          // Si no viene, es un error de configuración
          if (!params.ventanaId) {
            logger.warn({
              layer: "service",
              action: "TICKET_NUMBERS_SUMMARY_MISSING_VENTANA_ID",
              payload: { role, userId, message: "VENTANA user should have ventanaId from RBAC" },
            });
          }
        }
      }
      // Si scope='all' y no hay filtros específicos, no agregar filtros de ventanaId/vendedorId

      // Obtener todas las jugadas que cumplen los filtros
      const jugadas = await prisma.jugada.findMany({
        where: {
          ticket: ticketWhere,
          deletedAt: null,
        },
        select: {
          id: true,
          ticketId: true,
          number: true,
          reventadoNumber: true,
          type: true,
          amount: true,
        },
      });

      // Agrupar por número y tipo
      // Para NUMERO: usar jugada.number
      // Para REVENTADO: usar jugada.reventadoNumber (o jugada.number si reventadoNumber es null)
      const numbersMap = new Map<string, {
        amountByNumber: number;
        amountByReventado: number;
        ticketIdsByNumber: Set<string>;
        ticketIdsByReventado: Set<string>;
      }>();

      // Inicializar todos los números del 00 al 99
      for (let i = 0; i <= 99; i++) {
        const numStr = String(i).padStart(2, '0');
        numbersMap.set(numStr, {
          amountByNumber: 0,
          amountByReventado: 0,
          ticketIdsByNumber: new Set(),
          ticketIdsByReventado: new Set(),
        });
      }

      // Procesar jugadas
      for (const jugada of jugadas) {
        let numberToUse: string;
        
        if (jugada.type === 'NUMERO') {
          numberToUse = jugada.number.padStart(2, '0');
        } else if (jugada.type === 'REVENTADO') {
          // Para REVENTADO, usar reventadoNumber si existe, sino usar number
          numberToUse = (jugada.reventadoNumber || jugada.number).padStart(2, '0');
        } else {
          // Por defecto, tratar como NUMERO (compatibilidad con datos antiguos)
          numberToUse = jugada.number.padStart(2, '0');
        }

        // Validar que el número esté en el rango 00-99
        const numValue = parseInt(numberToUse, 10);
        if (numValue < 0 || numValue > 99) {
          continue; // Saltar números inválidos
        }

        let numData = numbersMap.get(numberToUse);
        if (!numData) {
          // Si por alguna razón no existe, crear entrada
          numData = {
            amountByNumber: 0,
            amountByReventado: 0,
            ticketIdsByNumber: new Set(),
            ticketIdsByReventado: new Set(),
          };
          numbersMap.set(numberToUse, numData);
        }
        
        if (jugada.type === 'NUMERO') {
          numData.amountByNumber += jugada.amount || 0;
          numData.ticketIdsByNumber.add(jugada.ticketId);
        } else if (jugada.type === 'REVENTADO') {
          numData.amountByReventado += jugada.amount || 0;
          numData.ticketIdsByReventado.add(jugada.ticketId);
        } else {
          // Por defecto, tratar como NUMERO
          numData.amountByNumber += jugada.amount || 0;
          numData.ticketIdsByNumber.add(jugada.ticketId);
        }
      }

      // Construir array de respuesta ordenado de 00 a 99
      const data = Array.from({ length: 100 }, (_, i) => {
        const numStr = String(i).padStart(2, '0');
        const numData = numbersMap.get(numStr) || {
          amountByNumber: 0,
          amountByReventado: 0,
          ticketIdsByNumber: new Set<string>(),
          ticketIdsByReventado: new Set<string>(),
        };

        // Calcular ticketCount: tickets únicos que tienen apuestas en este número
        const allTicketIds = new Set([
          ...Array.from(numData.ticketIdsByNumber),
          ...Array.from(numData.ticketIdsByReventado),
        ]);

        return {
          number: numStr,
          amountByNumber: numData.amountByNumber,
          amountByReventado: numData.amountByReventado,
          totalAmount: numData.amountByNumber + numData.amountByReventado,
          ticketCount: allTicketIds.size,
          ticketsByNumber: numData.ticketIdsByNumber.size,
          ticketsByReventado: numData.ticketIdsByReventado.size,
        };
      });

      // Calcular totales
      const totalAmountByNumber = data.reduce((sum, n) => sum + n.amountByNumber, 0);
      const totalAmountByReventado = data.reduce((sum, n) => sum + n.amountByReventado, 0);
      const totalAmount = totalAmountByNumber + totalAmountByReventado;
      
      // Contar tickets únicos totales
      const allUniqueTicketIds = new Set<string>();
      for (const numData of numbersMap.values()) {
        numData.ticketIdsByNumber.forEach(id => allUniqueTicketIds.add(id));
        numData.ticketIdsByReventado.forEach(id => allUniqueTicketIds.add(id));
      }
      const totalTickets = allUniqueTicketIds.size;

      // Obtener información de ventana/vendedor si están presentes
      let ventanaName: string | undefined;
      let vendedorName: string | undefined;

      if (params.ventanaId) {
        const ventana = await prisma.ventana.findUnique({
          where: { id: params.ventanaId },
          select: { name: true },
        });
        ventanaName = ventana?.name;
      }

      if (params.vendedorId) {
        const vendedor = await prisma.user.findUnique({
          where: { id: params.vendedorId },
          select: { name: true },
        });
        vendedorName = vendedor?.name || undefined;
      }

      return {
        data,
        meta: {
          dateFilter: params.date || "today",
          ...(params.fromDate ? { fromDate: params.fromDate } : {}),
          ...(params.toDate ? { toDate: params.toDate } : {}),
          totalNumbers: 100,
          totalAmountByNumber,
          totalAmountByReventado,
          totalAmount,
          totalTickets,
          ...(params.dimension ? { dimension: params.dimension } : {}),
          ...(params.ventanaId ? { ventanaId: params.ventanaId } : {}),
          ...(params.vendedorId ? { vendedorId: params.vendedorId } : {}),
          ...(ventanaName ? { ventanaName } : {}),
          ...(vendedorName ? { vendedorName } : {}),
        },
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_NUMBERS_SUMMARY_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  },

  /**
   * Obtiene las jugadas de un ticket existente mediante su número de ticket
   * GET /api/v1/tickets/by-number/:ticketNumber
   * Endpoint público/inter-vendedor (no filtra por vendedor)
   */
  async getByTicketNumber(ticketNumber: string) {
    try {
      // Buscar el ticket por número (sin filtrar por vendedor)
      const ticket = await prisma.ticket.findUnique({
        where: {
          ticketNumber,
          deletedAt: null, // Solo tickets no eliminados
        },
        select: {
          id: true,
          ticketNumber: true,
          sorteoId: true,
          loteriaId: true,
          createdAt: true,
          jugadas: {
            where: {
              deletedAt: null, // Solo jugadas no eliminadas
            },
            select: {
              id: true,
              type: true,
              number: true,
              reventadoNumber: true,
              amount: true,
              multiplierId: true,
            },
            orderBy: {
              createdAt: "asc", // Ordenar por orden de creación
            },
          },
        },
      });

      if (!ticket) {
        throw new AppError(
          `No se encontró un ticket con el número ${ticketNumber}`,
          404,
          "TICKET_NOT_FOUND"
        );
      }

      // Formatear jugadas para el frontend
      const jugadas = ticket.jugadas.map((jugada) => {
        const baseJugada: any = {
          type: jugada.type || "NUMERO", // Por defecto NUMERO si no tiene tipo
          number: jugada.number,
          amount: jugada.amount,
        };

        // Si es REVENTADO, incluir reventadoNumber
        if (jugada.type === "REVENTADO" && jugada.reventadoNumber) {
          baseJugada.reventadoNumber = jugada.reventadoNumber;
        }

        // Incluir multiplierId si existe (opcional, para referencia)
        if (jugada.multiplierId) {
          baseJugada.multiplierId = jugada.multiplierId;
        }

        return baseJugada;
      });

      return {
        ticketNumber: ticket.ticketNumber,
        jugadas,
        sorteoId: ticket.sorteoId,
        loteriaId: ticket.loteriaId,
        createdAt: ticket.createdAt.toISOString(),
      };
    } catch (err: any) {
      // Si es un AppError, re-lanzarlo tal cual
      if (err instanceof AppError) {
        throw err;
      }

      // Para otros errores, loggear y lanzar error genérico
      logger.error({
        layer: "service",
        action: "TICKET_GET_BY_NUMBER_FAIL",
        payload: { message: err.message, ticketNumber },
      });

      throw new AppError(
        "Error al obtener el ticket",
        500,
        "INTERNAL_ERROR"
      );
    }
  },
};

export default TicketService;
