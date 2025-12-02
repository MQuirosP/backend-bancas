// src/api/v1/services/commissions.service.ts
import { Prisma, Role } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { PaginatedResult, buildMeta, getSkipTake } from "../../../utils/pagination";
import logger from "../../../core/logger";
import { resolveDateRange } from "../../../utils/dateRange";

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
    ventanaId?: string;
    ventanaName?: string;
    vendedorId?: string;
    vendedorName?: string;
    totalSales: number;
    totalTickets: number;
    totalCommission: number;
    totalPayouts: number;
    commissionListero?: number;
    commissionVendedor?: number;
    net?: number; // ✅ NUEVO: Ganancia neta (totalSales - totalPayouts - commissionVendedor)
  }>> {
    try {
      // Resolver rango de fechas
      const dateRange = resolveDateRange(date, fromDate, toDate);
      const COSTA_RICA_OFFSET_HOURS = -6;
      const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
      const fromDateCr = new Date(dateRange.fromAt.getTime() + offsetMs);
      const toDateCr = new Date(dateRange.toAt.getTime() + offsetMs);
      const fromDateStr = fromDateCr.toISOString().split("T")[0];
      const toDateStr = toDateCr.toISOString().split("T")[0];

      // Construir filtros WHERE dinámicos según RBAC
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${fromDateStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${toDateStr}::date`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Exclusión TOTAL)
        Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle
          JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId"
          AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
          AND sle.multiplier_id IS NULL
        )`,
      ];

      // Filtrar por banca activa (para ADMIN multibanca)
      if (filters.bancaId) {
        whereConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Ventana" v 
          WHERE v.id = t."ventanaId" 
          AND v."bancaId" = ${filters.bancaId}::uuid
        )`);
      }

      // Aplicar filtros de RBAC según scope
      if (filters.dimension === "vendedor") {
        if (filters.vendedorId) {
          // Filtrar por vendedor específico (ADMIN con filtro)
          whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
        }
        // Si scope=mine, el RBAC ya aplicó el filtro de vendedorId
        // También aplicar ventanaId si está presente (para filtrar vendedores de una ventana específica)
        if (filters.ventanaId) {
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId) {
          // Filtrar por ventana específica (ADMIN con filtro)
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
        // Si scope=mine, el RBAC ya aplicó el filtro de ventanaId
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

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
      if (filters.dimension === "ventana") {
        // Agrupar por día Y por ventana
        // Solo incluir ventanas que tienen tickets en el periodo (según scope)
        const result = await prisma.$queryRaw<
          Array<{
            business_date: Date;
            ventana_id: string;
            ventana_name: string;
            total_sales: string;
            total_payouts: string;
            total_tickets: string;
            total_commission: string;
          }>
        >`
          SELECT
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) as business_date,
            v.id as ventana_id,
            v.name as ventana_name,
            COALESCE(SUM(t."totalAmount"), 0)::text as total_sales,
            COALESCE(SUM(t."totalPayout"), 0)::text as total_payouts,
            COUNT(DISTINCT t.id)::text as total_tickets,
            COALESCE(SUM(t."totalCommission"), 0)::text as total_commission
          FROM "Ticket" t
          INNER JOIN "Ventana" v ON v.id = t."ventanaId"
          ${whereClause}
          GROUP BY business_date, v.id, v.name
          ORDER BY business_date DESC, v.name ASC
        `;

        logger.info({
          layer: "service",
          action: "COMMISSIONS_LIST_VENTANA",
          payload: {
            dateRange: {
              fromAt: dateRange.fromAt.toISOString(),
              toAt: dateRange.toAt.toISOString(),
            },
            filters,
            resultCount: result.length,
          },
        });

        // ============================================================================
        // CAMBIO: Cuando dimension=ventana, calcular todo desde jugadas individuales
        // ============================================================================
        // Esto asegura que totalSales, totalTickets y totalCommission coincidan
        // exactamente con el endpoint detail (que también calcula desde jugadas)
        // Antes: totalSales y totalTickets venían de Ticket, solo totalCommission se recalculaba
        // Ahora: Todo se calcula desde jugadas individuales para consistencia
        // ============================================================================
        if (filters.dimension === "ventana" && ventanaUserPolicy) {
          // Obtener el ventanaId del usuario VENTANA para aplicar su política solo a su ventana
          const ventanaUser = await prisma.user.findUnique({
            where: { id: ventanaUserId || "" },
            select: { ventanaId: true },
          });
          const targetVentanaId = ventanaUser?.ventanaId;

          // Obtener todas las jugadas del periodo para calcular todo desde ellas
          // Usar zona horaria de Costa Rica para el agrupamiento por fecha
          const jugadas = await prisma.$queryRaw<
            Array<{
              business_date: Date;
              ventana_id: string;
              ventana_name: string;
              ticket_id: string;
              amount: number;
              ticket_total_payout: number | null;
              commission_amount: number | null;
              listero_commission_amount: number | null;
            }>
          >`
            SELECT
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              ) as business_date,
              t."ventanaId" as ventana_id,
              v.name as ventana_name,
              t.id as ticket_id,
              j.amount,
              t."totalPayout" as ticket_total_payout,
              j."commissionAmount" as commission_amount,
              j."listeroCommissionAmount" as listero_commission_amount
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            INNER JOIN "Ventana" v ON v.id = t."ventanaId"
            ${whereClause}
            AND j."isExcluded" IS FALSE
            AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              JOIN "User" u_ex ON u_ex.id = sle.ventana_id
              WHERE sle.sorteo_id = t."sorteoId"
              AND u_ex."ventanaId" = t."ventanaId"
              AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
              AND sle.multiplier_id = j."multiplierId"
            )
          `;

          // Agrupar jugadas por día y ventana, calculando todo desde las jugadas
          const byDateAndVentana = new Map<
            string,
            {
              ventanaId: string;
              ventanaName: string;
              totalSales: number;
              totalPayouts: number;
              totalTickets: Set<string>;
              commissionListero: number;
              commissionVendedor: number;
              payoutTickets: Set<string>;
            }
          >();

          for (const jugada of jugadas) {
            // Usar snapshot de comisión del listero guardado en BD, NO recalcular
            const commissionListero = Number(jugada.listero_commission_amount || 0);

            const dateKey = jugada.business_date.toISOString().split("T")[0]; // YYYY-MM-DD
            const key = `${dateKey}_${jugada.ventana_id}`;

            let entry = byDateAndVentana.get(key);
            if (!entry) {
              entry = {
                ventanaId: jugada.ventana_id,
                ventanaName: jugada.ventana_name,
                totalSales: 0,
                totalPayouts: 0,
                totalTickets: new Set<string>(),
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTickets: new Set<string>(),
              };
              byDateAndVentana.set(key, entry);
            }

            entry.totalSales += jugada.amount;
            entry.totalTickets.add(jugada.ticket_id);
            entry.commissionListero += commissionListero;
            entry.commissionVendedor += Number(jugada.commission_amount || 0);
            if (!entry.payoutTickets.has(jugada.ticket_id)) {
              entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
              entry.payoutTickets.add(jugada.ticket_id);
            }
          }

          // Convertir a formato de respuesta
          const items = Array.from(byDateAndVentana.entries()).map(([key, entry]) => {
            const date = key.split("_")[0];
            // Cuando dimension=ventana, totalCommission debe ser solo commissionListero
            // commissionVendedor es la comisión del vendedor (snapshot), no cuenta para la ventana
            const totalCommission = entry.commissionListero;
            return {
              date, // YYYY-MM-DD
              ventanaId: entry.ventanaId,
              ventanaName: entry.ventanaName,
              totalSales: entry.totalSales,
              totalTickets: entry.totalTickets.size,
              totalCommission, // Solo comisión de listero (ventana)
              totalPayouts: entry.totalPayouts,
              commissionListero: entry.commissionListero,
              commissionVendedor: entry.commissionVendedor,
              // Ganancia neta para VENTANA: ventas - premios - comisión listero
              net: entry.totalSales - entry.totalPayouts - entry.commissionListero,
            };
          }).sort((a, b) => {
            // Ordenar por fecha DESC, luego por nombre de ventana ASC
            if (a.date !== b.date) {
              return b.date.localeCompare(a.date);
            }
            return a.ventanaName.localeCompare(b.ventanaName);
          });

          return items;
        }

        // ============================================================================
        // FIX: Cuando dimension=ventana y NO hay ventanaUserPolicy, usar snapshots de comisión
        // ============================================================================
        // Las comisiones ya están guardadas como snapshots en listeroCommissionAmount
        // Simplemente las sumamos directamente sin recalcular
        // ============================================================================
        if (filters.dimension === "ventana" && !ventanaUserPolicy) {
          // Obtener todas las jugadas del periodo con snapshots de comisión
          const jugadas = await prisma.$queryRaw<
            Array<{
              business_date: Date;
              ventana_id: string;
              ventana_name: string;
              ticket_id: string;
              amount: number;
              ticket_total_payout: number | null;
              commission_amount: number | null;
              listero_commission_amount: number | null;
            }>
          >`
            SELECT
              COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
              ) as business_date,
              t."ventanaId" as ventana_id,
              v.name as ventana_name,
              t.id as ticket_id,
              j.amount,
              t."totalPayout" as ticket_total_payout,
              j."commissionAmount" as commission_amount,
              j."listeroCommissionAmount" as listero_commission_amount
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            INNER JOIN "Ventana" v ON v.id = t."ventanaId"
            ${whereClause}
            AND j."isExcluded" IS FALSE
            AND NOT EXISTS (
              SELECT 1 FROM "sorteo_lista_exclusion" sle
              JOIN "User" u_ex ON u_ex.id = sle.ventana_id
              WHERE sle.sorteo_id = t."sorteoId"
              AND u_ex."ventanaId" = t."ventanaId"
              AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
              AND sle.multiplier_id = j."multiplierId"
            )
          `;

          // Agrupar jugadas por día y ventana, usando snapshots de comisión
          const byDateAndVentana = new Map<
            string,
            {
              ventanaId: string;
              ventanaName: string;
              totalSales: number;
              totalPayouts: number;
              totalTickets: Set<string>;
              commissionListero: number;
              commissionVendedor: number;
              payoutTickets: Set<string>;
            }
          >();

          for (const jugada of jugadas) {
            // Usar snapshot de comisión del listero guardado en BD, NO recalcular
            const commissionListero = Number(jugada.listero_commission_amount || 0);

            const dateKey = jugada.business_date.toISOString().split("T")[0]; // YYYY-MM-DD
            const key = `${dateKey}_${jugada.ventana_id}`;

            let entry = byDateAndVentana.get(key);
            if (!entry) {
              entry = {
                ventanaId: jugada.ventana_id,
                ventanaName: jugada.ventana_name,
                totalSales: 0,
                totalPayouts: 0,
                totalTickets: new Set<string>(),
                commissionListero: 0,
                commissionVendedor: 0,
                payoutTickets: new Set<string>(),
              };
              byDateAndVentana.set(key, entry);
            }

            entry.totalSales += jugada.amount;
            entry.totalTickets.add(jugada.ticket_id);
            entry.commissionListero += commissionListero;
            entry.commissionVendedor += Number(jugada.commission_amount || 0);
            if (!entry.payoutTickets.has(jugada.ticket_id)) {
              entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
              entry.payoutTickets.add(jugada.ticket_id);
            }
          }

          // Convertir a formato de respuesta
          const items = Array.from(byDateAndVentana.entries()).map(([key, entry]) => {
            const date = key.split("_")[0];
            // Cuando dimension=ventana, totalCommission debe ser solo commissionListero
            // commissionVendedor es la comisión del vendedor (snapshot), no cuenta para la ventana
            const totalCommission = entry.commissionListero;
            return {
              date, // YYYY-MM-DD
              ventanaId: entry.ventanaId,
              ventanaName: entry.ventanaName,
              totalSales: entry.totalSales,
              totalTickets: entry.totalTickets.size,
              totalCommission, // Solo comisión de listero (ventana)
              totalPayouts: entry.totalPayouts,
              commissionListero: entry.commissionListero,
              commissionVendedor: entry.commissionVendedor,
              // Ganancia neta para VENTANA: ventas - premios - comisión listero
              net: entry.totalSales - entry.totalPayouts - entry.commissionListero,
            };
          }).sort((a, b) => {
            // Ordenar por fecha DESC, luego por nombre de ventana ASC
            if (a.date !== b.date) {
              return b.date.localeCompare(a.date);
            }
            return a.ventanaName.localeCompare(b.ventanaName);
          });

          return items;
        }

        // Fallback: solo si realmente no hay forma de calcular (caso edge muy raro)
        // Este caso no debería ocurrir en producción si las ventanas tienen políticas configuradas
        return result.map((r) => {
          const commissionVendedor = parseFloat(r.total_commission);
          return {
            date: r.business_date.toISOString().split("T")[0], // YYYY-MM-DD
            ventanaId: r.ventana_id,
            ventanaName: r.ventana_name,
            totalSales: parseFloat(r.total_sales),
            totalTickets: parseInt(r.total_tickets, 10),
            totalCommission: commissionVendedor, // Fallback: usar snapshot del vendedor (no ideal)
            totalPayouts: parseFloat(r.total_payouts),
            commissionListero: 0,
            commissionVendedor,
            // Ganancia neta para VENTANA: ventas - premios - comisión listero
            net: parseFloat(r.total_sales) - parseFloat(r.total_payouts) - 0, // commissionListero is 0 in fallback
          };
        });
      } else if (filters.dimension === "vendedor") {
        // Agrupar por día Y por vendedor
        // Usar snapshots de comisión guardados en la BD (listeroCommissionAmount)
        const jugadas = await prisma.$queryRaw<
          Array<{
            business_date: Date;
            vendedor_id: string;
            vendedor_name: string;
            ticket_id: string;
            amount: number;
            ticket_total_payout: number | null;
            commission_amount: number | null;
            listero_commission_amount: number | null;
          }>
        >`
          SELECT
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) as business_date,
            t."vendedorId" as vendedor_id,
            u.name as vendedor_name,
            t.id as ticket_id,
            j.amount,
            t."totalPayout" as ticket_total_payout,
            j."commissionAmount" as commission_amount,
            j."listeroCommissionAmount" as listero_commission_amount
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL AND j."isExcluded" IS FALSE
          INNER JOIN "User" u ON u.id = t."vendedorId"
          ${whereClause}
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u_ex ON u_ex.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u_ex."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
        `;

        // Agrupar jugadas por día y vendedor, usando snapshots de comisión
        const byDateAndVendedor = new Map<
          string,
          {
            vendedorId: string;
            vendedorName: string;
            totalSales: number;
            totalPayouts: number;
            totalTickets: Set<string>;
            commissionListero: number;
            commissionVendedor: number;
            payoutTickets: Set<string>;
          }
        >();

        for (const jugada of jugadas) {
          const dateKey = jugada.business_date.toISOString().split("T")[0]; // YYYY-MM-DD
          const key = `${dateKey}_${jugada.vendedor_id}`;

          let entry = byDateAndVendedor.get(key);
          if (!entry) {
            entry = {
              vendedorId: jugada.vendedor_id,
              vendedorName: jugada.vendedor_name,
              totalSales: 0,
              totalPayouts: 0,
              totalTickets: new Set<string>(),
              commissionListero: 0,
              commissionVendedor: 0,
              payoutTickets: new Set<string>(),
            };
            byDateAndVendedor.set(key, entry);
          }

          entry.totalSales += jugada.amount;
          entry.totalTickets.add(jugada.ticket_id);
          // Usar snapshot de comisión del listero guardado en BD
          entry.commissionListero += Number(jugada.listero_commission_amount || 0);
          entry.commissionVendedor += Number(jugada.commission_amount || 0);
          if (!entry.payoutTickets.has(jugada.ticket_id)) {
            entry.totalPayouts += Number(jugada.ticket_total_payout || 0);
            entry.payoutTickets.add(jugada.ticket_id);
          }
        }

        logger.info({
          layer: "service",
          action: "COMMISSIONS_LIST_VENDEDOR",
          payload: {
            dateRange: {
              fromAt: dateRange.fromAt.toISOString(),
              toAt: dateRange.toAt.toISOString(),
            },
            filters,
            resultCount: byDateAndVendedor.size,
          },
        });

        // Convertir a formato de respuesta
        const items = Array.from(byDateAndVendedor.entries()).map(([key, entry]) => {
          const date = key.split("_")[0];
          return {
            date, // YYYY-MM-DD
            vendedorId: entry.vendedorId,
            vendedorName: entry.vendedorName,
            totalSales: entry.totalSales,
            totalTickets: entry.totalTickets.size,
            totalCommission: entry.commissionListero + entry.commissionVendedor,
            totalPayouts: entry.totalPayouts,
            commissionListero: entry.commissionListero,
            commissionVendedor: entry.commissionVendedor,
            // Ganancia del listero = comisión listero - comisión vendedor
            gananciaListero: entry.commissionListero - entry.commissionVendedor,
            // Para VENDEDOR: ganancia neta = ventas - premios - comisión listero
            gananciaNeta: entry.totalSales - entry.totalPayouts - entry.commissionListero,
            net: entry.totalSales - entry.totalPayouts - entry.commissionListero, // Alias
          };
        }).sort((a, b) => {
          // Ordenar por fecha DESC, luego por nombre ASC
          if (a.date !== b.date) {
            return b.date.localeCompare(a.date);
          }
          return a.vendedorName.localeCompare(b.vendedorName);
        });

        return items;
      } else {
        // Sin dimensión: solo agrupar por día
        const result = await prisma.$queryRaw<
          Array<{
            business_date: Date;
            total_sales: string;
            total_payouts: string;
            total_tickets: string;
            total_commission: string;
          }>
        >`
          SELECT
            COALESCE(
              t."businessDate",
              DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) as business_date,
            COALESCE(SUM(t."totalAmount"), 0)::text as total_sales,
            COALESCE(SUM(t."totalPayout"), 0)::text as total_payouts,
            COUNT(DISTINCT t.id)::text as total_tickets,
            COALESCE(SUM(t."totalCommission"), 0)::text as total_commission
          FROM "Ticket" t
          ${whereClause}
          GROUP BY business_date
          ORDER BY business_date DESC
        `;

        logger.info({
          layer: "service",
          action: "COMMISSIONS_LIST_NO_DIMENSION",
          payload: {
            dateRange: {
              fromAt: dateRange.fromAt.toISOString(),
              toAt: dateRange.toAt.toISOString(),
            },
            filters,
            resultCount: result.length,
          },
        });

        return result.map((r) => ({
          date: r.business_date.toISOString().split("T")[0], // YYYY-MM-DD
          totalSales: parseFloat(r.total_sales),
          totalPayouts: parseFloat(r.total_payouts),
          totalTickets: parseInt(r.total_tickets, 10),
          totalCommission: parseFloat(r.total_commission),
          commissionListero: undefined,
          commissionVendedor: undefined,
        }));
      }
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
      const COSTA_RICA_OFFSET_HOURS = -6;
      const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
      const fromDateCr = new Date(dateRange.fromAt.getTime() + offsetMs);
      const toDateCr = new Date(dateRange.toAt.getTime() + offsetMs);
      const fromDateStr = fromDateCr.toISOString().split("T")[0];
      const toDateStr = toDateCr.toISOString().split("T")[0];

      // Construir filtros WHERE dinámicos según RBAC
      const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."deletedAt" IS NULL`,
        Prisma.sql`t."isActive" = true`,
        Prisma.sql`t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${fromDateStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${toDateStr}::date`,
        // ✅ NUEVO: Excluir tickets de listas bloqueadas (Exclusión TOTAL)
        Prisma.sql`NOT EXISTS (
          SELECT 1 FROM "sorteo_lista_exclusion" sle
          JOIN "User" u ON u.id = sle.ventana_id
          WHERE sle.sorteo_id = t."sorteoId"
          AND u."ventanaId" = t."ventanaId"
          AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
          AND sle.multiplier_id IS NULL
        )`,
      ];

      // Filtrar por banca activa (para ADMIN multibanca)
      if (filters.bancaId) {
        whereConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Ventana" v 
          WHERE v.id = t."ventanaId" 
          AND v."bancaId" = ${filters.bancaId}::uuid
        )`);
      }

      // Aplicar filtros de RBAC según dimension
      if (filters.dimension === "vendedor") {
        if (filters.vendedorId) {
          whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
        }
        // También aplicar ventanaId si está presente (para filtrar vendedores de una ventana específica)
        if (filters.ventanaId) {
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId) {
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
      }

      const whereClause = Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`;

      // Si dimension=ventana, obtener la política de comisiones del usuario VENTANA
      let ventanaUserPolicy: any = null;
      if (filters.dimension === "ventana" && ventanaUserId) {
        const ventanaUser = await prisma.user.findUnique({
          where: { id: ventanaUserId },
          select: { commissionPolicyJson: true },
        });
        ventanaUserPolicy = ventanaUser?.commissionPolicyJson ?? null;
      }

      // ============================================================================
      // CAMBIO: Cuando dimension=ventana, calcular jugada por jugada (igual que list)
      // ============================================================================
      // Esto asegura que los totales coincidan entre list y detail
      // Antes: Agrupábamos en SQL y aplicábamos porcentaje al total agrupado
      // Ahora: Calculamos jugada por jugada y luego agrupamos en memoria
      // ============================================================================
      if (filters.dimension === "ventana" && ventanaUserPolicy) {
        // Obtener todas las jugadas individuales del periodo con snapshots de comisión
        const jugadas = await prisma.$queryRaw<
          Array<{
            loteria_id: string;
            loteria_name: string;
            multiplier_id: string | null;
            multiplier_name: string | null;
            multiplier_value_x: number | null;
            multiplier_kind: string | null;
            amount: number;
            ticket_id: string;
            listero_commission_amount: number | null;
          }>
        >`
          SELECT
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            lm.id as multiplier_id,
            lm.name as multiplier_name,
            lm."valueX" as multiplier_value_x,
            lm.kind as multiplier_kind,
            j.amount,
            t.id as ticket_id,
            j."listeroCommissionAmount" as listero_commission_amount
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
          ${whereClause}
          AND NOT EXISTS (
            SELECT 1 FROM "sorteo_lista_exclusion" sle
            JOIN "User" u_ex ON u_ex.id = sle.ventana_id
            WHERE sle.sorteo_id = t."sorteoId"
            AND u_ex."ventanaId" = t."ventanaId"
            AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
            AND sle.multiplier_id = j."multiplierId"
          )
        `;

        // Agrupar por lotería y multiplicador, calculando comisiones jugada por jugada
        const byLoteria = new Map<
          string,
          {
            loteriaId: string;
            loteriaName: string;
            totalSales: number;
            totalTickets: Set<string>;
            totalCommission: number;
            multipliers: Map<string, {
              multiplierId: string;
              multiplierName: string;
              multiplierPercentage: number;
              totalSales: number;
              totalTickets: Set<string>;
              totalCommission: number;
              commissionSum: number;
              commissionCount: number;
            }>;
          }
        >();

        // Procesar cada jugada individualmente
        for (const jugada of jugadas) {
          // Usar snapshot de comisión del listero guardado en BD, NO recalcular
          const commission = Number(jugada.listero_commission_amount || 0);
          const commissionPercent = jugada.amount > 0 ? (commission / jugada.amount) * 100 : 0;

          // Construir clave única para el multiplicador
          const multiplierKey = jugada.multiplier_id || "REVENTADO";

          // Inicializar lotería si no existe
          if (!byLoteria.has(jugada.loteria_id)) {
            byLoteria.set(jugada.loteria_id, {
              loteriaId: jugada.loteria_id,
              loteriaName: jugada.loteria_name,
              totalSales: 0,
              totalTickets: new Set(),
              totalCommission: 0,
              multipliers: new Map(),
            });
          }

          const loteria = byLoteria.get(jugada.loteria_id)!;

          // Inicializar multiplicador si no existe
          if (!loteria.multipliers.has(multiplierKey)) {
            // Construir nombre del multiplicador
            let multiplierName: string;
            if (!jugada.multiplier_id || !jugada.multiplier_name) {
              multiplierName = "REVENTADO";
            } else if (jugada.multiplier_name === "Base" && jugada.multiplier_kind === "NUMERO" && jugada.multiplier_value_x) {
              multiplierName = `Base ${jugada.multiplier_value_x}x`;
            } else {
              multiplierName = jugada.multiplier_name;
            }

            loteria.multipliers.set(multiplierKey, {
              multiplierId: jugada.multiplier_id || "unknown",
              multiplierName,
              multiplierPercentage: 0,
              totalSales: 0,
              totalTickets: new Set(),
              totalCommission: 0,
              commissionSum: 0,
              commissionCount: 0,
            });
          }

          const multiplier = loteria.multipliers.get(multiplierKey)!;

          // Acumular datos
          multiplier.totalSales += jugada.amount;
          multiplier.totalTickets.add(jugada.ticket_id);
          multiplier.totalCommission += commission;
          multiplier.commissionSum += commissionPercent;
          multiplier.commissionCount += 1;

          loteria.totalSales += jugada.amount;
          loteria.totalTickets.add(jugada.ticket_id);
          loteria.totalCommission += commission;
        }

        // Convertir a estructura de respuesta y calcular porcentajes promedios
        const result: Array<{
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
        }> = [];

        for (const loteria of byLoteria.values()) {
          const multipliers = Array.from(loteria.multipliers.values()).map((m) => ({
            multiplierId: m.multiplierId,
            multiplierName: m.multiplierName,
            multiplierPercentage: m.commissionCount > 0
              ? Number((m.commissionSum / m.commissionCount).toFixed(2))
              : 0,
            totalSales: m.totalSales,
            totalTickets: m.totalTickets.size,
            totalCommission: m.totalCommission,
          }));

          // Ordenar multiplicadores por porcentaje descendente
          multipliers.sort((a, b) => b.multiplierPercentage - a.multiplierPercentage);

          result.push({
            loteriaId: loteria.loteriaId,
            loteriaName: loteria.loteriaName,
            totalSales: loteria.totalSales,
            totalTickets: loteria.totalTickets.size,
            totalCommission: loteria.totalCommission,
            multipliers,
          });
        }

        // Ordenar por nombre de lotería
        result.sort((a, b) => a.loteriaName.localeCompare(b.loteriaName));

        logger.info({
          layer: "service",
          action: "COMMISSIONS_DETAIL",
          payload: {
            date,
            filters,
            resultCount: result.length,
            calculationMethod: "jugada_por_jugada",
          },
        });

        return result;
      }

      // ============================================================================
      // FIX: Cuando dimension=ventana y NO hay ventanaUserPolicy, usar snapshots de comisión
      // ============================================================================
      // Las comisiones ya están guardadas como snapshots en la BD, simplemente las sumamos
      // ============================================================================
      if (filters.dimension === "ventana" && !ventanaUserPolicy) {
        // Obtener todas las jugadas individuales del periodo con snapshots de comisión
        const jugadas = await prisma.$queryRaw<
          Array<{
            loteria_id: string;
            loteria_name: string;
            multiplier_id: string | null;
            multiplier_name: string | null;
            multiplier_value_x: number | null;
            multiplier_kind: string | null;
            amount: number;
            listero_commission_amount: number;
            ticket_id: string;
          }>
        >`
          SELECT
            t."loteriaId" as loteria_id,
            l.name as loteria_name,
            lm.id as multiplier_id,
            lm.name as multiplier_name,
            lm."valueX" as multiplier_value_x,
            lm.kind as multiplier_kind,
            j.amount,
            j."listeroCommissionAmount" as listero_commission_amount,
            t.id as ticket_id
          FROM "Ticket" t
          INNER JOIN "Jugada" j ON j."ticketId" = t.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
          ${whereClause}
        `;

        // Agrupar por lotería y multiplicador, sumando comisiones snapshots
        const byLoteria = new Map<
          string,
          {
            loteriaId: string;
            loteriaName: string;
            totalSales: number;
            totalTickets: Set<string>;
            totalCommission: number;
            multipliers: Map<string, {
              multiplierId: string;
              multiplierName: string;
              multiplierPercentage: number;
              totalSales: number;
              totalTickets: Set<string>;
              totalCommission: number;
              commissionSum: number;
              commissionCount: number;
            }>;
          }
        >();

        // Procesar cada jugada usando snapshots
        for (const jugada of jugadas) {
          // Usar el snapshot directamente
          const commission = Number(jugada.listero_commission_amount || 0);
          const commissionPercent = jugada.amount > 0 ? (commission / jugada.amount) * 100 : 0;

          // Construir clave única para el multiplicador
          const multiplierKey = jugada.multiplier_id || "REVENTADO";

          // Inicializar lotería si no existe
          if (!byLoteria.has(jugada.loteria_id)) {
            byLoteria.set(jugada.loteria_id, {
              loteriaId: jugada.loteria_id,
              loteriaName: jugada.loteria_name,
              totalSales: 0,
              totalTickets: new Set(),
              totalCommission: 0,
              multipliers: new Map(),
            });
          }

          const loteria = byLoteria.get(jugada.loteria_id)!;

          // Inicializar multiplicador si no existe
          if (!loteria.multipliers.has(multiplierKey)) {
            // Construir nombre del multiplicador
            let multiplierName: string;
            if (!jugada.multiplier_id || !jugada.multiplier_name) {
              multiplierName = "REVENTADO";
            } else if (jugada.multiplier_name === "Base" && jugada.multiplier_kind === "NUMERO" && jugada.multiplier_value_x) {
              multiplierName = `Base ${jugada.multiplier_value_x}x`;
            } else {
              multiplierName = jugada.multiplier_name;
            }

            loteria.multipliers.set(multiplierKey, {
              multiplierId: jugada.multiplier_id || "unknown",
              multiplierName,
              multiplierPercentage: 0,
              totalSales: 0,
              totalTickets: new Set(),
              totalCommission: 0,
              commissionSum: 0,
              commissionCount: 0,
            });
          }

          const multiplier = loteria.multipliers.get(multiplierKey)!;

          // Acumular datos usando snapshots
          multiplier.totalSales += jugada.amount;
          multiplier.totalTickets.add(jugada.ticket_id);
          multiplier.totalCommission += commission;
          multiplier.commissionSum += commissionPercent;
          multiplier.commissionCount += 1;

          loteria.totalSales += jugada.amount;
          loteria.totalTickets.add(jugada.ticket_id);
          loteria.totalCommission += commission;
        }

        // Convertir a estructura de respuesta y calcular porcentajes promedios
        const result: Array<{
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
        }> = [];

        for (const loteria of byLoteria.values()) {
          const multipliers = Array.from(loteria.multipliers.values()).map((m) => ({
            multiplierId: m.multiplierId,
            multiplierName: m.multiplierName,
            multiplierPercentage: m.commissionCount > 0
              ? Number((m.commissionSum / m.commissionCount).toFixed(2))
              : 0,
            totalSales: m.totalSales,
            totalTickets: m.totalTickets.size,
            totalCommission: m.totalCommission,
          }));

          // Ordenar multiplicadores por porcentaje descendente
          multipliers.sort((a, b) => b.multiplierPercentage - a.multiplierPercentage);

          result.push({
            loteriaId: loteria.loteriaId,
            loteriaName: loteria.loteriaName,
            totalSales: loteria.totalSales,
            totalTickets: loteria.totalTickets.size,
            totalCommission: loteria.totalCommission,
            multipliers,
          });
        }

        // Ordenar por nombre de lotería
        result.sort((a, b) => a.loteriaName.localeCompare(b.loteriaName));

        logger.info({
          layer: "service",
          action: "COMMISSIONS_DETAIL",
          payload: {
            date,
            filters,
            resultCount: result.length,
            calculationMethod: "snapshot_based",
          },
        });

        return result;
      }

      // ============================================================================
      // CÓDIGO ORIGINAL: Para dimension=vendedor (sin cambios)
      // ============================================================================
      // Query para obtener datos por lotería y multiplicador
      // Agrupamos por lotería y multiplicador, sumando ventas y comisiones de las jugadas
      // REVENTADO puede no tener multiplierId (null), lo manejamos con LEFT JOIN
      const result = await prisma.$queryRaw<
        Array<{
          loteria_id: string;
          loteria_name: string;
          multiplier_id: string | null;
          multiplier_name: string | null;
          multiplier_value_x: number | null;
          multiplier_kind: string | null;
          bet_type: string;
          final_multiplier_x: number;
          commission_percent: number;
          total_sales: string;
          total_tickets: string;
          total_commission: string;
        }>
      >`
        SELECT
          l.id as loteria_id,
          l.name as loteria_name,
          lm.id as multiplier_id,
          lm.name as multiplier_name,
          lm."valueX" as multiplier_value_x,
          lm.kind as multiplier_kind,
          j.type as bet_type,
          AVG(j."finalMultiplierX") as final_multiplier_x,
          AVG(j."commissionPercent") as commission_percent,
          COALESCE(SUM(j.amount), 0)::text as total_sales,
          COUNT(DISTINCT t.id)::text as total_tickets,
          COALESCE(SUM(j."commissionAmount"), 0)::text as total_commission
        FROM "Ticket" t
        INNER JOIN "Jugada" j ON j."ticketId" = t.id
        INNER JOIN "Loteria" l ON l.id = t."loteriaId"
        LEFT JOIN "LoteriaMultiplier" lm ON lm.id = j."multiplierId"
        ${whereClause}
        AND j."isExcluded" IS FALSE
        GROUP BY l.id, l.name, lm.id, lm.name, lm."valueX", lm.kind, j.type
        ORDER BY l.name ASC, AVG(j."commissionPercent") DESC
      `;

      logger.info({
        layer: "service",
        action: "COMMISSIONS_DETAIL",
        payload: {
          date,
          filters,
          resultCount: result.length,
          calculationMethod: "sql_aggregation",
        },
      });

      // Agrupar por lotería y construir estructura de respuesta
      const byLoteria = new Map<
        string,
        {
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
        }
      >();

      for (const row of result) {
        const loteriaKey = row.loteria_id;
        if (!byLoteria.has(loteriaKey)) {
          byLoteria.set(loteriaKey, {
            loteriaId: row.loteria_id,
            loteriaName: row.loteria_name,
            totalSales: 0,
            totalTickets: 0,
            totalCommission: 0,
            multipliers: [],
          });
        }

        const loteria = byLoteria.get(loteriaKey)!;

        // Construir nombre del multiplicador según reglas:
        // - Si es NULL (REVENTADO): "REVENTADO" (nunca "Sin multiplicador")
        // - Si es "Base" y kind=NUMERO: "Base {valueX}x" (ej: "Base 90x")
        // - Si tiene otro nombre: usar el nombre tal cual
        let multiplierName: string;
        if (!row.multiplier_id || !row.multiplier_name) {
          // REVENTADO sin multiplicador
          multiplierName = "REVENTADO";
        } else if (row.multiplier_name === "Base" && row.multiplier_kind === "NUMERO" && row.multiplier_value_x) {
          // Base con valor: construir "Base {valueX}x"
          multiplierName = `Base ${row.multiplier_value_x}x`;
        } else {
          // Usar el nombre tal cual
          multiplierName = row.multiplier_name;
        }

        // Para VENDEDOR: usar el porcentaje y monto almacenado (del vendedor)
        // commission_percent ya está en formato 0-100, redondear a entero
        const multiplierPercentage = Number((row.commission_percent || 0).toFixed(2));
        const totalCommission = parseFloat(row.total_commission);

        const multiplier = {
          multiplierId: row.multiplier_id || "unknown",
          multiplierName,
          multiplierPercentage,
          totalSales: parseFloat(row.total_sales),
          totalTickets: parseInt(row.total_tickets, 10),
          totalCommission,
        };

        loteria.multipliers.push(multiplier);
        loteria.totalSales += multiplier.totalSales;
        loteria.totalTickets += multiplier.totalTickets;
        loteria.totalCommission += multiplier.totalCommission;
      }

      // Ordenar multiplicadores por porcentaje descendente dentro de cada lotería
      for (const loteria of byLoteria.values()) {
        loteria.multipliers.sort((a, b) => b.multiplierPercentage - a.multiplierPercentage);
      }

      return Array.from(byLoteria.values());
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
      const COSTA_RICA_OFFSET_HOURS = -6;
      const offsetMs = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;
      const fromDateCr = new Date(dateRange.fromAt.getTime() + offsetMs);
      const toDateCr = new Date(dateRange.toAt.getTime() + offsetMs);
      const fromDateStr = fromDateCr.toISOString().split("T")[0];
      const toDateStr = toDateCr.toISOString().split("T")[0];

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
        Prisma.sql`t."status" IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) >= ${fromDateStr}::date`,
        Prisma.sql`COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) <= ${toDateStr}::date`,
        Prisma.sql`t."loteriaId" = ${loteriaId}::uuid`,
      ];

      // Manejar multiplierId: "unknown" significa NULL (REVENTADO sin multiplicador)
      if (multiplierId === "unknown") {
        whereConditions.push(Prisma.sql`j."multiplierId" IS NULL`);
      } else {
        whereConditions.push(Prisma.sql`j."multiplierId" = ${multiplierId}::uuid`);
      }

      // Aplicar filtros de RBAC según dimension
      if (filters.dimension === "vendedor") {
        if (filters.vendedorId) {
          whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
        }
        // También aplicar ventanaId si está presente (para filtrar vendedores de una ventana específica)
        if (filters.ventanaId) {
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
        }
      } else if (filters.dimension === "ventana") {
        if (filters.ventanaId) {
          whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
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
};

export default CommissionsService;

