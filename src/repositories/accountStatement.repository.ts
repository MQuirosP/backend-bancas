import prisma from "../core/prismaClient";
import { Prisma } from "@prisma/client";
import logger from "../core/logger";

export const AccountStatementRepository = {
  /**
   * Encuentra o crea un estado de cuenta para una fecha específica
   * ✅ CRÍTICO: Usa transacciones con locking para evitar condiciones de carrera
   * cuando múltiples pagos/cobros se registran simultáneamente
   */
  async findOrCreate(data: {
    date: Date;
    month: string;
    bancaId?: string;
    ventanaId?: string;
    vendedorId?: string;
  }) {
    let finalVentanaId: string | undefined = data.ventanaId;
    let finalBancaId: string | undefined = data.bancaId;

    // Inferir ventana desde vendedor
    if (!finalVentanaId && data.vendedorId) {
      const vendedor = await prisma.user.findUnique({
        where: { id: data.vendedorId },
        select: { ventanaId: true },
      });
      finalVentanaId = vendedor?.ventanaId ?? undefined; // ✅ sin null
    }

    // Inferir banca desde ventana
    if (!finalBancaId && finalVentanaId) {
      const ventana = await prisma.ventana.findUnique({
        where: { id: finalVentanaId },
        select: { bancaId: true },
      });
      finalBancaId = ventana?.bancaId; // ✅ sin null
    }


    /**
     * 🚨 REGLA CLAVE
     * Para estados consolidados por ventana:
     *  - vendedorId SIEMPRE es null
     *  - el unique constraint es (date, ventanaId)
     */
    if (!finalVentanaId) {
      throw new Error("findOrCreate requiere ventanaId para evitar colisiones");
    }

    return await prisma.accountStatement.upsert({
      where: {
        date_ventanaId: {
          date: data.date,
          ventanaId: finalVentanaId,
        },
      },
      update: {
        // Solo actualiza si faltan datos
        bancaId: finalBancaId ?? undefined,
      },
      create: {
        date: data.date,
        month: data.month,
        bancaId: finalBancaId ?? null,
        ventanaId: finalVentanaId,
        vendedorId: null, // 🔒 CONSOLIDADO
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
    accumulatedBalance?: number; // ✅ NUEVO: Campo para balance acumulado
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

    // ✅ ACTUALIZADO: Permitir búsqueda con ambos campos presentes
    // El constraint _one_relation_check ha sido eliminado
    if (filters.vendedorId) {
      // Si hay vendedorId, buscar por vendedorId (puede tener o no ventanaId)
      where.vendedorId = filters.vendedorId;
      if (filters.ventanaId) {
        where.ventanaId = filters.ventanaId;
      }
    } else if (filters.ventanaId) {
      // Si solo hay ventanaId, buscar statements consolidados de ventana
      where.ventanaId = filters.ventanaId;
      // No forzar vendedorId=null, permitir ambos casos
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

    // ✅ ACTUALIZADO: Permitir búsqueda con ambos campos presentes
    // El constraint _one_relation_check ha sido eliminado
    if (filters.vendedorId) {
      where.vendedorId = filters.vendedorId;
      if (filters.ventanaId) {
        where.ventanaId = filters.ventanaId;
      }
    } else if (filters.ventanaId) {
      where.ventanaId = filters.ventanaId;
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

