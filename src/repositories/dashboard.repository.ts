/**
 * Repositorio de Dashboard
 * 
 * ÚNICA capa autorizada para ejecutar consultas directas de base de datos y SQL crudo
 * correspondientes a métricas, analíticas y reportes consolidados del dashboard.
 */

import { Prisma } from "../generated/prisma/client";
import prisma from "../core/prismaClient";

export interface VentanaStatementRow {
  ventana_id: string;
  ventana_name: string;
  is_active: boolean;
  total_sales: number;
  total_payouts: number;
  total_tickets: number;
  commission_user: number;
  commission_ventana: number;
}

export interface WinnerCountRow {
  ventana_id: string;
  count: number;
}

export interface LoteriaStatsRow {
  loteria_id: string;
  loteria_name: string;
  is_active: boolean;
  total_sales: number;
  total_payouts: number;
  total_tickets: number;
  winning_tickets: number;
  commission_user: number;
  commission_ventana: number;
}

export interface ExposureRow {
  sorteoId: string;
  sorteo_name: string;
  draw_time: Date;
  sorteo_status: string;
  loteriaId: string;
  loteria_name: string;
  number: string;
  bet_type: string;
  ticket_count: bigint | number;
  sales: number;
  potential_payout: number;
}

export interface DashboardSummaryByVentanaRow {
  ventana_id: string;
  ventana_name: string;
  is_active: boolean;
  total_sales: string;
  total_payouts: string;
  listero_commission: string;
  vendedor_commission: string;
  ticket_count: string;
  remaining_balance: string;
  vendedores_remaining_balance: string;
}

export interface DashboardSummaryMtdRow {
  total_sales: string;
  total_payouts: string;
  listero_commission: string;
  vendedor_commission: string;
}

export interface DashboardEntitiesRow {
  vendedor_id: string;
  vendedor_name: string;
  vendedor_code: string | null;
  is_active: boolean;
  ventana_id: string;
  ventana_name: string;
  total_sales: string;
  total_payouts: string;
  listero_commission: string;
  vendedor_commission: string;
  ticket_count: string;
  remaining_balance: string;
}

