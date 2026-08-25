// src/api/v1/services/commissions.service.ts
import { Prisma, Role } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import logger from "../../../core/logger";
import { resolveDateRange } from "../../../utils/dateRange";
import { crDateService } from "../../../utils/crDateService";
const { dateRangeUTCToCRStrings, postgresDateToCRString, isDateInCRRange } = crDateService;

const isUuid = (val: any): boolean => {
  return typeof val === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
};

/**
 * Filtros para queries de comisiones
 */
interface CommissionsFilters {
  dateFrom: Date;
  dateTo: Date;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  multiplierId?: string;
}

/**
 * Commissions Service
 * Proporciona endpoints para consultar comisiones devengadas.
 * ⚡ OPTIMIZACIÓN: 100% libre de JOINs a la tabla Jugada.
 * Utiliza AccountStatement, Ticket y ResumenCierreDiario segun la Matriz Unificada.
 */
export const CommissionsService = {
  /**
   * 1) Lista de comisiones por periodo
   * GET /commissions
   * SIEMPRE retorna comisiones desglosadas por día, y por dimensión (ventana/vendedor) si aplica
   */
  async list(
    date: string,
    fromDate: string | undefined,
    toDate: string | undefined,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string; // Para ADMIN multibanca (filtro de vista)
    },
    ventanaUserId?: string // ID del usuario VENTANA cuando dimension=ventana
  ): Promise<Array<{
    date: string;
    ventanaId?: string | null;
    ventanaName?: string | null;
    vendedorId?: string | null;
    vendedorName?: string | null;
    totalSales: number;
    totalTickets: number;
    totalCommission: number;
    totalPayouts: number;
    commissionListero?: number;
    commissionVendedor?: number;
    net?: number;
  }>> {
    try {
      // Resolver rango de fechas
      const dateRange = resolveDateRange(date, fromDate, toDate);
      const { startDateCRStr, endDateCRStr } = dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      const shouldGroupByDate =
        (filters.dimension === "ventana" && (!filters.ventanaId || !isUuid(filters.ventanaId))) ||
        (filters.dimension === "vendedor" && (!filters.vendedorId || !isUuid(filters.vendedorId)));

      logger.info({
        layer: "service",
        action: "COMMISSIONS_GROUPING_CHECK",
        payload: {
          dimension: filters.dimension,
          ventanaId: filters.ventanaId || null,
          vendedorId: filters.vendedorId || null,
          shouldGroupByDate,
        },
      });

      const conditions: Prisma.Sql[] = [
        Prisma.sql`date >= ${fromDateStr}::date`,
        Prisma.sql`date <= ${toDateStr}::date`,
      ];

      if (filters.bancaId && isUuid(filters.bancaId)) {
        conditions.push(Prisma.sql`"bancaId" = CAST(${filters.bancaId} AS uuid)`);
      }

      if (filters.dimension === "vendedor") {
        if (filters.vendedorId && isUuid(filters.vendedorId)) {
          conditions.push(Prisma.sql`"vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
        } else {
          conditions.push(Prisma.sql`"vendedorId" IS NOT NULL`);
        }
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          conditions.push(Prisma.sql`"vendedorId" IN (SELECT id FROM "User" WHERE "ventanaId" = CAST(${filters.ventanaId} AS uuid))`);
        }
      } else if (filters.dimension === "ventana") {
        conditions.push(Prisma.sql`"vendedorId" IS NULL`);
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          conditions.push(Prisma.sql`"ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        } else {
          conditions.push(Prisma.sql`"ventanaId" IS NOT NULL`);
        }
      } else {
        conditions.push(Prisma.sql`"vendedorId" IS NULL`);
        conditions.push(Prisma.sql`"ventanaId" IS NULL`);
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;

      const isVentana = filters.dimension === "ventana";
      const isVendedor = filters.dimension === "vendedor";

      const query = Prisma.sql`
        SELECT
          date,
          ${!shouldGroupByDate && isVentana ? Prisma.sql`"ventanaId" as entity_id, (SELECT name FROM "Ventana" WHERE id = "AccountStatement"."ventanaId") as entity_name,` : Prisma.empty}
          ${!shouldGroupByDate && isVendedor ? Prisma.sql`"vendedorId" as entity_id, (SELECT name FROM "User" WHERE id = "AccountStatement"."vendedorId") as entity_name, (SELECT "ventanaId" FROM "User" WHERE id = "AccountStatement"."vendedorId") as extra_id, (SELECT v.name FROM "User" u JOIN "Ventana" v ON v.id = u."ventanaId" WHERE u.id = "AccountStatement"."vendedorId") as extra_name,` : Prisma.empty}
          SUM("totalSales")::float as total_sales,
          SUM("ticketCount")::int as total_tickets,
          SUM("listeroCommission")::float as commission_listero,
          SUM("vendedorCommission")::float as commission_vendedor,
          SUM("totalPayouts")::float as total_payouts
        FROM "AccountStatement"
        ${whereClause}
        GROUP BY 1 ${!shouldGroupByDate ? Prisma.sql`, 2, 3` : Prisma.empty} ${isVendedor && !shouldGroupByDate ? Prisma.sql`, 4, 5` : Prisma.empty}
        ORDER BY date DESC ${!shouldGroupByDate ? Prisma.sql`, entity_name ASC` : Prisma.empty}
      `;

      const rawResult = await prisma.$queryRaw<any[]>(query);

      return rawResult.map(r => {
        const dateKey = postgresDateToCRString(r.date);
        
        const item: any = {
          date: dateKey,
          totalSales: r.total_sales,
          totalTickets: r.total_tickets,
          totalPayouts: r.total_payouts,
          commissionListero: r.commission_listero,
          commissionVendedor: r.commission_vendedor,
        };

        if (isVentana) {
          if (shouldGroupByDate) {
            item.totalCommission = r.commission_listero;
            item.net = r.total_sales - r.total_payouts - r.commission_listero;
          } else {
            item.ventanaId = r.entity_id;
            item.ventanaName = r.entity_name;
            item.totalCommission = r.commission_listero;
            item.net = r.total_sales - r.total_payouts - r.commission_listero;
          }
        } else if (isVendedor) {
          if (shouldGroupByDate) {
            item.totalCommission = r.commission_listero + r.commission_vendedor;
            item.net = r.total_sales - r.total_payouts - r.commission_listero;
          } else {
            item.vendedorId = r.entity_id;
            item.vendedorName = r.entity_name;
            item.ventanaId = r.extra_id;
            item.ventanaName = r.extra_name;
            item.totalCommission = r.commission_listero + r.commission_vendedor;
            item.net = r.total_sales - r.total_payouts - r.commission_listero;
          }
        } else {
          item.totalCommission = r.commission_listero;
        }

        return item;
      });
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "COMMISSIONS_LIST_FAIL",
        payload: { message: err.message, date, filters },
      });
      throw err;
    }
  },

  /**
   * 2) Detalle de comisiones por lotería y multiplicador
   * GET /commissions/detail
   * Retorna desglose por lotería y multiplicador usando ResumenCierreDiario (EVALUATED) y Ticket (OPEN).
   * ⚡ 0 JOINs a Jugada.
   */
  async detail(
    date: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    },
    ventanaUserId?: string
  ): Promise<
    Array<{
      loteriaId: string;
      loteriaName: string;
      totalSales: number;
      totalTickets: number;
      totalCommission: number;
      multipliers: Array<{
        multiplierId: string;
        multiplierName: string;
        multiplierPercentage: number;
        totalSales: number;
        totalTickets: number;
        totalCommission: number;
      }>;
    }>
  > {
    try {
      const dateRange = resolveDateRange("range", date, date);
      const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      const isVentana = filters.dimension === "ventana";

      // ⚡ REFACTORIZACIÓN MATRIZ UNIFICADA:
      // Sorteos ABIERTOS -> Consultar Ticket
      // Sorteos EVALUADOS -> Consultar ResumenCierreDiario (desglose por tipo y banda)
      // ZERO JOINs a Jugada.
      const query = Prisma.sql`
        WITH open_sales AS (
          SELECT
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            'Base' as multiplier_name,
            COALESCE(SUM(t."totalAmount"), 0)::float as total_sales,
            COUNT(t.id)::int as total_tickets,
            COALESCE(SUM(${isVentana ? Prisma.sql`t."totalListeroCommission"` : Prisma.sql`t."totalCommission"`}), 0)::float as total_commission
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          WHERE t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
            AND s.status = 'OPEN'
            AND t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId && isUuid(filters.bancaId) ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId && isUuid(filters.ventanaId) ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId && isUuid(filters.vendedorId) ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY t."loteriaId", l.name
        ),
        evaluated_sales AS (
          SELECT
            rcd."loteriaId" as loteria_id,
            l.name as loteria_name,
            CASE 
              WHEN rcd.tipo = 'REVENTADO' THEN 'REVENTADO'
              ELSE 'Base ' || rcd.banda || 'x'
            END as multiplier_name,
            COALESCE(SUM(rcd."totalVendida"), 0)::float as total_sales,
            COALESCE(SUM(rcd."ticketsCount"), 0)::int as total_tickets,
            COALESCE(SUM(${isVentana ? Prisma.sql`rcd."comisionTotal"` : Prisma.sql`rcd."comisionVendedor"`}), 0)::float as total_commission
          FROM "ResumenCierreDiario" rcd
          INNER JOIN "Loteria" l ON l.id = rcd."loteriaId"
          WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
            ${filters.bancaId && isUuid(filters.bancaId) ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId && isUuid(filters.ventanaId) ? Prisma.sql`AND rcd."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId && isUuid(filters.vendedorId) ? Prisma.sql`AND rcd."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          GROUP BY rcd."loteriaId", l.name, rcd.tipo, rcd.banda
        ),
        combined_rows AS (
          SELECT loteria_id, loteria_name, multiplier_name, total_sales, total_tickets, total_commission FROM open_sales
          UNION ALL
          SELECT loteria_id, loteria_name, multiplier_name, total_sales, total_tickets, total_commission FROM evaluated_sales
        ),
        loteria_summary AS (
          SELECT
            loteria_id,
            loteria_name,
            SUM(total_sales)::float as total_sales,
            SUM(total_tickets)::int as total_tickets,
            SUM(total_commission)::float as total_commission
          FROM combined_rows
          GROUP BY 1, 2
        ),
        multiplier_breakdown AS (
          SELECT
            loteria_id,
            multiplier_name,
            NULL as multiplier_id,
            SUM(total_sales)::float as total_sales,
            SUM(total_tickets)::int as total_tickets,
            SUM(total_commission)::float as total_commission,
            CASE 
              WHEN SUM(total_sales) > 0 THEN (SUM(total_commission) / SUM(total_sales) * 100)::float
              ELSE 0
            END as multiplier_percentage
          FROM combined_rows
          GROUP BY 1, 2
        )
        SELECT 
          s.*,
          COALESCE((
            SELECT jsonb_agg(m.*)
            FROM multiplier_breakdown m
            WHERE m.loteria_id = s.loteria_id
          ), '[]'::jsonb) as breakdown
        FROM loteria_summary s
        ORDER BY loteria_name ASC
      `;

      const resultRaw = await prisma.$queryRaw<any[]>(query);

      logger.info({
        layer: "service",
        action: "COMMISSIONS_DETAIL",
        payload: {
          date,
          filters,
          resultCount: resultRaw.length,
          calculationMethod: "unified_surface_no_jugada",
        },
      });

      return resultRaw.map(row => ({
        loteriaId: row.loteria_id,
        loteriaName: row.loteria_name,
        totalSales: row.total_sales,
        totalTickets: row.total_tickets,
        totalCommission: row.total_commission,
        multipliers: (row.breakdown || []).map((m: any) => ({
          multiplierId: m.multiplier_id || "unknown",
          multiplierName: m.multiplier_name,
          multiplierPercentage: Number((m.multiplier_percentage || 0).toFixed(2)),
          totalSales: m.total_sales,
          totalTickets: m.total_tickets,
          totalCommission: m.total_commission,
        })).sort((a: any, b: any) => b.multiplierPercentage - a.multiplierPercentage)
      }));
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "COMMISSIONS_DETAIL_FAIL",
        payload: { message: err.message, date, filters },
      });
      throw err;
    }
  },

  /**
   * 3) Tickets con comisiones
   * GET /commissions/tickets
   * Retorna lista paginada de tickets con comisiones.
   * ⚡ OPTIMIZACIÓN: Consulta directa a Ticket (0 JOINs a Jugada).
   */
  async tickets(
    date: string,
    loteriaId: string,
    multiplierId: string,
    page: number,
    pageSize: number,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    },
    ventanaUserId?: string
  ): Promise<PaginatedResult<{
    ticketId: string;
    ticketNumber: string;
    totalAmount: number;
    commissionAmount: number;
    commissionPercentage: number;
    createdAt: string;
    vendedorName?: string;
    ventanaName?: string;
  }>> {
    try {
      const { skip, take } = getSkipTake(page, pageSize);

      const dateRange = resolveDateRange("range", date, date);
      const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" != 'CANCELLED'`,
        Prisma.sql`t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date`,
      ];

      if (loteriaId && isUuid(loteriaId)) {
        whereConditions.push(Prisma.sql`t."loteriaId" = CAST(${loteriaId} AS uuid)`);
      }

      if (filters.bancaId && isUuid(filters.bancaId)) {
        whereConditions.push(Prisma.sql`t."bancaId" = CAST(${filters.bancaId} AS uuid)`);
      }

      if (filters.dimension === "vendedor") {
        if (filters.vendedorId && isUuid(filters.vendedorId)) {
          whereConditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
        }
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;
      const isVentana = filters.dimension === "ventana";

      const [data, totalResult] = await Promise.all([
        prisma.$queryRaw<
          Array<{
            ticket_id: string;
            ticket_number: string;
            total_amount: number;
            commission_amount: number;
            listero_commission_amount: number;
            created_at: Date;
            vendedor_name: string | null;
            ventana_name: string | null;
          }>
        >`
          SELECT
            t.id as ticket_id,
            t."ticketNumber" as ticket_number,
            t."totalAmount" as total_amount,
            t."totalCommission" as commission_amount,
            t."totalListeroCommission" as listero_commission_amount,
            t."createdAt" as created_at,
            u.name as vendedor_name,
            v.name as ventana_name
          FROM "Ticket" t
          LEFT JOIN "User" u ON u.id = t."vendedorId"
          LEFT JOIN "Ventana" v ON v.id = t."ventanaId"
          ${whereClause}
          ORDER BY t."createdAt" DESC
          LIMIT ${take} OFFSET ${skip}
        `,
        prisma.$queryRaw<
          Array<{ count: string }>
        >`
          SELECT COUNT(t.id)::text as count
          FROM "Ticket" t
          ${whereClause}
        `,
      ]);

      const total = parseInt(totalResult[0]?.count || "0", 10);
      const meta = buildMeta(total, page, pageSize);

      logger.info({
        layer: "service",
        action: "COMMISSIONS_TICKETS",
        payload: {
          date,
          loteriaId,
          multiplierId,
          filters,
          page,
          pageSize,
          total,
        },
      });

      if (isVentana) {
        return {
          data: data.map((row) => {
            const commissionPercent = row.total_amount > 0
              ? (row.listero_commission_amount / row.total_amount) * 100
              : 0;

            return {
              ticketId: row.ticket_id,
              ticketNumber: row.ticket_number,
              totalAmount: row.total_amount,
              commissionAmount: row.listero_commission_amount,
              commissionPercentage: Number(commissionPercent.toFixed(2)),
              createdAt: row.created_at.toISOString(),
              vendedorName: row.vendedor_name || undefined,
              ventanaName: row.ventana_name || undefined,
            };
          }),
          meta,
        };
      }

      return {
        data: data.map((row) => {
          const commissionPercent = row.total_amount > 0
            ? (row.commission_amount / row.total_amount) * 100
            : 0;

          return {
            ticketId: row.ticket_id,
            ticketNumber: row.ticket_number,
            totalAmount: row.total_amount,
            commissionAmount: row.commission_amount,
            commissionPercentage: Number(commissionPercent.toFixed(2)),
            createdAt: row.created_at.toISOString(),
            vendedorName: row.vendedor_name || undefined,
            ventanaName: row.ventana_name || undefined,
          };
        }),
        meta,
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "COMMISSIONS_TICKETS_FAIL",
        payload: { message: err.message, date, loteriaId, multiplierId, filters },
      });
      throw err;
    }
  },
  
  /**
   * 4) Desglose anidado por Lotería/Multiplicador para una fecha específica (Lazy Loading)
   * GET /api/v1/commissions/:date/breakdown
   * ⚡ OPTIMIZACIÓN: 0 JOINs a Jugada. Consulta ResumenCierreDiario y Ticket.
   */
  async getBreakdown(
    date: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string;
    }
  ): Promise<any> {
    try {
      const isVentana = filters.dimension === "ventana";

      const query = Prisma.sql`
        WITH open_sales AS (
          SELECT
            t.id as ticket_id,
            t."totalPayout" as ticket_payout,
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            'Número' as multiplier_name,
            t."totalAmount" as amount,
            ${isVentana ? Prisma.sql`t."totalListeroCommission"` : Prisma.sql`t."totalCommission"`} as commission_amount
          FROM "Ticket" t
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          WHERE t."businessDate" = ${date}::date
            AND t."deletedAt" IS NULL
            AND t."isActive" = true
            AND t."status" != 'CANCELLED'
            AND s.status = 'OPEN'
            ${filters.ventanaId && isUuid(filters.ventanaId) ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.vendedorId && isUuid(filters.vendedorId) ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
            ${filters.bancaId && isUuid(filters.bancaId) ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        ),
        evaluated_sales AS (
          SELECT
            rcd.id as ticket_id,
            rcd."ganado" as ticket_payout,
            rcd."loteriaId" as loteria_id,
            l.name as loteria_name,
            CASE 
              WHEN rcd.tipo = 'REVENTADO' THEN 'REVENTADO'
              ELSE 'Número'
            END as multiplier_name,
            rcd."totalVendida" as amount,
            ${isVentana ? Prisma.sql`rcd."comisionTotal"` : Prisma.sql`rcd."comisionVendedor"`} as commission_amount
          FROM "ResumenCierreDiario" rcd
          INNER JOIN "Loteria" l ON l.id = rcd."loteriaId"
          WHERE rcd."businessDate" = ${date}::date
            ${filters.ventanaId && isUuid(filters.ventanaId) ? Prisma.sql`AND rcd."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
            ${filters.vendedorId && isUuid(filters.vendedorId) ? Prisma.sql`AND rcd."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
            ${filters.bancaId && isUuid(filters.bancaId) ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        ),
        combined_base AS (
          SELECT loteria_id, loteria_name, multiplier_name, amount, commission_amount, ticket_payout FROM open_sales
          UNION ALL
          SELECT loteria_id, loteria_name, multiplier_name, amount, commission_amount, ticket_payout FROM evaluated_sales
        ),
        multiplier_summary AS (
          SELECT
            loteria_id,
            multiplier_name,
            NULL::uuid as multiplier_id, 
            SUM(amount)::float as total_sales,
            COUNT(*)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission,
            SUM(COALESCE(ticket_payout, 0))::float as total_payouts
          FROM combined_base
          GROUP BY 1, 2
        ),
        loteria_summary AS (
          SELECT
            loteria_id,
            loteria_name,
            SUM(amount)::float as total_sales,
            COUNT(*)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission
          FROM combined_base
          GROUP BY 1, 2
        )
        SELECT 
          s.loteria_id as "loteriaId",
          s.loteria_name as "loteriaName",
          s.total_sales as "totalSales",
          s.total_tickets as "totalTickets",
          s.total_commission as "totalCommission",
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'multiplierId', m.multiplier_id,
              'multiplierName', m.multiplier_name,
              'totalSales', m.total_sales,
              'totalTickets', m.total_tickets,
              'totalCommission', m.total_commission,
              'totalPayouts', m.total_payouts,
              'net', m.total_sales - m.total_payouts - m.total_commission
            ))
            FROM multiplier_summary m
            WHERE m.loteria_id = s.loteria_id
          ), '[]'::jsonb) as multipliers
        FROM loteria_summary s
        ORDER BY s.loteria_name ASC
      `;

      const result = await prisma.$queryRaw<any[]>(query);

      logger.info({
        layer: "service",
        action: "COMMISSIONS_BREAKDOWN_SUCCESS",
        payload: { date, resultCount: result.length }
      });

      return result;
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "COMMISSIONS_BREAKDOWN_FAIL",
        payload: { message: err.message, date, filters },
      });
      throw err;
    }
  },
};

export default CommissionsService;
