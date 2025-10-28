import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import { ActivityType, Role, TicketPayment, TicketStatus } from "@prisma/client";
import { CreatePaymentInput } from "../dto/ticketPayment.dto";

interface AuthActor {
  id: string;
  role: Role;
  ventanaId?: string | null;
}

interface PaymentWithRelations extends TicketPayment {
  ticket?: any;
  paidBy?: any;
}

export const TicketPaymentService = {
  /**
   * Registra un pago de tiquete ganador (total o parcial)
   * con validaciones de idempotencia, rol y monto.
   * Actualiza status a PAID si pago es completo o isFinal=true.
   */
  async create(data: CreatePaymentInput, actor: AuthActor): Promise<PaymentWithRelations> {
    const { id: userId, role } = actor;

    // Obtener tiquete con jugadas y ventana
    const ticket = await prisma.ticket.findUnique({
      where: { id: data.ticketId },
      include: {
        jugadas: true,
        ventana: true,
      },
    });
    if (!ticket) throw new AppError("TKT_PAY_001", 404);
    if (!ticket.isWinner) throw new AppError("TKT_PAY_002", 409);

    // Validar que tiquete esté en estado EVALUATED
    if (ticket.status !== TicketStatus.EVALUATED) {
      throw new AppError("TKT_PAY_003", 409);
    }

    // Validar rol
    const allowedRoles: Role[] = [Role.ADMIN, Role.VENTANA];
    if (!allowedRoles.includes(role)) {
      throw new AppError("TKT_PAY_006", 403);
    }

    // Validar RBAC: VENTANA solo puede pagar sus propios tiquetes
    if (role === Role.VENTANA && ticket.ventanaId !== actor.ventanaId) {
      throw new AppError("TKT_PAY_006", 403);
    }

    // Idempotencia: si trae llave y ya existe, devolver ese pago
    if (data.idempotencyKey) {
      const existingKey = await prisma.ticketPayment.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { ticket: true, paidBy: true },
      });
      if (existingKey) return existingKey;
    }

    // Verificar si ya existe un pago no revertido y no final
    const existingPayment = await prisma.ticketPayment.findFirst({
      where: {
        ticketId: ticket.id,
        isReversed: false,
        isFinal: false,
      },
    });
    if (existingPayment) {
      throw new AppError("TKT_PAY_005", 409);
    }

    // Calcular total premio
    const totalPayout = ticket.jugadas
      .filter(j => j.isWinner)
      .reduce((acc, j) => acc + (j.payout ?? 0), 0);

    // Validar monto
    if (data.amountPaid > totalPayout) {
      throw new AppError("TKT_PAY_004", 400);
    }

    if (data.amountPaid <= 0) {
      throw new AppError("Amount must be greater than 0", 400);
    }

    // Determinar si es pago parcial y monto restante
    const isPartial = data.amountPaid < totalPayout;
    const remainingAmount = isPartial ? totalPayout - data.amountPaid : 0;

    // Determinar si el pago completa o finaliza
    const shouldMarkPaid = !isPartial || data.isFinal;
    const completedAt = shouldMarkPaid ? new Date() : null;

    // Usar transacción para atomicidad
    const payment = await prisma.$transaction(async (tx) => {
      // Crear pago
      const newPayment = await tx.ticketPayment.create({
        data: {
          ticketId: ticket.id,
          amountPaid: data.amountPaid,
          paidById: userId,
          method: data.method || 'cash',
          notes: data.notes,
          isPartial,
          remainingAmount,
          isFinal: data.isFinal || false,
          completedAt,
          idempotencyKey: data.idempotencyKey,
        },
        include: { ticket: true, paidBy: true },
      });

      // Actualizar status del tiquete si es pago completo o final
      if (shouldMarkPaid) {
        await tx.ticket.update({
          where: { id: ticket.id },
          data: { status: TicketStatus.PAID },
        });

        // Log especial para cambio de status
        await ActivityService.log({
          userId,
          action: ActivityType.TICKET_STATUS_PAID,
          targetType: "TICKET",
          targetId: ticket.id,
          details: {
            ticketNumber: ticket.ticketNumber,
            newStatus: TicketStatus.PAID,
            fromStatus: TicketStatus.EVALUATED,
          },
          layer: "service",
        });
      }

      return newPayment;
    });

    // Log de pago
    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_PAY,
      targetType: "TICKET_PAYMENT",
      targetId: payment.id,
      details: {
        ticketNumber: ticket.ticketNumber,
        amountPaid: data.amountPaid,
        isPartial,
        isFinal: data.isFinal,
        remainingAmount,
        totalPayout,
      },
      layer: "service",
    });

    // Log adicional si se marcó como final
    if (data.isFinal && isPartial) {
      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_PAY_FINALIZE,
        targetType: "TICKET_PAYMENT",
        targetId: payment.id,
        details: {
          ticketNumber: ticket.ticketNumber,
          finalAmount: data.amountPaid,
          remainingAccepted: remainingAmount,
        },
        layer: "service",
      });
    }

    return payment;
  },

  /**
   * Lista paginada de pagos registrados con RBAC
   */
  async list(
    page = 1,
    pageSize = 10,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
      ticketId?: string;
      status?: 'pending' | 'completed' | 'reversed' | 'partial';
      fromDate?: Date;
      toDate?: Date;
      sortBy?: 'createdAt' | 'amountPaid' | 'updatedAt';
      sortOrder?: 'asc' | 'desc';
    } = {},
    actor?: AuthActor
  ): Promise<{
    data: PaymentWithRelations[];
    meta: {
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };
  }> {
    const skip = (page - 1) * pageSize;

    // Construir where clause
    const where: any = {};

    // Aplicar RBAC
    if (actor?.role === Role.VENTANA && actor?.ventanaId) {
      // VENTANA solo ve sus propios pagos
      where.ticket = {
        ventanaId: actor.ventanaId,
      };
    } else if (actor?.role === Role.VENDEDOR) {
      // VENDEDOR no tiene acceso
      throw new AppError("No autorizado para listar pagos", 403);
    }

    // Filtros adicionales
    if (filters.ventanaId) {
      where.ticket = { ...where.ticket, ventanaId: filters.ventanaId };
    }

    if (filters.vendedorId) {
      where.ticket = { ...where.ticket, vendedorId: filters.vendedorId };
    }

    if (filters.ticketId) {
      where.ticketId = filters.ticketId;
    }

    // Filtro por status de pago
    if (filters.status) {
      switch (filters.status) {
        case 'pending':
          where.AND = [
            { isReversed: false },
            { isFinal: false },
          ];
          break;
        case 'completed':
          where.AND = [
            { isReversed: false },
            { isFinal: true },
          ];
          break;
        case 'reversed':
          where.isReversed = true;
          break;
        case 'partial':
          where.AND = [
            { isPartial: true },
            { isReversed: false },
          ];
          break;
      }
    }

    // Filtro por fecha
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = filters.fromDate;
      if (filters.toDate) where.createdAt.lte = filters.toDate;
    }

    // Ejecutar queries
    const [data, total] = await Promise.all([
      prisma.ticketPayment.findMany({
        where,
        skip,
        take: pageSize,
        include: {
          ticket: {
            include: { ventana: true, vendedor: true },
          },
          paidBy: true,
        },
        orderBy: {
          [filters.sortBy || 'createdAt']: filters.sortOrder || 'desc',
        },
      }),
      prisma.ticketPayment.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  /**
   * Reversión de un pago (marcado lógico, sin borrar registro).
   * Si el pago había cambiado el status a PAID, revierte a EVALUATED.
   */
  async reverse(id: string, userId: string, actor?: AuthActor): Promise<PaymentWithRelations> {
    const existing = await prisma.ticketPayment.findUnique({
      where: { id },
      include: { ticket: { include: { ventana: true } } },
    });
    if (!existing) throw new AppError("Pago no encontrado", 404);
    if (existing.isReversed)
      throw new AppError("El pago ya fue revertido", 409);

    // Validar RBAC
    if (actor?.role === Role.VENTANA && existing.ticket.ventanaId !== actor.ventanaId) {
      throw new AppError("No autorizado para revertir este pago", 403);
    }

    // Si el pago estaba final, necesitamos revertir el status del tiquete
    const wasTicketMarkedPaid =
      existing.isFinal || (!existing.isPartial && !existing.isReversed);

    const reversed = await prisma.$transaction(async (tx) => {
      // Revertir pago
      const updatedPayment = await tx.ticketPayment.update({
        where: { id },
        data: {
          isReversed: true,
          reversedAt: new Date(),
          reversedBy: userId,
        },
        include: { ticket: true, paidBy: true },
      });

      // Revertir status del tiquete si fue marcado como PAID
      if (wasTicketMarkedPaid && existing.ticket.status === TicketStatus.PAID) {
        await tx.ticket.update({
          where: { id: existing.ticketId },
          data: { status: TicketStatus.EVALUATED },
        });
      }

      return updatedPayment;
    });

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_PAYMENT_REVERSE,
      targetType: "TICKET_PAYMENT",
      targetId: id,
      details: {
        reversed: true,
        ticketNumber: existing.ticket.ticketNumber,
        amountReversed: existing.amountPaid,
      },
      layer: "service",
    });

    return reversed;
  },

  /**
   * Obtener detalles de un pago específico
   */
  async getById(id: string, actor?: AuthActor): Promise<PaymentWithRelations> {
    const payment = await prisma.ticketPayment.findUnique({
      where: { id },
      include: {
        ticket: {
          include: { ventana: true, vendedor: true, sorteo: true },
        },
        paidBy: true,
      },
    });

    if (!payment) throw new AppError("Pago no encontrado", 404);

    // RBAC: VENTANA solo puede ver sus propios pagos
    if (actor?.role === Role.VENTANA && payment.ticket.ventanaId !== actor.ventanaId) {
      throw new AppError("No autorizado para ver este pago", 403);
    }

    return payment;
  },

  /**
   * Actualizar un pago (marcar como final, agregar notas)
   */
  async update(
    id: string,
    data: { isFinal?: boolean; notes?: string },
    userId: string,
    actor?: AuthActor
  ): Promise<PaymentWithRelations> {
    const existing = await prisma.ticketPayment.findUnique({
      where: { id },
      include: { ticket: true },
    });

    if (!existing) throw new AppError("Pago no encontrado", 404);
    if (existing.isReversed)
      throw new AppError("No se puede editar un pago revertido", 409);

    // RBAC
    if (actor?.role === Role.VENTANA && existing.ticket.ventanaId !== actor.ventanaId) {
      throw new AppError("No autorizado para editar este pago", 403);
    }

    // Si estamos marcando como final y es parcial, cambiar status a PAID
    const willBeFinal = data.isFinal ?? existing.isFinal;
    const isPartial = existing.isPartial;
    const shouldUpdateTicketStatus =
      willBeFinal && isPartial && existing.ticket.status !== TicketStatus.PAID;

    const updated = await prisma.$transaction(async (tx) => {
      // Actualizar pago
      const updatedPayment = await tx.ticketPayment.update({
        where: { id },
        data: {
          isFinal: willBeFinal,
          notes: data.notes ?? existing.notes,
          completedAt: willBeFinal && !existing.completedAt ? new Date() : existing.completedAt,
        },
        include: { ticket: true, paidBy: true },
      });

      // Actualizar ticket a PAID si aplica
      if (shouldUpdateTicketStatus) {
        await tx.ticket.update({
          where: { id: existing.ticketId },
          data: { status: TicketStatus.PAID },
        });

        await ActivityService.log({
          userId,
          action: ActivityType.TICKET_STATUS_PAID,
          targetType: "TICKET",
          targetId: existing.ticketId,
          details: {
            ticketNumber: existing.ticket.ticketNumber,
            newStatus: TicketStatus.PAID,
            fromStatus: TicketStatus.EVALUATED,
          },
          layer: "service",
        });
      }

      return updatedPayment;
    });

    // Log de actualización
    if (data.isFinal && isPartial) {
      await ActivityService.log({
        userId,
        action: ActivityType.TICKET_PAY_FINALIZE,
        targetType: "TICKET_PAYMENT",
        targetId: id,
        details: {
          ticketNumber: existing.ticket.ticketNumber,
          finalAmount: existing.amountPaid,
          remainingAccepted: existing.remainingAmount,
        },
        layer: "service",
      });
    }

    return updated;
  },

  /**
   * Obtener historial de pagos de un tiquete
   */
  async getPaymentHistory(
    ticketId: string,
    actor?: AuthActor
  ): Promise<{
    ticketId: string;
    ticketNumber: string;
    totalPayout: number;
    totalPaid: number;
    remainingAmount: number;
    ticketStatus: TicketStatus;
    payments: PaymentWithRelations[];
  }> {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        jugadas: true,
        ventana: true,
      },
    });

    if (!ticket) throw new AppError("Tiquete no encontrado", 404);

    // RBAC
    if (actor?.role === Role.VENTANA && ticket.ventanaId !== actor.ventanaId) {
      throw new AppError("No autorizado para ver este tiquete", 403);
    }

    const payments = await prisma.ticketPayment.findMany({
      where: { ticketId, isReversed: false },
      include: { paidBy: true },
      orderBy: { createdAt: 'asc' },
    });

    const totalPayout = ticket.jugadas
      .filter(j => j.isWinner)
      .reduce((acc, j) => acc + (j.payout ?? 0), 0);

    const totalPaid = payments.reduce((acc, p) => acc + p.amountPaid, 0);
    const remainingAmount = totalPayout - totalPaid;

    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      totalPayout,
      totalPaid,
      remainingAmount,
      ticketStatus: ticket.status,
      payments,
    };
  },
};

export default TicketPaymentService;