export class DashboardRepository {
  /**
   * Obtiene agregados de AccountStatement por ventana para el cálculo de Ganancia
   */
  static async getVentanaStatements(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          v.id AS ventana_id,
          v.name AS ventana_name,
          v."isActive" AS is_active,
          COALESCE(SUM(a."totalSales"), 0) AS total_sales,
          COALESCE(SUM(a."totalPayouts"), 0) AS total_payouts,
          COALESCE(SUM(a."ticketCount"), 0) AS total_tickets,
          COALESCE(SUM(a."vendedorCommission"), 0) AS commission_user,
          COALESCE(SUM(a."listeroCommission"), 0) AS commission_ventana
        FROM "Ventana" v
        LEFT JOIN "AccountStatement" a ON a."ventanaId" = v.id 
          AND a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          AND a."vendedorId" IS NULL
        WHERE v."isActive" = true
          ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
          ${filters.ventanaId ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
        GROUP BY v.id, v.name, v."isActive"
        ORDER BY total_sales DESC
      `
    );
  }

  /**
   * Conteo de tickets ganadores por ventana usando índice parcial idx_ticket_winner_status_date
   */
  static async getWinnerCountRows(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string }
  ): Promise<WinnerCountRow[]> {
    return prisma.$queryRaw<WinnerCountRow[]>(
      Prisma.sql`
        SELECT "ventanaId" AS ventana_id, COUNT(*)::int AS count
        FROM "Ticket"
        WHERE "isWinner" = true
          AND "deletedAt" IS NULL
          AND "isActive" = true
          AND "businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.bancaId ? Prisma.sql`AND "bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
          ${filters.ventanaId ? Prisma.sql`AND "ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
          ${filters.vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        GROUP BY "ventanaId"
      `
    );
  }

  /**
   * Estadísticas de tickets agregadas por lotería
   */
  static async getByLoteriaStats(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          l.id AS loteria_id,
          l.name AS loteria_name,
          l."isActive" AS is_active,
          COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
          COALESCE(SUM(t."totalPayout"), 0) AS total_payouts,
          COUNT(t.id) AS total_tickets,
          COUNT(CASE WHEN t."isWinner" = true THEN 1 END) AS winning_tickets,
          COALESCE(SUM(t."totalCommission"), 0) AS commission_user,
          COALESCE(SUM(t."totalListeroCommission"), 0) AS commission_ventana
        FROM "Loteria" l
        LEFT JOIN "Ticket" t ON t."loteriaId" = l.id
          AND t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
          ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
          ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        WHERE l."isActive" = true
        GROUP BY l.id, l.name, l."isActive"
        ORDER BY total_sales DESC
      `
    );
  }

  /**
   * Consulta de pagos de cuenta
   */
  static async getAccountPayments(where: Prisma.AccountPaymentWhereInput) {
    return prisma.accountPayment.findMany({
      where,
      select: {
        ventanaId: true,
        type: true,
        amount: true,
      },
    });
  }

  /**
   * Datos consolidados de AccountStatement, cobros y pagos para CxC/CxP por Ventana
   */
  static async getCxCVentanaData(
    rangeStart: Date,
    rangeEnd: Date,
    filters: { ventanaId?: string; bancaId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "ventanaId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL
        GROUP BY "ventanaId"
      ),
      collections_agg AS (
        SELECT "ventanaId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "ventanaId"
      ),
      ticket_payments_agg AS (
        SELECT t."ventanaId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL
        GROUP BY t."ventanaId"
      )
      SELECT v.id AS ventana_id, v.name AS ventana_name, v."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "Ventana" v
      LEFT JOIN account_agg aa ON aa."ventanaId" = v.id
      LEFT JOIN collections_agg ca ON ca."ventanaId" = v.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."ventanaId" = v.id
      WHERE v."isActive" = true
      ${filters.ventanaId ? Prisma.sql`AND v.id = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
      ORDER BY total_sales DESC
    `);
  }

  /**
   * Datos consolidados de AccountStatement, cobros y pagos para CxC/CxP por Vendedor
   */
  static async getCxCVendedorData(
    rangeStart: Date,
    rangeEnd: Date,
    filters: { ventanaId?: string; bancaId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(Prisma.sql`
      WITH account_agg AS (
        SELECT "vendedorId",
               COALESCE(SUM("totalSales"), 0) AS total_sales,
               COALESCE(SUM("totalPayouts"), 0) AS total_payouts,
               COALESCE(SUM("vendedorCommission"), 0) AS commission_user,
               COALESCE(SUM("listeroCommission"), 0) AS commission_ventana_raw,
               COALESCE(SUM("listeroCommission"), 0) AS listero_commission_snapshot,
               COALESCE(SUM("totalPaid"), 0) AS total_paid
        FROM "AccountStatement"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL
        GROUP BY "vendedorId"
      ),
      collections_agg AS (
        SELECT "vendedorId", COALESCE(SUM("amount"), 0) AS total_collected
        FROM "AccountPayment"
        WHERE "date" BETWEEN ${rangeStart} AND ${rangeEnd} AND "vendedorId" IS NOT NULL AND "isReversed" = false AND "type" = 'collection'
        GROUP BY "vendedorId"
      ),
      ticket_payments_agg AS (
        SELECT t."vendedorId", COALESCE(SUM(tp."amountPaid"), 0) AS total_paid_to_customer
        FROM "TicketPayment" tp
        JOIN "Ticket" t ON t.id = tp."ticketId"
        WHERE tp."isReversed" = false AND tp."paymentDate" BETWEEN ${rangeStart} AND ${rangeEnd} AND t."deletedAt" IS NULL AND t."vendedorId" IS NOT NULL
        GROUP BY t."vendedorId"
      )
      SELECT u.id AS vendedor_id, u.name AS vendedor_name, u.code AS vendedor_code, 
             u."ventanaId" AS ventana_id, v.name AS ventana_name, u."isActive" AS is_active,
             COALESCE(aa.total_sales, 0) AS total_sales,
             COALESCE(aa.total_payouts, 0) AS total_payouts,
             COALESCE(aa.commission_user, 0) AS commission_user,
             COALESCE(aa.commission_ventana_raw, 0) AS commission_ventana_raw,
             COALESCE(aa.listero_commission_snapshot, 0) AS listero_commission_snapshot,
             COALESCE(aa.total_paid, 0) AS total_paid,
             COALESCE(ca.total_collected, 0) AS total_collected,
             COALESCE(tpa.total_paid_to_customer, 0) AS total_paid_to_customer
      FROM "User" u
      LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
      LEFT JOIN account_agg aa ON aa."vendedorId" = u.id
      LEFT JOIN collections_agg ca ON ca."vendedorId" = u.id
      LEFT JOIN ticket_payments_agg tpa ON tpa."vendedorId" = u.id
      WHERE u."isActive" = true AND u.role = 'VENDEDOR'
      ${filters.ventanaId ? Prisma.sql`AND u."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      ${filters.bancaId ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
    `);
  }

  /**
   * Serie temporal histórica desde AccountStatement
   */
  static async getHistoricalTimeSeries(
    selectClause: Prisma.Sql,
    groupByClause: Prisma.Sql,
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          ${selectClause} as date_bucket,
          COALESCE(SUM(a."totalSales"), 0) as total_sales,
          COALESCE(SUM(a."vendedorCommission" + a."listeroCommission"), 0) as total_commissions,
          COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
          COALESCE(SUM(a."totalPayouts"), 0) as total_payout,
          0 as total_winners
        FROM "AccountStatement" a
        WHERE a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.bancaId ? Prisma.sql`AND a."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
          ${filters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
          ${(!filters.ventanaId && !filters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
        GROUP BY ${groupByClause}
        ORDER BY date_bucket ASC
      `
    );
  }

