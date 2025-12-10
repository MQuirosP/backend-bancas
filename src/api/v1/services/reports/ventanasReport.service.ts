/**
 * Servicio de reportes de ventanas (listeros)
 */

import { Prisma, Role } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { resolveDateRange, normalizePagination, calculatePreviousPeriod, calculateChangePercent } from '../../utils/reports.utils';
import { DateToken, SortByVentanas, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';
import { resolveCommission } from '../../../../services/commission.resolver';
import { resolveCommissionFromPolicy } from '../../../../services/commission/commission.resolver';

/**
 * Calcula comisiones de listero (ventana) desde las políticas de comisión
 * Similar a computeVentanaCommissionFromPolicies pero agrupado por ventana
 */
async function computeListeroCommissionByVentana(
  fromDateStr: string,
  toDateStr: string,
  ventanaId?: string
): Promise<Map<string, number>> {
  // Obtener jugadas en el rango con businessDate del ticket
  const jugadas = await prisma.jugada.findMany({
    where: {
      deletedAt: null,
      ticket: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
        ...(ventanaId ? { ventanaId } : {}),
      },
    },
    select: {
      id: true,
      amount: true,
      type: true,
      finalMultiplierX: true,
      ticket: {
        select: {
          id: true,
          ventanaId: true,
          loteriaId: true,
          businessDate: true,
          createdAt: true,
          ventana: {
            select: {
              commissionPolicyJson: true,
              banca: {
                select: {
                  commissionPolicyJson: true,
                },
              },
            },
          },
        },
      },
    },
  });

  // Filtrar por businessDate
  const jugadasInRange = jugadas.filter(j => {
    const ticket = j.ticket;
    if (!ticket) return false;
    
    const ticketBusinessDate = ticket.businessDate
      ? new Date(ticket.businessDate).toISOString().split('T')[0]
      : new Date(ticket.createdAt).toISOString().split('T')[0];
    
    return ticketBusinessDate >= fromDateStr && ticketBusinessDate <= toDateStr;
  });

  if (jugadasInRange.length === 0) {
    return new Map<string, number>();
  }

  // Obtener usuarios VENTANA por ventana
  const ventanaIds = Array.from(
    new Set(
      jugadasInRange
        .map((j) => j.ticket?.ventanaId)
        .filter((id): id is string => typeof id === "string")
    )
  );

  const ventanaUsers = ventanaIds.length
    ? await prisma.user.findMany({
        where: {
          role: Role.VENTANA,
          isActive: true,
          deletedAt: null,
          ventanaId: { in: ventanaIds },
        },
        select: {
          id: true,
          ventanaId: true,
          commissionPolicyJson: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      })
    : [];

  const userPolicyByVentana = new Map<string, any>();
  const ventanaUserIdByVentana = new Map<string, string>();
  for (const user of ventanaUsers) {
    if (!user.ventanaId) continue;
    if (!userPolicyByVentana.has(user.ventanaId)) {
      userPolicyByVentana.set(user.ventanaId, user.commissionPolicyJson ?? null);
      ventanaUserIdByVentana.set(user.ventanaId, user.id);
    }
  }

  // Calcular comisiones por ventana
  const commissionByVentana = new Map<string, number>();

  for (const jugada of jugadasInRange) {
    const ticket = jugada.ticket;
    if (!ticket?.ventanaId) continue;

    const userPolicyJson = userPolicyByVentana.get(ticket.ventanaId) ?? null;
    const ventanaUserId = ventanaUserIdByVentana.get(ticket.ventanaId) ?? "";
    const ventanaPolicy = (ticket.ventana?.commissionPolicyJson as any) ?? null;
    const bancaPolicy = (ticket.ventana?.banca?.commissionPolicyJson as any) ?? null;

    let ventanaAmount = 0;

    if (userPolicyJson) {
      try {
        // Intentar calcular desde la política de USER del usuario VENTANA
        const resolution = resolveCommissionFromPolicy(userPolicyJson, {
          userId: ventanaUserId,
          loteriaId: ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX ?? null,
        });
        ventanaAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
      } catch (err) {
        // Si falla, usar políticas de VENTANA/BANCA
        const fallback = resolveCommission(
          {
            loteriaId: ticket.loteriaId,
            betType: jugada.type as "NUMERO" | "REVENTADO",
            finalMultiplierX: jugada.finalMultiplierX || 0,
            amount: jugada.amount,
          },
          null,
          ventanaPolicy,
          bancaPolicy
        );
        ventanaAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
      }
    } else {
      // Si no hay política de USER, usar políticas de VENTANA/BANCA
      const fallback = resolveCommission(
        {
          loteriaId: ticket.loteriaId,
          betType: jugada.type as "NUMERO" | "REVENTADO",
          finalMultiplierX: jugada.finalMultiplierX || 0,
          amount: jugada.amount,
        },
        null,
        ventanaPolicy,
        bancaPolicy
      );
      ventanaAmount = parseFloat((fallback.commissionAmount || 0).toFixed(2));
    }

    if (ventanaAmount > 0) {
      commissionByVentana.set(
        ticket.ventanaId,
        (commissionByVentana.get(ticket.ventanaId) || 0) + ventanaAmount
      );
    }
  }

  return commissionByVentana;
}

export const VentanasReportService = {
  /**
   * Ranking y comparativa de listeros
   */
  async getRanking(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    ventanaId?: string;
    top?: number;
    sortBy?: SortByVentanas;
    includeComparison?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const top = Math.min(50, Math.max(1, filters.top || 10));
    const sortBy = filters.sortBy || 'ventas';

    // Construir ORDER BY dinámico
    let orderByClause: Prisma.Sql;
    switch (sortBy) {
      case 'neto':
        orderByClause = Prisma.sql`(vs.ventas_total - vs.payout_total) DESC`;
        break;
      case 'margin':
        orderByClause = Prisma.sql`margin DESC`;
        break;
      case 'tickets':
        orderByClause = Prisma.sql`vs.tickets_count DESC`;
        break;
      case 'ventas':
      default:
        orderByClause = Prisma.sql`vs.ventas_total DESC`;
        break;
    }

    // Convertir fechas a strings en formato CR para comparación con businessDate
    const fromDateStr = dateRange.fromString; // YYYY-MM-DD
    const toDateStr = dateRange.toString; // YYYY-MM-DD

    // Query optimizada con CTEs
    // Usa businessDate (o createdAt convertido a CR) para filtrar por fecha de negocio
    // Incluye tickets ACTIVE, EVALUATED y PAID (excluye CANCELLED)
    const ventanasQuery = Prisma.sql`
      WITH tickets_in_range AS (
        SELECT 
          t.id,
          t."ventanaId",
          t."vendedorId",
          t."totalAmount",
          t."totalPayout",
          t."isWinner",
          COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))) as business_date
        FROM "Ticket" t
        WHERE t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND (
            COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))
          ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = ${filters.ventanaId}::uuid` : Prisma.empty}
      ),
      ventana_stats AS (
        SELECT 
          t."ventanaId",
          COUNT(DISTINCT t.id) as tickets_count,
          COUNT(DISTINCT t."vendedorId") as active_vendedores_count,
          COUNT(DISTINCT t.business_date) as activity_days,
          SUM(t."totalAmount") as ventas_total,
          AVG(t."totalAmount") as avg_ticket_amount,
          COUNT(DISTINCT CASE WHEN t."isWinner" THEN t.id END) as winning_tickets_count,
          SUM(COALESCE(t."totalPayout", 0)) as payout_total
        FROM tickets_in_range t
        GROUP BY t."ventanaId"
      )
      SELECT 
        vs.*,
        v.id as ventana_id,
        v.name as ventana_name,
        v.code as ventana_code,
        v."isActive" as is_active,
        (vs.ventas_total - vs.payout_total) as neto_sin_comision,
        CASE 
          WHEN vs.ventas_total > 0 
          THEN ((vs.ventas_total - vs.payout_total) / vs.ventas_total) * 100 
          ELSE 0 
        END as margin_sin_comision
      FROM ventana_stats vs
      INNER JOIN "Ventana" v ON vs."ventanaId" = v.id
      ORDER BY ${orderByClause}
      LIMIT ${top}
    `;

    const ventanas = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_id: string;
      ventana_name: string;
      ventana_code: string | null;
      is_active: boolean;
      tickets_count: number;
      active_vendedores_count: number;
      activity_days: number;
      ventas_total: number;
      avg_ticket_amount: number;
      winning_tickets_count: number;
      payout_total: number;
      neto_sin_comision: number;
      margin_sin_comision: number;
    }>>(ventanasQuery);

    // Calcular comisiones de listero desde las políticas de comisión
    const commissionByVentana = await computeListeroCommissionByVentana(
      fromDateStr,
      toDateStr,
      filters.ventanaId
    );

    // Aplicar comisiones de listero calculadas desde políticas
    const ventanasWithCommission = ventanas.map(v => {
      const commissionListero = commissionByVentana.get(v.ventanaId) || 0;
      const neto = parseFloat(v.neto_sin_comision.toString()) - commissionListero;
      const margin = parseFloat(v.ventas_total.toString()) > 0
        ? (neto / parseFloat(v.ventas_total.toString())) * 100
        : 0;
      
      return {
        ...v,
        commission_listero: commissionListero,
        neto,
        margin,
      };
    });

    // Obtener total de vendedores por ventana
    const ventanaIds = ventanas.map(v => v.ventanaId);
    const vendedoresCount = await prisma.user.groupBy({
      by: ['ventanaId'],
      where: {
        ventanaId: { in: ventanaIds },
        role: 'VENDEDOR',
        isActive: true,
      },
      _count: { id: true },
    });

    const vendedoresMap = new Map(
      vendedoresCount.map(v => [v.ventanaId, v._count.id])
    );

    const ventanasData = ventanasWithCommission.map((v, index) => ({
      ventanaId: v.ventanaId,
      ventanaName: v.ventana_name,
      ventanaCode: v.ventana_code || '',
      isActive: v.is_active,
      ventasTotal: parseFloat(v.ventas_total.toString()),
      ticketsCount: parseInt(v.tickets_count.toString()),
      avgTicketAmount: parseFloat(v.avg_ticket_amount.toString()),
      payoutTotal: parseFloat(v.payout_total.toString()),
      commissionListero: parseFloat((v.commission_listero || 0).toString()),
      winningTicketsCount: parseInt(v.winning_tickets_count.toString()),
      neto: parseFloat(v.neto.toString()),
      margin: parseFloat(v.margin.toString()),
      activeVendedoresCount: parseInt(v.active_vendedores_count.toString()),
      totalVendedoresCount: vendedoresMap.get(v.ventanaId) || 0,
      activityDays: parseInt(v.activity_days.toString()),
      rank: index + 1,
    }));

    // Calcular resumen
    const totalVentas = ventanasData.reduce((sum, v) => sum + v.ventasTotal, 0);
    const totalPayout = ventanasData.reduce((sum, v) => sum + v.payoutTotal, 0);
    const totalCommissionListero = ventanasData.reduce((sum, v) => sum + v.commissionListero, 0);
    const totalNeto = ventanasData.reduce((sum, v) => sum + v.neto, 0);
    const averageMargin = ventanasData.length > 0
      ? ventanasData.reduce((sum, v) => sum + v.margin, 0) / ventanasData.length
      : 0;

    return {
      data: {
        ventanas: ventanasData,
        summary: {
          totalVentas,
          totalPayout,
          totalCommissionListero,
          totalNeto,
          activeVentanas: ventanasData.filter(v => v.isActive).length,
          averageMargin: parseFloat(averageMargin.toFixed(2)),
        },
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        sortBy,
        comparisonEnabled: filters.includeComparison || false,
      },
    };
  },
};

