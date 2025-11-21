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
   * Fórmula correcta: remainingBalance = baseBalance - totalCollected + totalPaid
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
   * Fórmula correcta: remainingBalance = baseBalance - totalCollected + totalPaid
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

  /**
   * ✅ NUEVO: Obtiene total de pagos y cobros combinados (no revertidos) de un statement
   * Suma el valor absoluto de todos los movimientos activos (payment + collection)
   */
  async getTotalPaymentsCollections(accountStatementId: string) {
    const movements = await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
        isReversed: false, // Solo movimientos no revertidos
      },
      select: {
        amount: true,
      },
    });

    // Sumar el valor absoluto de todos los montos
    return movements.reduce((sum, m) => sum + Math.abs(m.amount), 0);
  },

  /**
   * Obtiene todos los pagos/cobros de un statement (para historial)
   */
  async findByStatementId(accountStatementId: string) {
    return await prisma.accountPayment.findMany({
      where: {
        accountStatementId,
      },
      orderBy: { createdAt: "asc" },
      include: {
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
   * ✅ OPTIMIZACIÓN: Obtiene totales de pagos y cobros para múltiples statements en una sola query
   * Retorna un Map<statementId, { totalPaid, totalCollected, totalPaymentsCollections }>
   */
  async getTotalsBatch(accountStatementIds: string[]): Promise<Map<string, { totalPaid: number; totalCollected: number; totalPaymentsCollections: number }>> {
    if (accountStatementIds.length === 0) {
      return new Map();
    }

    // Obtener todos los pagos activos de los statements en una sola query
    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId: { in: accountStatementIds },
        isReversed: false,
      },
      select: {
        accountStatementId: true,
        type: true,
        amount: true,
      },
    });

    // Agrupar por statementId y tipo
    const totalsMap = new Map<string, { totalPaid: number; totalCollected: number; totalPaymentsCollections: number }>();
    
    // Inicializar todos los statements con 0
    for (const id of accountStatementIds) {
      totalsMap.set(id, { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 });
    }

    // Sumar los montos
    for (const payment of payments) {
      const totals = totalsMap.get(payment.accountStatementId) || { totalPaid: 0, totalCollected: 0, totalPaymentsCollections: 0 };
      const absAmount = Math.abs(payment.amount);
      if (payment.type === "payment") {
        totals.totalPaid += payment.amount;
      } else if (payment.type === "collection") {
        totals.totalCollected += payment.amount;
      }
      // ✅ NUEVO: Sumar valor absoluto para totalPaymentsCollections
      totals.totalPaymentsCollections += absAmount;
      totalsMap.set(payment.accountStatementId, totals);
    }

    return totalsMap;
  },

  /**
   * ✅ OPTIMIZACIÓN: Obtiene todos los movimientos de múltiples statements en una sola query
   * Retorna un Map<statementId, movements[]>
   */
  async findMovementsBatch(accountStatementIds: string[]): Promise<Map<string, any[]>> {
    if (accountStatementIds.length === 0) {
      return new Map();
    }

    const payments = await prisma.accountPayment.findMany({
      where: {
        accountStatementId: { in: accountStatementIds },
      },
      orderBy: { createdAt: "asc" },
      include: {
        paidBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Agrupar por statementId
    const movementsMap = new Map<string, any[]>();
    for (const id of accountStatementIds) {
      movementsMap.set(id, []);
    }

    for (const payment of payments) {
      const movements = movementsMap.get(payment.accountStatementId) || [];
      movements.push({
        id: payment.id,
        accountStatementId: payment.accountStatementId,
        date: payment.date.toISOString().split("T")[0],
        amount: payment.amount,
        type: payment.type,
        method: payment.method,
        notes: payment.notes,
        isFinal: payment.isFinal,
        isReversed: payment.isReversed,
        reversedAt: payment.reversedAt?.toISOString() || null,
        reversedBy: payment.reversedBy,
        paidById: payment.paidById,
        paidByName: payment.paidByName,
        createdAt: payment.createdAt.toISOString(),
        updatedAt: payment.updatedAt.toISOString(),
      });
      movementsMap.set(payment.accountStatementId, movements);
    }

    return movementsMap;
  },
};

