import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";

export const AccountPaymentRepository = {
  /**
   * Crea un pago/cobro
   */
  async create(data: {
    accountStatementId: string;
    date: Date;
    month: string;
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
    return await prisma.accountPayment.create({
      data,
      include: {
        accountStatement: true,
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Encuentra un pago por idempotencyKey
   */
  async findByIdempotencyKey(idempotencyKey: string) {
    return await prisma.accountPayment.findUnique({
      where: { idempotencyKey },
    });
  },

  /**
   * Obtiene historial de pagos por fecha
   * Incluye TODOS los pagos (activos y revertidos) según el documento
   */
  async findByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
      includeReversed?: boolean;
    }
  ) {
    const where: Prisma.AccountPaymentWhereInput = {
      date,
      // Incluir todos los pagos (activos y revertidos) por defecto
      ...(filters.includeReversed === false ? { isReversed: false } : {}),
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    return await prisma.accountPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        reversedByUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Obtiene solo pagos activos (no revertidos) de un día
   * Usado para calcular saldos
   */
  async findActiveByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountPaymentWhereInput = {
      date,
      isReversed: false, // Solo pagos activos
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    return await prisma.accountPayment.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Obtiene un pago por ID
   */
  async findById(id: string) {
    return await prisma.accountPayment.findUnique({
      where: { id },
      include: {
        accountStatement: true,
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
        reversedByUser: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
  },

  /**
   * Revierte un pago
   */
  async reverse(id: string, reversedBy: string) {
    return await prisma.accountPayment.update({
      where: { id },
      data: {
        isReversed: true,
        reversedAt: new Date(),
        reversedBy,
      },
      include: {
        accountStatement: true,
      },
    });
  },

  /**
   * Obtiene total pagado (solo payments) de un statement
   * Según el documento: remainingBalance = baseBalance - totalPaid + totalCollected
   * Este método retorna solo totalPaid (suma de payments)
   */
  async getTotalPaid(accountStatementId: string) {
    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
        isReversed: false,
        type: "payment", // Solo payments
      },
      select: {
        amount: true,
      },
    });

    return payments.reduce((sum, p) => sum + p.amount, 0);
  },

  /**
   * Obtiene total cobrado (solo collections) de un statement
   * Según el documento: remainingBalance = baseBalance - totalPaid + totalCollected
   */
  async getTotalCollected(accountStatementId: string) {
    const collections = await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
        isReversed: false,
        type: "collection", // Solo collections
      },
      select: {
        amount: true,
      },
    });

    return collections.reduce((sum, p) => sum + p.amount, 0);
  },
};

