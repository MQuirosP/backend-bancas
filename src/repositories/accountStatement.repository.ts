import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";

export const AccountStatementRepository = {
  /**
   * Encuentra o crea un estado de cuenta para una fecha específica
   */
  async findOrCreate(data: {
    date: Date;
    month: string;
    ventanaId?: string;
    vendedorId?: string;
  }) {
    const where: Prisma.AccountStatementWhereInput = {};

    if (data.ventanaId) {
      where.date = data.date;
      where.ventanaId = data.ventanaId;
      where.vendedorId = null;
    } else if (data.vendedorId) {
      where.date = data.date;
      where.vendedorId = data.vendedorId;
      where.ventanaId = null;
    } else {
      where.date = data.date;
      where.ventanaId = null;
      where.vendedorId = null;
    }

    const existing = await prisma.accountStatement.findFirst({
      where,
    });

    if (existing) {
      return existing;
    }

    return await prisma.accountStatement.create({
      data: {
        date: data.date,
        month: data.month,
        ventanaId: data.ventanaId ?? null,
        vendedorId: data.vendedorId ?? null,
      },
    });
  },

  /**
   * Actualiza un estado de cuenta
   */
  async update(id: string, data: {
    totalSales?: number;
    totalPayouts?: number;
    listeroCommission?: number;
    vendedorCommission?: number;
    balance?: number;
    totalPaid?: number;
    totalCollected?: number; // ✅ Campo para totales de collections
    remainingBalance?: number;
    isSettled?: boolean;
    canEdit?: boolean;
    ticketCount?: number;
    ventanaId?: string | null;
    vendedorId?: string | null;
    settledAt?: Date | null;
    settledBy?: string | null;
  }) {
    return await prisma.accountStatement.update({
      where: { id },
      data,
    });
  },

  /**
   * Obtiene estados de cuenta por mes
   */
  async findByMonth(
    month: string,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    },
    options: {
      sort?: "asc" | "desc";
      include?: Prisma.AccountStatementInclude;
    } = {}
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      month,
    };

    // ✅ CRÍTICO: Asegurar que cuando se busca por ventanaId, vendedorId es null, y viceversa
    // Esto es necesario porque el constraint requiere que solo uno de los dos sea no-null
    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
      where.vendedorId = null; // ✅ Asegurar que vendedorId es null para statements de ventana
    } else if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
      where.ventanaId = null; // ✅ Asegurar que ventanaId es null para statements de vendedor
    }

    return await prisma.accountStatement.findMany({
      where,
      orderBy: { date: options.sort || "desc" },
      include: options.include,
    });
  },

  /**
   * Obtiene totales acumulados del mes
   */
  async getMonthTotals(
    month: string,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      month,
    };

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

    const result = await prisma.accountStatement.aggregate({
      where,
      _sum: {
        totalSales: true,
        totalPayouts: true,
        listeroCommission: true,
        vendedorCommission: true,
        balance: true,
        totalPaid: true,
        remainingBalance: true,
      },
      _count: {
        id: true,
      },
    });

    const all = await prisma.accountStatement.findMany({
      where,
      select: { isSettled: true },
    });

    const settledDays = all.filter((s) => s.isSettled).length;
    const pendingDays = all.filter((s) => !s.isSettled).length;

    return {
      totalSales: result._sum.totalSales ?? 0,
      totalPayouts: result._sum.totalPayouts ?? 0,
      totalListeroCommission: result._sum.listeroCommission ?? 0,
      totalVendedorCommission: result._sum.vendedorCommission ?? 0,
      totalBalance: result._sum.balance ?? 0,
      totalPaid: result._sum.totalPaid ?? 0,
      totalRemainingBalance: result._sum.remainingBalance ?? 0,
      settledDays,
      pendingDays,
    };
  },

  /**
   * Obtiene un estado de cuenta por fecha
   */
  async findByDate(
    date: Date,
    filters: {
      ventanaId?: string;
      vendedorId?: string;
    }
  ) {
    const where: Prisma.AccountStatementWhereInput = {
      date,
    };

    // CRITICAL: El constraint requiere que solo uno de ventanaId o vendedorId sea no-null
    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
      where.vendedorId = null; // Asegurar que vendedorId es null para statements de ventana
    } else if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
      where.ventanaId = null; // Asegurar que ventanaId es null para statements de vendedor
    }
    // ✅ FIX: Si no se especifica ninguno, NO forzar ventanaId/vendedorId a null
    // Dejar que la query encuentre cualquier statement para esa fecha
    // (sin restricción de dimension)

    return await prisma.accountStatement.findFirst({
      where,
      include: {
        ventana: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        vendedor: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
    });
  },

  /**
   * Elimina un estado de cuenta
   */
  async delete(id: string) {
    return await prisma.accountStatement.delete({
      where: { id },
    });
  },

  /**
   * Obtiene un estado de cuenta por ID
   */
  async findById(id: string) {
    return await prisma.accountStatement.findUnique({
      where: { id },
      include: {
        payments: true, // Incluir todos los pagos para validación completa
      },
    });
  },
};

