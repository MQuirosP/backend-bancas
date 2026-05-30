// src/api/v1/services/commissions.service.ts
import { Prisma, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import logger from "../../../core/logger";
import { resolveDateRange } from "../../../utils/dateRange";
import { commissionSnapshotService, CommissionSnapshotFilters } from "../../../services/commission/CommissionSnapshotService";
import { commissionAggregationService } from "../../../services/commission/CommissionAggregationService";
import { crDateService } from "../../../utils/crDateService";
const { dateRangeUTCToCRStrings, postgresDateToCRString, isDateInCRRange } = crDateService;
import { isExclusionListEmpty } from "../../../core/exclusionListCache";

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
 * Convierte business_date desde resultados SQL a fecha CR (YYYY-MM-DD)
 * 
 * ️ CRÍTICO: Cuando PostgreSQL devuelve DATE(... AT TIME ZONE 'America/Costa_Rica'),
 * devuelve un DATE (sin hora) que representa el día calendario en CR.
 * 
 * Cuando Prisma recibe un DATE de PostgreSQL, lo convierte a un Date JavaScript
 * con hora 00:00:00.000Z. Este Date ya representa correctamente el día calendario,
 * NO necesita ajuste de zona horaria porque DATE no tiene componente de hora.
 * 
 * Ejemplo:
 * - PostgreSQL: DATE('2025-12-06 00:00:00' AT TIME ZONE 'America/Costa_Rica') = '2025-12-06' (DATE)
 * - Prisma lo convierte a: Date('2025-12-06T00:00:00.000Z')
 * - Este Date ya representa el día 2025-12-06 correctamente, solo extraer YYYY-MM-DD
 * 
 * Solución: Extraer directamente año, mes, día sin ajustar zona horaria
 */
// ️ DEPRECATED: Usar crDateService.postgresDateToCRString() en su lugar

/**
 * Commissions Service
 * Proporciona endpoints para consultar comisiones devengadas
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
      //  CORRECCIÓN CRÍTICA: Usar servicio centralizado para conversión de fechas
      const { startDateCRStr, endDateCRStr } = dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      //  NUEVO: Detectar si debemos agrupar por fecha solamente (sin separar por entidad)
      // Agrupamos cuando dimension=ventana y ventanaId NO está especificado
      // o cuando dimension=vendedor y vendedorId NO está especificado
      //  CRÍTICO: Verificar tanto undefined como null y cadena vacía
      const shouldGroupByDate =
        (filters.dimension === "ventana" && (!filters.ventanaId || !isUuid(filters.ventanaId))) ||
        (filters.dimension === "vendedor" && (!filters.vendedorId || !isUuid(filters.vendedorId)));

      //  DEBUG: Log para verificar agrupación
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

      // Construir filtros WHERE dinámicos según RBAC
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        //  CAMBIO: Filtrar EXCLUSIVAMENTE sorteos EVALUATED para comisiones
        Prisma.sql`t."status" != 'CANCELLED'`,
        Prisma.sql`EXISTS (
          SELECT 1 FROM "Sorteo" s
          WHERE s.id = t."sorteoId" 
          AND s.status = 'EVALUATED'
        )`,
        Prisma.sql`t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date`,
      ];

      // Excluir tickets de listas bloqueadas (solo si hay exclusiones activas)
      if (!await isExclusionListEmpty()) {
        whereConditions.push(Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle
          WHERE sle.sorteo_id = t."sorteoId"
          AND sle.ventana_id = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
          AND sle.multiplier_id IS NULL
        )`);
      }

      // Filtrar por banca activa (para ADMIN multibanca)
      if (filters.bancaId && isUuid(filters.bancaId)) {
        whereConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Ventana" v
          WHERE v.id = t."ventanaId"
          AND v."bancaId" = CAST(${filters.bancaId} AS uuid)
        )`);
      }

      // Aplicar filtros de RBAC según scope
      if (filters.dimension === "vendedor") {
        if (filters.vendedorId && isUuid(filters.vendedorId)) {
          // Filtrar por vendedor específico (ADMIN con filtro)
          whereConditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
        }
        // Si scope=mine, el RBAC ya aplicó el filtro de vendedorId
        // También aplicar ventanaId si está presente (para filtrar vendedores de una ventana específica)
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          // Filtrar por ventana específica (ADMIN con filtro)
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
        // Si scope=mine, el RBAC ya aplicó el filtro de ventanaId
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

      // Filtro de exclusión por jugada (solo si hay exclusiones activas)
      const exclusionJugadaFilter = await isExclusionListEmpty()
        ? Prisma.empty
        : Prisma.sql`AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )`;

      // Si dimension=ventana, obtener la política de comisiones del usuario VENTANA
      let ventanaUserPolicy: any = null;
      if (filters.dimension === "ventana" && ventanaUserId) {
        const ventanaUser = await prisma.user.findUnique({
          where: { id: ventanaUserId },
          select: { commissionPolicyJson: true },
        });
        ventanaUserPolicy = ventanaUser?.commissionPolicyJson ?? null;
      }

      // SIEMPRE desglosar por día, y por dimensión si aplica
      // ============================================================================
      // REFACTORIZACION 'TANK' MODE: Agregacion 100% en SQL (PostgreSQL)
      // Eliminamos el procesamiento en memoria de miles de jugadas en Node.js
      // ============================================================================
      
      const isVentana = filters.dimension === "ventana";
      const isVendedor = filters.dimension === "vendedor";

      const query = Prisma.sql`
        WITH base_jugadas AS (
          SELECT
            t."businessDate" as date,
            t.id as ticket_id,
            t."totalPayout" as ticket_payout,
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            CASE 
              WHEN lm.kind = 'REVENTADO' THEN NULL
              ELSE j."multiplierId"
            END as multiplier_id,
            CASE 
              WHEN lm.kind = 'REVENTADO' THEN 'REVENTADO'
              WHEN j."multiplierId" IS NULL THEN l.name
              WHEN lm.name = 'Base' AND lm.kind = 'NUMERO' AND lm."valueX" IS NOT NULL THEN 'Base ' || lm."valueX" || 'x'
              ELSE COALESCE(lm.name, l.name)
            END as multiplier_name,
            ${isVentana ? Prisma.sql`t."ventanaId"` : isVendedor ? Prisma.sql`t."vendedorId"` : Prisma.sql`NULL`} as entity_id,
            ${isVentana ? Prisma.sql`v.name` : isVendedor ? Prisma.sql`u.name` : Prisma.sql`NULL`} as entity_name,
            ${isVendedor ? Prisma.sql`v.id` : Prisma.sql`NULL`} as extra_id,
            ${isVendedor ? Prisma.sql`v.name` : Prisma.sql`NULL`} as extra_name,
            j.amount,
            j."listeroCommissionAmount" as commission_listero,
            j."commissionAmount" as commission_vendedor,
            -- Rango para contar payouts de tickets una sola vez por entidad/dia
            ROW_NUMBER() OVER(
              PARTITION BY t.id, t."businessDate"
              ${isVentana ? Prisma.sql`, t."ventanaId"` : isVendedor ? Prisma.sql`, t."vendedorId"` : Prisma.empty}
            ) as ticket_rnk,
            -- Rango para contar payouts por producto una sola vez por ticket/lote/dia
            ROW_NUMBER() OVER(
              PARTITION BY t.id, t."businessDate", t."loteriaId", j."multiplierId"
            ) as product_ticket_rnk
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
          ${isVentana ? Prisma.sql`INNER JOIN "Ventana" v ON v.id = t."ventanaId"` : Prisma.empty}
          ${isVendedor ? Prisma.sql`
            INNER JOIN "User" u ON u.id = t."vendedorId"
            INNER JOIN "Ventana" v ON v.id = t."ventanaId"
          ` : Prisma.empty}
          ${whereClause}
          AND j."isExcluded" IS FALSE
          AND j."deletedAt" IS NULL
          ${exclusionJugadaFilter}
        ),
        daily_summary AS (
          SELECT
            date,
            ${!shouldGroupByDate ? Prisma.sql`entity_id, entity_name,` : Prisma.empty}
            ${isVendedor && !shouldGroupByDate ? Prisma.sql`extra_id, extra_name,` : Prisma.empty}
            SUM(amount)::float as total_sales,
            COUNT(DISTINCT ticket_id)::int as total_tickets,
            SUM(COALESCE(commission_listero, 0))::float as commission_listero,
            SUM(COALESCE(commission_vendedor, 0))::float as commission_vendedor,
            SUM(CASE WHEN ticket_rnk = 1 THEN ticket_payout ELSE 0 END)::float as total_payouts
          FROM base_jugadas
          GROUP BY 1 ${!shouldGroupByDate ? Prisma.sql`, 2, 3` : Prisma.empty} ${isVendedor && !shouldGroupByDate ? Prisma.sql`, 4, 5` : Prisma.empty}
        )
        SELECT * FROM daily_summary s
        ORDER BY date DESC ${!shouldGroupByDate ? Prisma.sql`, entity_name ASC` : Prisma.empty}
      `;

      const rawResult = await prisma.$queryRaw<any[]>(query);

      logger.info({
        layer: "service",
        action: "COMMISSIONS_LIST_TANK_MODE",
        payload: {
          dimension: filters.dimension,
          shouldGroupByDate,
          rawResultCount: rawResult.length,
        },
      });

      // Mapear resultados al formato de respuesta esperado
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
          // ADMIN sin agrupación o vista global
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
   * 2) Detalle de comisiones por lotería
   * GET /commissions/detail
   * Retorna desglose por lotería y multiplicador para una fecha específica
   */
  async detail(
    date: string,
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      bancaId?: string; // Para ADMIN multibanca (filtro de vista)
    },
    ventanaUserId?: string // ID del usuario VENTANA cuando dimension=ventana
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
      // Convertir fecha YYYY-MM-DD a rango UTC (CR timezone)
      const dateRange = resolveDateRange("range", date, date);
      const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      // Construir filtros WHERE dinámicos según RBAC
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" != 'CANCELLED'`,
        Prisma.sql`EXISTS (
          SELECT 1 FROM "Sorteo" s
          WHERE s.id = t."sorteoId"
          AND s.status = 'EVALUATED'
        )`,
        Prisma.sql`t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date`,
      ];

      // Excluir tickets de listas bloqueadas (solo si hay exclusiones activas)
      if (!await isExclusionListEmpty()) {
        whereConditions.push(Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle
          WHERE sle.sorteo_id = t."sorteoId"
          AND sle.ventana_id = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
          AND sle.multiplier_id IS NULL
        )`);
      }

      // Filtrar por banca activa (para ADMIN multibanca)
      if (filters.bancaId && isUuid(filters.bancaId)) {
        whereConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Ventana" v
          WHERE v.id = t."ventanaId"
          AND v."bancaId" = CAST(${filters.bancaId} AS uuid)
        )`);
      }

      // Aplicar filtros de RBAC según dimension
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

      // Filtro de exclusión por jugada (solo si hay exclusiones activas)
      const exclusionJugadaFilter = await isExclusionListEmpty()
        ? Prisma.empty
        : Prisma.sql`AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )`;

      // ============================================================================
      // REFACTORIZACION 'TANK' MODE: Agregacion 100% en SQL (PostgreSQL)
      // Eliminamos el procesamiento en memoria de miles de jugadas en Node.js
      // ============================================================================

      const isVentana = filters.dimension === "ventana";

      const query = Prisma.sql`
        WITH base_jugadas AS (
          SELECT
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            lm.id as multiplier_id,
            COALESCE(lm.name, 'Base') as multiplier_name,
            lm."valueX" as multiplier_value_x,
            lm.kind as multiplier_kind,
            j.amount,
            t.id as ticket_id,
            ${isVentana ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} as commission_amount
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
          ${whereClause}
          AND j."isExcluded" IS FALSE
          AND j."deletedAt" IS NULL
          ${exclusionJugadaFilter}
        ),
        loteria_summary AS (
          SELECT
            loteria_id,
            loteria_name,
            SUM(amount)::float as total_sales,
            COUNT(DISTINCT ticket_id)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission
          FROM base_jugadas
          GROUP BY 1, 2
        ),
        multiplier_breakdown AS (
          SELECT
            loteria_id,
            multiplier_id,
            CASE 
              WHEN multiplier_id IS NULL THEN 'REVENTADO'
              WHEN multiplier_name = 'Base' AND multiplier_kind = 'NUMERO' AND multiplier_value_x IS NOT NULL THEN 'Base ' || multiplier_value_x || 'x'
              ELSE multiplier_name
            END as multiplier_name,
            SUM(amount)::float as total_sales,
            COUNT(DISTINCT ticket_id)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission,
            CASE 
              WHEN SUM(amount) > 0 THEN (SUM(COALESCE(commission_amount, 0)) / SUM(amount) * 100)::float
              ELSE 0
            END as multiplier_percentage
          FROM base_jugadas
          GROUP BY 1, 2, 3, multiplier_name, multiplier_kind, multiplier_value_x
        )
        SELECT 
          s.*,
          (
            SELECT jsonb_agg(m.*)
            FROM multiplier_breakdown m
            WHERE m.loteria_id = s.loteria_id
          ) as breakdown
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
          calculationMethod: "sql_aggregation",
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
          multiplierPercentage: Number(m.multiplier_percentage.toFixed(2)),
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
   * Retorna lista paginada de tickets con comisiones para un multiplicador específico
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
      bancaId?: string; // Para ADMIN multibanca (filtro de vista)
    },
    ventanaUserId?: string // ID del usuario VENTANA cuando dimension=ventana
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

      // Convertir fecha YYYY-MM-DD a rango UTC (CR timezone)
      const dateRange = resolveDateRange("range", date, date);
      //  CORRECCIÓN: Usar servicio centralizado para conversión de fechas
      const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(dateRange.fromAt, dateRange.toAt);
      const fromDateStr = startDateCRStr;
      const toDateStr = endDateCRStr;

      // Si dimension=ventana, obtener la política de comisiones del usuario VENTANA
      let ventanaUserPolicy: any = null;
      if (filters.dimension === "ventana" && ventanaUserId) {
        const ventanaUser = await prisma.user.findUnique({
          where: { id: ventanaUserId },
          select: { commissionPolicyJson: true },
        });
        ventanaUserPolicy = ventanaUser?.commissionPolicyJson ?? null;
      }

      // Construir filtros WHERE dinámicos según RBAC
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" != 'CANCELLED'`,
        Prisma.sql`EXISTS (
          SELECT 1 FROM "Sorteo" s
          WHERE s.id = t."sorteoId"
          AND s.status = 'EVALUATED'
        )`,
        Prisma.sql`t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date`,
      ];

      if (loteriaId && isUuid(loteriaId)) {
        whereConditions.push(Prisma.sql`t."loteriaId" = CAST(${loteriaId} AS uuid)`);
      }

      // Manejar multiplierId: "unknown" significa NULL (REVENTADO sin multiplicador)
      if (multiplierId === "unknown") {
        whereConditions.push(Prisma.sql`j."multiplierId" IS NULL`);
      } else if (multiplierId && isUuid(multiplierId)) {
        whereConditions.push(Prisma.sql`j."multiplierId" = CAST(${multiplierId} AS uuid)`);
      }

      // Filtrar por banca activa (para ADMIN multibanca)
      if (filters.bancaId && isUuid(filters.bancaId)) {
        whereConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Ventana" v
          WHERE v.id = t."ventanaId"
          AND v."bancaId" = CAST(${filters.bancaId} AS uuid)
        )`);
      }

      // Aplicar filtros de RBAC según dimension
      if (filters.dimension === "vendedor") {
        if (filters.vendedorId && isUuid(filters.vendedorId)) {
          whereConditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
        }
        // También aplicar ventanaId si está presente (para filtrar vendedores de una ventana específica)
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId && isUuid(filters.ventanaId)) {
          whereConditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
        }
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

      // Query para obtener tickets con paginación
      // Solo tickets que tengan al menos una jugada con el multiplicador especificado
      // Incluimos listeroCommissionAmount para usar snapshots en lugar de recalcular
      const [data, totalResult] = await Promise.all([
        prisma.$queryRaw<
          Array<{
            ticket_id: string;
            ticket_number: string;
            total_amount: number;
            commission_amount: number;
            listero_commission_amount: number;
            commission_percent: number;
            created_at: Date;
            vendedor_name: string | null;
            ventana_name: string | null;
          }>
        >`
          SELECT
            t.id as ticket_id,
            t."ticketNumber" as ticket_number,
            t."totalAmount" as total_amount,
            COALESCE(SUM(j."commissionAmount"), 0) as commission_amount,
            COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission_amount,
            AVG(j."commissionPercent") as commission_percent,
            t."createdAt" as created_at,
            u.name as vendedor_name,
            v.name as ventana_name
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          LEFT JOIN "User" u ON u.id = t."vendedorId"
          LEFT JOIN "Ventana" v ON v.id = t."ventanaId"
          ${whereClause}
          AND j."isExcluded" IS FALSE
          GROUP BY t.id, t."ticketNumber", t."totalAmount", t."createdAt", u.name, v.name
          ORDER BY t."createdAt" DESC
          LIMIT ${take} OFFSET ${skip}
        `,
        prisma.$queryRaw<
          Array<{ count: string }>
        >`
          SELECT COUNT(DISTINCT t.id)::text as count
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          ${whereClause}
          AND j."isExcluded" IS FALSE
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

      // Si dimension=ventana: usar snapshots de comisión del listero (listeroCommissionAmount)
      if (filters.dimension === "ventana") {
        // Las comisiones ya están guardadas como snapshots en la BD
        // Simplemente usamos el listero_commission_amount agregado desde la query
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

      // Para VENDEDOR: usar los valores almacenados (del vendedor)
      // commission_percent ya está en formato 0-100, redondear a entero
      return {
        data: data.map((row) => ({
          ticketId: row.ticket_id,
          ticketNumber: row.ticket_number,
          totalAmount: row.total_amount,
          commissionAmount: row.commission_amount,
          commissionPercentage: Number((row.commission_percent || 0).toFixed(2)),
          createdAt: row.created_at.toISOString(),
          vendedorName: row.vendedor_name || undefined,
          ventanaName: row.ventana_name || undefined,
        })),
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

      // 1. Filtro de exclusión por jugada
      const exclusionJugadaFilter = await isExclusionListEmpty()
        ? Prisma.empty
        : Prisma.sql`AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            WHERE sle.sorteo_id = t."sorteoId"
            AND sle.ventana_id = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND (sle.multiplier_id IS NULL OR sle.multiplier_id = j."multiplierId")
          )`;

      // 2. Query 100% agregada en PostgreSQL (Tank Mode)
      const query = Prisma.sql`
        WITH base_jugadas AS (
          SELECT
            t.id as ticket_id,
            t."totalPayout" as ticket_payout,
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            j."multiplierId" as multiplier_id,
            CASE 
              WHEN j.type = 'REVENTADO' OR lm.kind = 'REVENTADO' THEN 'REVENTADO'
              WHEN j."multiplierId" IS NULL THEN 'Número'
              ELSE lm.name
            END as multiplier_name,
            j.amount,
            ${isVentana ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} as commission_amount,
            ROW_NUMBER() OVER(
              PARTITION BY t.id, t."businessDate", t."loteriaId", 
                           CASE 
                             WHEN j.type = 'REVENTADO' OR lm.kind = 'REVENTADO' THEN 'REVENTADO'
                             WHEN j."multiplierId" IS NULL THEN 'Número'
                             ELSE lm.name
                           END
            ) as product_ticket_rnk
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
          WHERE t."businessDate" = ${date}::date
          AND t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t."status" != 'CANCELLED'
          AND j."isExcluded" IS FALSE
          AND j."deletedAt" IS NULL
          ${filters.ventanaId && isUuid(filters.ventanaId) ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
          ${filters.vendedorId && isUuid(filters.vendedorId) ? Prisma.sql`AND t."vendedorId" = ${filters.vendedorId}::uuid` : Prisma.empty}
          ${filters.bancaId && isUuid(filters.bancaId) ? Prisma.sql`AND EXISTS (
            SELECT 1 FROM "Ventana" v
            WHERE v.id = t."ventanaId"
            AND v."bancaId" = CAST(${filters.bancaId} AS uuid)
          )` : Prisma.empty}
          ${exclusionJugadaFilter}
        ),
        multiplier_summary AS (
          SELECT
            loteria_id,
            multiplier_name,
            MAX(multiplier_id::text)::uuid as multiplier_id, 
            SUM(amount)::float as total_sales,
            COUNT(DISTINCT ticket_id)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission,
            SUM(CASE WHEN product_ticket_rnk = 1 THEN ticket_payout ELSE 0 END)::float as total_payouts
          FROM base_jugadas
          GROUP BY 1, 2
        ),
        loteria_summary AS (
          SELECT
            loteria_id,
            loteria_name,
            SUM(amount)::float as total_sales,
            COUNT(DISTINCT ticket_id)::int as total_tickets,
            SUM(COALESCE(commission_amount, 0))::float as total_commission
          FROM base_jugadas
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
