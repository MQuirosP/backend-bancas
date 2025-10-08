import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import ActivityService from "../../../core/activity.service";
import { ActivityType, Role, TicketPayment, User } from "@prisma/client";
import { CreatePaymentInput } from "../dto/ticketPayment.dto";

interface AuthActor {
  id: string;
  role: Role;
  ventanaId?: string | null;
}

export const TicketPaymentService = {
  /**
   * Registra un pago de tiquete ganador (total o parcial)
   * con validaciones de idempotencia, rol y monto.
   */
  async create(
    data: CreatePaymentInput,
    actor: AuthActor
  ): Promise<TicketPayment> {
    const { id: userId, role } = actor;

    const ticket = await prisma.ticket.findUnique({
      where: { id: data.ticketId },
      include: { jugadas: true },
    });
    if (!ticket) throw new AppError("Tiquete no encontrado", 404);
    if (!ticket.isWinner) throw new AppError("El tiquete no es ganador", 409);

    const allowedRoles: Role[] = [Role.ADMIN, Role.VENTANA];
    if (!allowedRoles.includes(role)) {
      throw new AppError("No autorizado para registrar pagos", 403);
    }

    // 🧩 Idempotencia
    if (data.idempotencyKey) {
      const existingKey = await prisma.ticketPayment.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (existingKey) return existingKey;
    }

    // 🔐 Verificar si ya hay pago previo
    const existingPayment = await prisma.ticketPayment.findFirst({
      where: { ticketId: ticket.id, isReversed: false },
    });
    if (existingPayment)
      throw new AppError("El tiquete ya fue pagado o está en proceso", 409);

    // 💰 Calcular total del premio
    const totalPayout = ticket.jugadas
      .filter((j) => j.isWinner)
      .reduce((acc, j) => acc + (j.payout ?? 0), 0);

    const isPartial = data.amountPaid < totalPayout;
    const remainingAmount = isPartial ? totalPayout - data.amountPaid : 0;

    const payment = await prisma.ticketPayment.create({
      data: {
        ticketId: ticket.id,
        amountPaid: data.amountPaid,
        paidById: userId,
        method: data.method,
        notes: data.notes,
        isPartial,
        remainingAmount,
        idempotencyKey: data.idempotencyKey,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_PAY,
      targetType: "TICKET_PAYMENT",
      targetId: payment.id,
      details: {
        ticketNumber: ticket.ticketNumber,
        amountPaid: data.amountPaid,
        isPartial,
        remainingAmount,
      },
      layer: "service",
    });

    return payment;
  },

  /**
   * Lista paginada de pagos registrados.
   */
  async list(
    page = 1,
    pageSize = 10
  ): Promise<{
    data: (TicketPayment & { ticket: any; paidBy: any })[];
    meta: { total: number; page: number; pageSize: number; totalPages: number };
  }> {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      prisma.ticketPayment.findMany({
        skip,
        take: pageSize,
        include: { ticket: true, paidBy: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.ticketPayment.count(),
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
   */
  async reverse(id: string, userId: string): Promise<TicketPayment> {
    const existing = await prisma.ticketPayment.findUnique({ where: { id } });
    if (!existing) throw new AppError("Pago no encontrado", 404);
    if (existing.isReversed)
      throw new AppError("El pago ya fue revertido", 409);

    const reversed = await prisma.ticketPayment.update({
      where: { id },
      data: {
        isReversed: true,
        reversedAt: new Date(),
        reversedBy: userId,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.TICKET_PAYMENT_REVERSE,
      targetType: "TICKET_PAYMENT",
      targetId: id,
      details: { reversed: true },
      layer: "service",
    });

    return reversed;
  },
};

export default TicketPaymentService;
