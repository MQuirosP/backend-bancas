import { Prisma } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";

/**
 * Dashboard Service
 * Calcula métricas financieras: Ganancia, CxC (Cuentas por Cobrar), CxP (Cuentas por Pagar)
 */

interface DashboardFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string; // Para RBAC
  scope?: 'all' | 'byVentana';
}

interface GananciaResult {
  totalAmount: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    amount: number;
  }>;
  byLoteria: Array<{
    loteriaId: string;
    loteriaName: string;
    amount: number;
  }>;
}

interface CxCResult {
  totalAmount: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPaidOut: number;
    amount: number; // sales - payouts
  }>;
}

interface CxPResult {
  totalAmount: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    totalWinners: number;
    totalPaidOut: number;
    amount: number; // winners - sales (when positive)
  }>;
}

interface DashboardSummary {
  totalSales: number;
  totalPayouts: number;
  totalCommissions: number;
  totalTickets: number;
  winningTickets: number;
}

export const DashboardService = {
  /**
   * Calcula ganancia: Sum de comisiones + premium retenido
   */
  async calculateGanancia(filters: DashboardFilters): Promise<GananciaResult> {
    // Base where clause
    const where: any = {
      ticket: {
        deletedAt: null,
        createdAt: {
          gte: filters.fromDate,
          lte: filters.toDate,
        },
      },
      isWinner: true,
    };

    // RBAC: si es VENTANA específica, filtrar
    if (filters.ventanaId) {
      where.ticket.ventanaId = filters.ventanaId;
    }

    // Query: suma de comisiones por ventana y lotería
    const result = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        loteria_id: string;
        loteria_name: string;
        total_commission: number | null;
      }>
    >(
      Prisma.sql`
        SELECT
          v.id as ventana_id,
          v.name as ventana_name,
          l.id as loteria_id,
          l.name as loteria_name,
          COALESCE(SUM(j."commissionAmount"), 0) as total_commission
        FROM "Jugada" j
        JOIN "Ticket" t ON j."ticketId" = t."id"
        JOIN "Sorteo" s ON t."sorteoId" = s."id"
        JOIN "Loteria" l ON t."loteriaId" = l."id"
        JOIN "Ventana" v ON t."ventanaId" = v."id"
        WHERE t."deletedAt" IS NULL
          AND s.status = 'EVALUATED'
          AND j."isWinner" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAGADO')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        GROUP BY v.id, v.name, l.id, l.name
        ORDER BY total_commission DESC
      `
    );

    // Agrupar resultados
    const byVentanaMap = new Map<string, { ventanaId: string; ventanaName: string; amount: number }>();
    const byLoteriaMap = new Map<string, { loteriaId: string; loteriaName: string; amount: number }>();
    let totalAmount = 0;

    result.forEach((row) => {
      const commission = Number(row.total_commission) || 0;
      totalAmount += commission;

      // Por ventana
      const ventanaKey = row.ventana_id;
      if (!byVentanaMap.has(ventanaKey)) {
        byVentanaMap.set(ventanaKey, {
          ventanaId: row.ventana_id,
          ventanaName: row.ventana_name,
          amount: 0,
        });
      }
      const ventanaRecord = byVentanaMap.get(ventanaKey)!;
      ventanaRecord.amount += commission;

      // Por lotería
      const loteriaKey = row.loteria_id;
      if (!byLoteriaMap.has(loteriaKey)) {
        byLoteriaMap.set(loteriaKey, {
          loteriaId: row.loteria_id,
          loteriaName: row.loteria_name,
          amount: 0,
        });
      }
      const loteriaRecord = byLoteriaMap.get(loteriaKey)!;
      loteriaRecord.amount += commission;
    });

    return {
      totalAmount,
      byVentana: Array.from(byVentanaMap.values()),
      byLoteria: Array.from(byLoteriaMap.values()),
    };
  },

  /**
   * Calcula CxC: Monto que ventana debe al banco por premios no pagados
   * CxC = Total de ventas - Total de premios pagados
   */
  async calculateCxC(filters: DashboardFilters): Promise<CxCResult> {
    const query = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        total_sales: number;
        total_paid: number;
      }>
    >(
      Prisma.sql`
        SELECT
          v.id as ventana_id,
          v.name as ventana_name,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(tp."amountPaid"), 0) as total_paid
        FROM "Ventana" v
        LEFT JOIN "Ticket" t ON v.id = t."ventanaId"
          AND t."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAGADO')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
        LEFT JOIN "TicketPayment" tp ON t.id = tp."ticketId"
          AND tp."isReversed" = false
          AND tp."createdAt" >= ${filters.fromDate}
          AND tp."createdAt" <= ${filters.toDate}
        ${filters.ventanaId ? Prisma.sql`WHERE v.id = ${filters.ventanaId}` : Prisma.empty}
        GROUP BY v.id, v.name
      `
    );

    const byVentana = query.map((row) => {
      const totalSales = Number(row.total_sales) || 0;
      const totalPaidOut = Number(row.total_paid) || 0;
      const amount = totalSales - totalPaidOut;

      return {
        ventanaId: row.ventana_id,
        ventanaName: row.ventana_name,
        totalSales,
        totalPaidOut,
        amount: amount > 0 ? amount : 0, // Solo mostrar si es positivo
      };
    });

    const totalAmount = byVentana.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVentana,
    };
  },

  /**
   * Calcula CxP: Monto que banco debe a ventana por overpayment
   * CxP ocurre cuando ventana paga más de lo que vendió
   */
  async calculateCxP(filters: DashboardFilters): Promise<CxPResult> {
    const query = await prisma.$queryRaw<
      Array<{
        ventana_id: string;
        ventana_name: string;
        total_winners: number;
        total_paid: number;
      }>
    >(
      Prisma.sql`
        SELECT
          v.id as ventana_id,
          v.name as ventana_name,
          COALESCE(SUM(j."payout"), 0) as total_winners,
          COALESCE(SUM(tp."amountPaid"), 0) as total_paid
        FROM "Ventana" v
        LEFT JOIN "Ticket" t ON v.id = t."ventanaId"
          AND t."deletedAt" IS NULL
          AND t.status IN ('EVALUATED', 'PAGADO')
          AND t."isWinner" = true
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
        LEFT JOIN "Jugada" j ON t.id = j."ticketId"
          AND j."isWinner" = true
          AND j."deletedAt" IS NULL
        LEFT JOIN "TicketPayment" tp ON t.id = tp."ticketId"
          AND tp."isReversed" = false
          AND tp."createdAt" >= ${filters.fromDate}
          AND tp."createdAt" <= ${filters.toDate}
        ${filters.ventanaId ? Prisma.sql`WHERE v.id = ${filters.ventanaId}` : Prisma.empty}
        GROUP BY v.id, v.name
      `
    );

    const byVentana = query.map((row) => {
      const totalWinners = Number(row.total_winners) || 0;
      const totalPaidOut = Number(row.total_paid) || 0;
      const amount = totalPaidOut - totalWinners;

      return {
        ventanaId: row.ventana_id,
        ventanaName: row.ventana_name,
        totalWinners,
        totalPaidOut,
        amount: amount > 0 ? amount : 0, // Solo mostrar si es positivo
      };
    });

    const totalAmount = byVentana.reduce((sum, v) => sum + v.amount, 0);

    return {
      totalAmount,
      byVentana,
    };
  },

  /**
   * Resumen general: totales de ventas, pagos, comisiones
   */
  async getSummary(filters: DashboardFilters): Promise<DashboardSummary> {
    const [sales, payouts, commissions, tickets] = await Promise.all([
      prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(t."totalAmount"), 0) as total
          FROM "Ticket" t
          WHERE t."deletedAt" IS NULL
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAGADO')
            AND t."createdAt" >= ${filters.fromDate}
            AND t."createdAt" <= ${filters.toDate}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        `
      ),
      prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(j."payout"), 0) as total
          FROM "Jugada" j
          JOIN "Ticket" t ON j."ticketId" = t."id"
          WHERE t."deletedAt" IS NULL
            AND j."isWinner" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAGADO')
            AND t."createdAt" >= ${filters.fromDate}
            AND t."createdAt" <= ${filters.toDate}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        `
      ),
      prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(j."commissionAmount"), 0) as total
          FROM "Jugada" j
          JOIN "Ticket" t ON j."ticketId" = t."id"
          WHERE t."deletedAt" IS NULL
            AND j."isWinner" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAGADO')
            AND t."createdAt" >= ${filters.fromDate}
            AND t."createdAt" <= ${filters.toDate}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        `
      ),
      prisma.ticket.count({
        where: {
          deletedAt: null,
          status: { in: ['ACTIVE', 'EVALUATED', 'PAGADO'] as any },
          createdAt: {
            gte: filters.fromDate,
            lte: filters.toDate,
          },
          ...(filters.ventanaId && { ventanaId: filters.ventanaId }),
        },
      }),
    ]);

    const winningTickets = await prisma.ticket.count({
      where: {
        deletedAt: null,
        isWinner: true,
        status: { in: ['ACTIVE', 'EVALUATED', 'PAGADO'] as any },
        createdAt: {
          gte: filters.fromDate,
          lte: filters.toDate,
        },
        ...(filters.ventanaId && { ventanaId: filters.ventanaId }),
      },
    });

    return {
      totalSales: Number(sales[0]?.total) || 0,
      totalPayouts: Number(payouts[0]?.total) || 0,
      totalCommissions: Number(commissions[0]?.total) || 0,
      totalTickets: tickets,
      winningTickets,
    };
  },

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   */
  async getFullDashboard(filters: DashboardFilters) {
    const [ganancia, cxc, cxp, summary] = await Promise.all([
      this.calculateGanancia(filters),
      this.calculateCxC(filters),
      this.calculateCxP(filters),
      this.getSummary(filters),
    ]);

    return {
      ganancia,
      cxc,
      cxp,
      summary,
      meta: {
        range: {
          fromAt: filters.fromDate.toISOString(),
          toAt: filters.toDate.toISOString(),
          tz: 'America/Costa_Rica',
        },
        scope: filters.scope || 'all',
        generatedAt: new Date().toISOString(),
      },
    };
  },
};

export default DashboardService;
