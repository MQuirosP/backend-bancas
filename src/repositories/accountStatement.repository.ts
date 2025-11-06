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
    const where = data.ventanaId
      ? { date: data.date, ventanaId: data.ventanaId }
      : { date: data.date, vendedorId: data.vendedorId };

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
    remainingBalance?: number;
    isSettled?: boolean;
    canEdit?: boolean;
    ticketCount?: number;
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

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
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

    if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
    }
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
    }

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
};