  /**
   * Serie temporal en tiempo real desde Ticket
   */
  static async getRealTimeTimeSeries(
    selectClause: Prisma.Sql,
    groupByClause: Prisma.Sql,
    baseFilters: Prisma.Sql
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          ${selectClause} as date_bucket,
          COALESCE(SUM(t."totalAmount"), 0) as total_sales,
          COALESCE(SUM(t."totalCommission"), 0) as total_commissions,
          COUNT(DISTINCT t.id) as total_tickets,
          COALESCE(SUM(t."totalPayout"), 0) as total_payout,
          COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as total_winners
        FROM "Ticket" t
        WHERE ${baseFilters}
        GROUP BY ${groupByClause}
        ORDER BY date_bucket ASC
      `
    );
  }

  /**
   * Filas agregadas para el cálculo de exposición y riesgo
   */
  static async getExposureRows(
    baseFilters: Prisma.Sql,
    betType?: string,
    status?: string
  ): Promise<ExposureRow[]> {
    return prisma.$queryRaw<ExposureRow[]>(
      Prisma.sql`
        WITH open_tickets AS (
          SELECT
            t.id as ticket_id,
            t."sorteoId",
            t."loteriaId"
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON s.id = t."sorteoId"
          WHERE ${baseFilters}
            AND s.status = 'OPEN'
        ),
        jugadas_agg AS (
          SELECT
            ot."sorteoId",
            ot."loteriaId",
            j.number,
            j.type as bet_type,
            COUNT(DISTINCT j."ticketId") as ticket_count,
            COALESCE(SUM(j.amount), 0) as sales,
            COALESCE(SUM(j.amount * j."finalMultiplierX"), 0) as potential_payout
          FROM "Jugada" j
          JOIN open_tickets ot ON ot.ticket_id = j."ticketId"
          WHERE j."deletedAt" IS NULL
            AND j."isExcluded" = false
            ${betType ? Prisma.sql`AND j.type = ${betType}` : Prisma.empty}
          GROUP BY ot."sorteoId", ot."loteriaId", j.number, j.type
        )
        SELECT
          ja."sorteoId",
          s.name as sorteo_name,
          s."scheduledAt" as draw_time,
          s.status as sorteo_status,
          ja."loteriaId",
          l.name as loteria_name,
          ja.number,
          ja.bet_type,
          ja.ticket_count,
          ja.sales,
          ja.potential_payout
        FROM jugadas_agg ja
        JOIN "Sorteo" s ON s.id = ja."sorteoId"
        JOIN "Loteria" l ON l.id = ja."loteriaId"
        WHERE l."isActive" = true
          ${status ? Prisma.sql`AND s.status = ${status}` : Prisma.empty}
        ORDER BY ja.sales DESC
      `
    );
  }

  /**
   * Estadísticas de vendedores para ranking y paginación
   */
  static async getVendedoresStats(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string },
    orderClause: Prisma.Sql,
    orderDirection: Prisma.Sql,
    pageSize: number,
    offset: number
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        WITH open_sales AS (
          SELECT
            t."vendedorId" AS vendedor_id,
            COALESCE(SUM(t."totalAmount"), 0) AS total_sales,
            COALESCE(SUM(t."totalPayout"), 0) AS total_payout,
            COALESCE(SUM(t."totalCommission"), 0) AS commission_user,
            COALESCE(SUM(t."totalListeroCommission"), 0) AS commission_ventana,
            COUNT(t.id) AS total_tickets,
            COALESCE(SUM(CASE WHEN t."isWinner" = true THEN 1 ELSE 0 END), 0) AS winning_tickets
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND s.status = 'OPEN'
            ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY t."vendedorId"
        ),
        evaluated_sales AS (
          SELECT
            rcd."vendedorId" AS vendedor_id,
            COALESCE(SUM(rcd."totalVendida"), 0) AS total_sales,
            COALESCE(SUM(rcd."ganado"), 0) AS total_payout,
            COALESCE(SUM(rcd."comisionVendedor"), 0) AS commission_user,
            COALESCE(SUM(rcd."comisionTotal"), 0) AS commission_ventana,
            COALESCE(SUM(rcd."ticketsCount"), 0) AS total_tickets,
            0 AS winning_tickets
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY rcd."vendedorId"
        ),
        combined_sales AS (
          SELECT vendedor_id, total_sales, total_payout, commission_user, commission_ventana, total_tickets, winning_tickets FROM open_sales
          UNION ALL
          SELECT vendedor_id, total_sales, total_payout, commission_user, commission_ventana, total_tickets, winning_tickets FROM evaluated_sales
        ),
        vendedor_totals AS (
          SELECT
            vendedor_id,
            SUM(total_sales)::double precision AS total_sales,
            SUM(total_payout)::double precision AS total_payout,
            SUM(commission_user)::double precision AS commission_user,
            SUM(commission_ventana)::double precision AS commission_ventana,
            SUM(total_tickets)::bigint AS total_tickets,
            SUM(winning_tickets)::bigint AS winning_tickets
          FROM combined_sales
          WHERE vendedor_id IS NOT NULL
          GROUP BY vendedor_id
        )
        SELECT
          u.id as vendedor_id,
          u.name as vendedor_name,
          u.code as vendedor_code,
          u."ventanaId" as ventana_id,
          v.name as ventana_name,
          u."isActive" as is_active,
          COALESCE(vt.total_sales, 0) as total_sales,
          COALESCE(vt.total_payout, 0) as total_payout,
          COALESCE(vt.commission_user, 0) as commission_user,
          COALESCE(vt.commission_ventana, 0) as commission_ventana,
          COALESCE(vt.total_tickets, 0) as total_tickets,
          COALESCE(vt.winning_tickets, 0) as winning_tickets,
          CASE
            WHEN COALESCE(vt.total_tickets, 0) > 0 THEN COALESCE(vt.total_sales, 0) / COALESCE(vt.total_tickets, 0)
            ELSE 0
          END as avg_ticket
        FROM "User" u
        JOIN vendedor_totals vt ON vt.vendedor_id = u.id
        LEFT JOIN "Ventana" v ON v.id = u."ventanaId"
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
        ORDER BY ${orderClause} ${orderDirection}
        LIMIT ${pageSize}
        OFFSET ${offset}
      `
    );
  }

  /**
   * Conteo total de vendedores para paginación
   */
  static async getVendedoresCount(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string }
  ): Promise<number> {
    const totalCount = await prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`
        WITH open_vendedores AS (
          SELECT DISTINCT t."vendedorId" AS vendedor_id
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          WHERE t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND s.status = 'OPEN'
            ${filters.bancaId ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        evaluated_vendedores AS (
          SELECT DISTINCT rcd."vendedorId" AS vendedor_id
          FROM "ResumenCierreDiario" rcd
          WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        all_active_vendedores AS (
          SELECT vendedor_id FROM open_vendedores
          UNION
          SELECT vendedor_id FROM evaluated_vendedores
        )
        SELECT COUNT(DISTINCT u.id) as count
        FROM all_active_vendedores av
        JOIN "User" u ON u.id = av.vendedor_id
        WHERE u."isActive" = true
          AND u.role = 'VENDEDOR'
      `
    );
    return Number(totalCount[0]?.count) || 0;
  }

  /**
   * Totales desde AccountStatement para getSummary o calculatePreviousPeriod
   */
  static async getStatementSummaryRows(
    fromDateStr: string,
    toDateStr: string,
    filters: { bancaId?: string; ventanaId?: string; vendedorId?: string }
  ): Promise<any[]> {
    return prisma.$queryRaw<any[]>(
      Prisma.sql`
        SELECT
          COALESCE(SUM(a."totalSales"), 0) as total_sales,
          COALESCE(SUM(a."totalPayouts"), 0) as total_payouts,
          COALESCE(SUM(a."ticketCount"), 0) as total_tickets,
          COALESCE(SUM(a."vendedorCommission"), 0) as commission_user,
          COALESCE(SUM(a."listeroCommission"), 0) as commission_ventana
        FROM "AccountStatement" a
        WHERE a.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.bancaId ? Prisma.sql`AND a."bancaId" = ${filters.bancaId}::uuid` : Prisma.empty}
          ${filters.ventanaId ? Prisma.sql`AND a."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.vendedorId ? Prisma.sql`AND a."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
          ${(!filters.ventanaId && !filters.vendedorId) ? Prisma.sql`AND a."vendedorId" IS NULL` : Prisma.empty}
      `
    );
  }

  /**
   * Datos de resumen de dashboard y Month-To-Date por ventana
   */
  static async getDashboardSummaryData(
    fromDateStr: string,
    toDateStr: string,
    currentMonth: string,
    bancaFilter: Prisma.Sql,
    ventanaFilter: Prisma.Sql
  ): Promise<[DashboardSummaryByVentanaRow[], DashboardSummaryMtdRow[]]> {
    return Promise.all([
      prisma.$queryRaw<DashboardSummaryByVentanaRow[]>`
        SELECT
          v.id                                         AS ventana_id,
          v.name                                       AS ventana_name,
          v."isActive"                                 AS is_active,
          COALESCE(SUM(s."totalSales"), 0)             AS total_sales,
          COALESCE(SUM(s."totalPayouts"), 0)           AS total_payouts,
          COALESCE(SUM(s."listeroCommission"), 0)      AS listero_commission,
          COALESCE(SUM(s."vendedorCommission"), 0)     AS vendedor_commission,
          COALESCE(SUM(s."ticketCount"), 0)            AS ticket_count,
          COALESCE(MAX(lb.remaining_balance), 0)       AS remaining_balance,
          COALESCE(MAX(vlb.total_vendedores_balance), 0) AS vendedores_remaining_balance
        FROM "Ventana" v
        LEFT JOIN "AccountStatement" s
          ON  s."ventanaId" = v.id
          AND s."vendedorId" IS NULL
          AND s.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
        LEFT JOIN LATERAL (
          SELECT "remainingBalance" AS remaining_balance
          FROM   "AccountStatement"
          WHERE  "ventanaId"   = v.id
            AND  "vendedorId"  IS NULL
            AND  month         = ${currentMonth}
          ORDER BY date DESC
          LIMIT 1
        ) lb ON true
        LEFT JOIN LATERAL (
          SELECT SUM(lb_vend.remaining_balance) AS total_vendedores_balance
          FROM "User" u
          JOIN LATERAL (
            SELECT "remainingBalance" AS remaining_balance
            FROM "AccountStatement" ast
            WHERE ast."vendedorId" = u.id
              AND ast.month = ${currentMonth}
            ORDER BY date DESC
            LIMIT 1
          ) lb_vend ON true
          WHERE u."ventanaId" = v.id
            AND u.role = 'VENDEDOR'
            AND u."isActive" = true
            AND u."deletedAt" IS NULL
        ) vlb ON true
        WHERE v."deletedAt" IS NULL
          ${bancaFilter}
          ${ventanaFilter}
        GROUP BY v.id, v.name, v."isActive"
        ORDER BY total_sales DESC
      `,
      prisma.$queryRaw<DashboardSummaryMtdRow[]>`
        SELECT
          COALESCE(SUM(s."totalSales"), 0)         AS total_sales,
          COALESCE(SUM(s."totalPayouts"), 0)        AS total_payouts,
          COALESCE(SUM(s."listeroCommission"), 0)   AS listero_commission,
          COALESCE(SUM(s."vendedorCommission"), 0)  AS vendedor_commission
        FROM "AccountStatement" s
        JOIN "Ventana" v ON v.id = s."ventanaId"
        WHERE v."deletedAt"  IS NULL
          AND s."vendedorId" IS NULL
          AND s.month        = ${currentMonth}
          ${bancaFilter}
          ${ventanaFilter}
      `,
    ]);
  }

  /**
   * Datos de entidades por vendedor para dashboard
   */
  static async getDashboardEntitiesRows(
    fromDateStr: string,
    toDateStr: string,
    currentMonth: string,
    bancaFilter: Prisma.Sql,
    ventanaFilter: Prisma.Sql
  ): Promise<DashboardEntitiesRow[]> {
    return prisma.$queryRaw<DashboardEntitiesRow[]>`
      SELECT
        u.id                                          AS vendedor_id,
        u.name                                        AS vendedor_name,
        u.code                                        AS vendedor_code,
        u."isActive"                                  AS is_active,
        v.id                                          AS ventana_id,
        v.name                                        AS ventana_name,
        COALESCE(SUM(s."totalSales"), 0)              AS total_sales,
        COALESCE(SUM(s."totalPayouts"), 0)            AS total_payouts,
        COALESCE(SUM(s."listeroCommission"), 0)       AS listero_commission,
        COALESCE(SUM(s."vendedorCommission"), 0)      AS vendedor_commission,
        COALESCE(SUM(s."ticketCount"), 0)             AS ticket_count,
        COALESCE(MAX(lb.remaining_balance), 0)        AS remaining_balance
      FROM "User" u
      JOIN "Ventana" v ON v.id = u."ventanaId"
      LEFT JOIN "AccountStatement" s
        ON  s."vendedorId" = u.id
        AND s.date BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
      LEFT JOIN LATERAL (
        SELECT "remainingBalance" AS remaining_balance
        FROM   "AccountStatement"
        WHERE  "vendedorId" = u.id
          AND  month        = ${currentMonth}
        ORDER BY date DESC
        LIMIT 1
      ) lb ON true
      WHERE u."deletedAt"  IS NULL
        AND u.role         = 'VENDEDOR'
        AND v."deletedAt"  IS NULL
        ${bancaFilter}
        ${ventanaFilter}
      GROUP BY u.id, u.name, u.code, u."isActive", v.id, v.name
      ORDER BY total_sales DESC
    `;
  }
}
