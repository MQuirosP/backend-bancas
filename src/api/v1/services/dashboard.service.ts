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
  loteriaId?: string; // Filtro por lotería
  betType?: 'NUMERO' | 'REVENTADO'; // Filtro por tipo de apuesta
  scope?: 'all' | 'byVentana';
  dimension?: 'ventana' | 'loteria' | 'vendedor'; // Agrupación
  top?: number; // Limitar resultados
  orderBy?: string; // Campo para ordenar
  order?: 'asc' | 'desc'; // Dirección
  page?: number; // Paginación
  pageSize?: number; // Tamaño de página
  interval?: 'day' | 'hour'; // Para timeseries
  aging?: boolean; // Para CxC aging
}

interface GananciaResult {
  totalAmount: number;
  totalSales: number;
  margin: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    amount: number;
    sales: number;
    margin: number;
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
  winRate: number;
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
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        GROUP BY v.id, v.name, l.id, l.name
        ORDER BY total_commission DESC
      `
    );

    // Obtener total de ventas para calcular margen
    const salesResult = await prisma.$queryRaw<Array<{ total_sales: number }>>(
      Prisma.sql`
        SELECT COALESCE(SUM(t."totalAmount"), 0) as total_sales
        FROM "Ticket" t
        WHERE t."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
      `
    );

    const totalSales = Number(salesResult[0]?.total_sales) || 0;

    // Agrupar resultados
    const byVentanaMap = new Map<string, { ventanaId: string; ventanaName: string; amount: number; sales: number }>();
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
          sales: 0,
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

    const margin = totalSales > 0 ? (totalAmount / totalSales) * 100 : 0;

    return {
      totalAmount,
      totalSales,
      margin: parseFloat(margin.toFixed(2)),
      byVentana: Array.from(byVentanaMap.values()).map(v => ({
        ...v,
        margin: v.sales > 0 ? parseFloat(((v.amount / v.sales) * 100).toFixed(2)) : 0,
      })),
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
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
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
          AND t.status IN ('EVALUATED', 'PAID')
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
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
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
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
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
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
            AND t."createdAt" >= ${filters.fromDate}
            AND t."createdAt" <= ${filters.toDate}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        `
      ),
      prisma.ticket.count({
        where: {
          deletedAt: null,
          status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] as any },
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
        status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] as any },
        createdAt: {
          gte: filters.fromDate,
          lte: filters.toDate,
        },
        ...(filters.ventanaId && { ventanaId: filters.ventanaId }),
      },
    });

    const totalSales = Number(sales[0]?.total) || 0;
    const totalPayouts = Number(payouts[0]?.total) || 0;
    const totalCommissions = Number(commissions[0]?.total) || 0;
    const winRate = tickets > 0 ? (winningTickets / tickets) * 100 : 0;

    return {
      totalSales,
      totalPayouts,
      totalCommissions,
      totalTickets: tickets,
      winningTickets,
      winRate: parseFloat(winRate.toFixed(2)),
    };
  },

  /**
   * Dashboard completo: combina ganancia, CxC, CxP y resumen
   */
  async getFullDashboard(filters: DashboardFilters) {
    const startTime = Date.now();
    let queryCount = 0;

    const [ganancia, cxc, cxp, summary, timeSeries, exposure, previousPeriod] = await Promise.all([
      this.calculateGanancia(filters).then(r => { queryCount += 3; return r; }),
      this.calculateCxC(filters).then(r => { queryCount += 1; return r; }),
      this.calculateCxP(filters).then(r => { queryCount += 1; return r; }),
      this.getSummary(filters).then(r => { queryCount += 4; return r; }),
      this.getTimeSeries({ ...filters, interval: filters.interval || 'day' }).then(r => { queryCount += 1; return r; }),
      this.calculateExposure(filters).then(r => { queryCount += 3; return r; }),
      this.calculatePreviousPeriod(filters).then(r => { queryCount += 4; return r; }),
    ]);

    const alerts = this.generateAlerts({ ganancia, cxc, cxp, summary, exposure });

    return {
      ganancia,
      cxc,
      cxp,
      summary,
      timeSeries: timeSeries.timeSeries,
      exposure,
      previousPeriod,
      alerts,
      meta: {
        range: {
          fromAt: filters.fromDate.toISOString(),
          toAt: filters.toDate.toISOString(),
          tz: 'America/Costa_Rica',
        },
        scope: filters.scope || 'all',
        generatedAt: new Date().toISOString(),
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
      },
    };
  },

  /**
   * Serie temporal: datos agrupados por día u hora para gráficos
   */
  async getTimeSeries(filters: DashboardFilters) {
    const interval = filters.interval || 'day';

    // Validación: interval=hour solo si rango <= 7 días
    if (interval === 'hour') {
      const diffDays = Math.ceil((filters.toDate.getTime() - filters.fromDate.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > 7) {
        throw new AppError('interval=hour solo permitido para rangos <= 7 días', 422);
      }
    }

    const dateFormat = interval === 'day'
      ? Prisma.sql`DATE_TRUNC('day', t."createdAt")`
      : Prisma.sql`DATE_TRUNC('hour', t."createdAt")`;

    const result = await prisma.$queryRaw<
      Array<{
        date_bucket: Date;
        total_sales: number;
        total_commissions: number;
        total_tickets: number;
      }>
    >(
      Prisma.sql`
        SELECT
          ${dateFormat} as date_bucket,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0) as total_commissions,
          COUNT(DISTINCT t.id) as total_tickets
        FROM "Ticket" t
        LEFT JOIN "Jugada" j ON t.id = j."ticketId" AND j."isWinner" = true AND j."deletedAt" IS NULL
        WHERE t."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
        GROUP BY date_bucket
        ORDER BY date_bucket ASC
      `
    );

    return {
      timeSeries: result.map(row => ({
        date: row.date_bucket.toISOString(),
        sales: Number(row.total_sales) || 0,
        commissions: Number(row.total_commissions) || 0,
        tickets: Number(row.total_tickets) || 0,
      })),
      meta: {
        interval,
        dataPoints: result.length,
      },
    };
  },

  /**
   * Exposición: análisis de riesgo por número y lotería
   */
  async calculateExposure(filters: DashboardFilters) {
    const topLimit = filters.top || 10;

    // Top números con mayor venta
    const topNumbers = await prisma.$queryRaw<
      Array<{
        number: string;
        bet_type: string;
        total_sales: number;
        potential_payout: number;
      }>
    >(
      Prisma.sql`
        SELECT
          j.number,
          j.type as bet_type,
          COALESCE(SUM(j.amount), 0) as total_sales,
          COALESCE(SUM(j.payout), 0) as potential_payout
        FROM "Jugada" j
        JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
          ${filters.betType ? Prisma.sql`AND j.type = ${filters.betType}` : Prisma.empty}
        GROUP BY j.number, j.type
        ORDER BY total_sales DESC
        LIMIT ${topLimit}
      `
    );

    // Heatmap: ventas por número (00-99)
    const heatmap = await prisma.$queryRaw<
      Array<{
        number: string;
        total_sales: number;
      }>
    >(
      Prisma.sql`
        SELECT
          j.number,
          COALESCE(SUM(j.amount), 0) as total_sales
        FROM "Jugada" j
        JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
        GROUP BY j.number
        ORDER BY j.number ASC
      `
    );

    // Exposición por lotería
    const byLoteria = await prisma.$queryRaw<
      Array<{
        loteria_id: string;
        loteria_name: string;
        total_sales: number;
        potential_payout: number;
      }>
    >(
      Prisma.sql`
        SELECT
          l.id as loteria_id,
          l.name as loteria_name,
          COALESCE(SUM(j.amount), 0) as total_sales,
          COALESCE(SUM(j.payout), 0) as potential_payout
        FROM "Jugada" j
        JOIN "Ticket" t ON j."ticketId" = t.id
        JOIN "Loteria" l ON t."loteriaId" = l.id
        WHERE t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
        GROUP BY l.id, l.name
        ORDER BY total_sales DESC
      `
    );

    return {
      topNumbers: topNumbers.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        return {
          number: row.number,
          betType: row.bet_type,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? (payout / sales) : 0,
        };
      }),
      heatmap: heatmap.map(row => ({
        number: row.number,
        sales: Number(row.total_sales) || 0,
      })),
      byLoteria: byLoteria.map(row => {
        const sales = Number(row.total_sales) || 0;
        const payout = Number(row.potential_payout) || 0;
        return {
          loteriaId: row.loteria_id,
          loteriaName: row.loteria_name,
          sales,
          potentialPayout: payout,
          ratio: sales > 0 ? (payout / sales) : 0,
        };
      }),
    };
  },

  /**
   * Ranking por vendedor: ventas, comisiones, tickets
   */
  async getVendedores(filters: DashboardFilters) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const offset = (page - 1) * pageSize;
    const orderBy = filters.orderBy || 'sales';
    const order = filters.order || 'desc';

    const orderClause = {
      sales: Prisma.sql`total_sales`,
      commissions: Prisma.sql`total_commissions`,
      tickets: Prisma.sql`total_tickets`,
      winners: Prisma.sql`winning_tickets`,
      avgTicket: Prisma.sql`avg_ticket`,
    }[orderBy] || Prisma.sql`total_sales`;

    const orderDirection = order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;

    const result = await prisma.$queryRaw<
      Array<{
        vendedor_id: string;
        vendedor_name: string;
        total_sales: number;
        total_commissions: number;
        total_tickets: number;
        winning_tickets: number;
        avg_ticket: number;
      }>
    >(
      Prisma.sql`
        SELECT
          u.id as vendedor_id,
          u.name as vendedor_name,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0) as total_commissions,
          COUNT(DISTINCT t.id) as total_tickets,
          COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as winning_tickets,
          CASE
            WHEN COUNT(DISTINCT t.id) > 0 THEN COALESCE(SUM(t."totalAmount"), 0) / COUNT(DISTINCT t.id)
            ELSE 0
          END as avg_ticket
        FROM "User" u
        JOIN "Ticket" t ON u.id = t."userId"
        LEFT JOIN "Jugada" j ON t.id = j."ticketId" AND j."isWinner" = true AND j."deletedAt" IS NULL
        WHERE t."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
        GROUP BY u.id, u.name
        ORDER BY ${orderClause} ${orderDirection}
        LIMIT ${pageSize}
        OFFSET ${offset}
      `
    );

    // Count total para paginación
    const totalCount = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        SELECT COUNT(DISTINCT u.id) as count
        FROM "User" u
        JOIN "Ticket" t ON u.id = t."userId"
        WHERE t."deletedAt" IS NULL
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
          AND t."createdAt" >= ${filters.fromDate}
          AND t."createdAt" <= ${filters.toDate}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}` : Prisma.empty}
      `
    );

    const total = Number(totalCount[0]?.count) || 0;

    return {
      byVendedor: result.map(row => ({
        vendedorId: row.vendedor_id,
        vendedorName: row.vendedor_name,
        sales: Number(row.total_sales) || 0,
        commissions: Number(row.total_commissions) || 0,
        tickets: Number(row.total_tickets) || 0,
        winners: Number(row.winning_tickets) || 0,
        avgTicket: Number(row.avg_ticket) || 0,
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  /**
   * Período anterior: para comparación de crecimiento
   */
  async calculatePreviousPeriod(filters: DashboardFilters) {
    const diffMs = filters.toDate.getTime() - filters.fromDate.getTime();
    const previousFromDate = new Date(filters.fromDate.getTime() - diffMs);
    const previousToDate = new Date(filters.fromDate.getTime() - 1);

    const previousFilters = {
      ...filters,
      fromDate: previousFromDate,
      toDate: previousToDate,
    };

    const [sales, commissions] = await Promise.all([
      prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(t."totalAmount"), 0) as total
          FROM "Ticket" t
          WHERE t."deletedAt" IS NULL
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
            AND t."createdAt" >= ${previousFromDate}
            AND t."createdAt" <= ${previousToDate}
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
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
            AND t."createdAt" >= ${previousFromDate}
            AND t."createdAt" <= ${previousToDate}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}` : Prisma.empty}
        `
      ),
    ]);

    return {
      sales: Number(sales[0]?.total) || 0,
      commissions: Number(commissions[0]?.total) || 0,
      range: {
        fromAt: previousFromDate.toISOString(),
        toAt: previousToDate.toISOString(),
      },
    };
  },

  /**
   * Sistema de alertas: detecta problemas y oportunidades
   */
  generateAlerts(data: any) {
    const alerts: Array<{
      type: string;
      severity: 'info' | 'warn' | 'critical';
      message: string;
      action: string;
    }> = [];

    // Thresholds (deberían venir de env)
    const CXC_THRESHOLD_WARN = 50000;
    const CXC_THRESHOLD_CRITICAL = 100000;
    const LOW_SALES_THRESHOLD = 10000;
    const EXPOSURE_THRESHOLD_WARN = 60;
    const EXPOSURE_THRESHOLD_CRITICAL = 80;

    // Alerta: CxC alto
    if (data.cxc.totalAmount > CXC_THRESHOLD_CRITICAL) {
      alerts.push({
        type: 'HIGH_CXC',
        severity: 'critical',
        message: `CxC total: ₡${data.cxc.totalAmount.toLocaleString()} excede umbral crítico`,
        action: 'Revisar ventanas con mayor deuda y gestionar cobro inmediato',
      });
    } else if (data.cxc.totalAmount > CXC_THRESHOLD_WARN) {
      alerts.push({
        type: 'HIGH_CXC',
        severity: 'warn',
        message: `CxC total: ₡${data.cxc.totalAmount.toLocaleString()} excede umbral de advertencia`,
        action: 'Monitorear cuentas por cobrar y planificar gestión de cobro',
      });
    }

    // Alerta: Ventas bajas
    if (data.summary.totalSales < LOW_SALES_THRESHOLD) {
      alerts.push({
        type: 'LOW_SALES',
        severity: 'warn',
        message: `Ventas bajas: ₡${data.summary.totalSales.toLocaleString()}`,
        action: 'Revisar actividad de vendedores y promociones activas',
      });
    }

    // Alerta: Alta exposición en número específico
    if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_CRITICAL) {
      alerts.push({
        type: 'HIGH_EXPOSURE',
        severity: 'critical',
        message: `Exposición crítica en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x`,
        action: 'Considerar límites de apuesta para este número',
      });
    } else if (data.exposure?.topNumbers?.[0]?.ratio > EXPOSURE_THRESHOLD_WARN) {
      alerts.push({
        type: 'HIGH_EXPOSURE',
        severity: 'warn',
        message: `Exposición alta en número ${data.exposure.topNumbers[0].number}: ${data.exposure.topNumbers[0].ratio.toFixed(0)}x`,
        action: 'Monitorear ventas en este número',
      });
    }

    // Alerta: Overpayment (CxP > 0)
    if (data.cxp.totalAmount > 0) {
      alerts.push({
        type: 'OVERPAYMENT',
        severity: 'info',
        message: `CxP detectado: ₡${data.cxp.totalAmount.toLocaleString()}`,
        action: 'Banco debe liquidar con ventanas',
      });
    }

    return alerts;
  },
};

export default DashboardService;
