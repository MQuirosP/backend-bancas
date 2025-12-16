/**
 * Servicio de reportes de loterías
 */

import { Prisma, SorteoStatus, Role } from '@prisma/client';
import prisma from '../../../../core/prismaClient';
import { resolveDateRange, calculatePreviousPeriod, calculateChangePercent, calculatePercentage } from '../../utils/reports.utils';
import { DateToken, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';
import { resolveCommission } from '../../../../services/commission.resolver';
import { resolveCommissionFromPolicy } from '../../../../services/commission/commission.resolver';

/**
 * Calcula comisiones de listero (ventana) desde las políticas de comisión
 * Similar a computeVentanaCommissionFromPolicies pero agrupado por lotería
 */
async function computeListeroCommissionByLoteria(
  fromDateStr: string,
  toDateStr: string,
  loteriaId?: string
): Promise<Map<string, number>> {
  // Obtener jugadas en el rango con businessDate del ticket
  const jugadas = await prisma.jugada.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      ticket: {
        deletedAt: null,
        isActive: true,
        status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
        ...(loteriaId ? { loteriaId } : {}),
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

  // Calcular comisiones por lotería
  const commissionByLoteria = new Map<string, number>();

  for (const jugada of jugadasInRange) {
    const ticket = jugada.ticket;
    if (!ticket?.ventanaId || !ticket.loteriaId) continue;

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
      commissionByLoteria.set(
        ticket.loteriaId,
        (commissionByLoteria.get(ticket.loteriaId) || 0) + ventanaAmount
      );
    }
  }

  return commissionByLoteria;
}

export const LoteriasReportService = {
  /**
   * Reporte de rendimiento y rentabilidad por lotería
   */
  async getPerformance(filters: {
    date?: DateToken;
    fromDate?: string;
    toDate?: string;
    loteriaId?: string;
    includeComparison?: boolean;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Convertir fechas a strings en formato CR para comparación con businessDate
    const fromDateStr = dateRange.fromString; // YYYY-MM-DD
    const toDateStr = dateRange.toString; // YYYY-MM-DD

    // Query optimizada usando CTEs
    // Usa businessDate (o createdAt convertido a CR) para filtrar por fecha de negocio
    // Incluye tickets ACTIVE, EVALUATED y PAID (excluye CANCELLED)
    // IMPORTANTE: Separar agregaciones de tickets y jugadas para evitar duplicación
    const loteriasQuery = Prisma.sql`
      WITH tickets_in_range AS (
        SELECT 
          t.id,
          t."loteriaId",
          t."totalAmount",
          t."totalPayout",
          t."isWinner"
        FROM "Ticket" t
        WHERE t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND (
            COALESCE(t."businessDate", DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')))
          ) BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = ${filters.loteriaId}::uuid` : Prisma.empty}
      ),
      jugadas_count_per_loteria AS (
        SELECT 
          t."loteriaId",
          COUNT(DISTINCT j.id) as jugadas_count
        FROM tickets_in_range t
        LEFT JOIN "Jugada" j ON j."ticketId" = t.id AND j."deletedAt" IS NULL
        GROUP BY t."loteriaId"
      ),
      loteria_stats AS (
        SELECT 
          t."loteriaId",
          COUNT(DISTINCT t.id) as tickets_count,
          SUM(t."totalAmount") as ventas_total,
          AVG(t."totalAmount") as avg_ticket_amount,
          COUNT(DISTINCT CASE WHEN t."isWinner" THEN t.id END) as winning_tickets_count,
          SUM(COALESCE(t."totalPayout", 0)) as payout_total,
          COALESCE(jc.jugadas_count, 0) as jugadas_count
        FROM tickets_in_range t
        LEFT JOIN jugadas_count_per_loteria jc ON jc."loteriaId" = t."loteriaId"
        GROUP BY t."loteriaId", jc.jugadas_count
      )
      SELECT 
        ls.*,
        l.id as loteria_id,
        l.name as loteria_name,
        l."isActive" as is_active,
        (ls.ventas_total - ls.payout_total) as neto_sin_comision,
        CASE 
          WHEN ls.ventas_total > 0 
          THEN ((ls.ventas_total - ls.payout_total) / ls.ventas_total) * 100 
          ELSE 0 
        END as margin_sin_comision,
        CASE 
          WHEN ls.ventas_total > 0 
          THEN (ls.payout_total / ls.ventas_total) * 100 
          ELSE 0 
        END as payout_ratio
      FROM loteria_stats ls
      INNER JOIN "Loteria" l ON ls."loteriaId" = l.id
      WHERE l."isActive" = true
      ORDER BY ls.ventas_total DESC
    `;

    const loterias = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteria_id: string;
      loteria_name: string;
      is_active: boolean;
      tickets_count: number;
      jugadas_count: number;
      ventas_total: number;
      avg_ticket_amount: number;
      winning_tickets_count: number;
      payout_total: number;
      neto_sin_comision: number;
      margin_sin_comision: number;
      payout_ratio: number;
    }>>(loteriasQuery);

    // Calcular comisiones de listero desde las políticas de comisión
    const commissionByLoteria = await computeListeroCommissionByLoteria(
      fromDateStr,
      toDateStr,
      filters.loteriaId
    );

    // Aplicar comisiones de listero calculadas desde políticas
    const loteriasWithCommission = loterias.map(l => {
      const commissionListero = commissionByLoteria.get(l.loteriaId) || 0;
      const neto = parseFloat(l.neto_sin_comision.toString()) - commissionListero;
      const margin = parseFloat(l.ventas_total.toString()) > 0
        ? (neto / parseFloat(l.ventas_total.toString())) * 100
        : 0;
      
      return {
        ...l,
        commission_listero: commissionListero,
        neto,
        margin,
      };
    });

    // Calcular resumen total
    const totalVentas = loteriasWithCommission.reduce((sum, l) => sum + parseFloat(l.ventas_total.toString()), 0);
    const totalPayout = loteriasWithCommission.reduce((sum, l) => sum + parseFloat(l.payout_total.toString()), 0);
    const totalCommissionListero = loteriasWithCommission.reduce((sum, l) => sum + l.commission_listero, 0);
    const totalNeto = totalVentas - totalPayout - totalCommissionListero;
    const overallMargin = totalVentas > 0 ? (totalNeto / totalVentas) * 100 : 0;
    const activeLoterias = loteriasWithCommission.filter(l => l.is_active).length;

    const loteriasData: Array<{
      loteriaId: string;
      loteriaName: string;
      loteriaCode: string;
      isActive: boolean;
      ventasTotal: number;
      ticketsCount: number;
      jugadasCount: number;
      avgTicketAmount: number;
      payoutTotal: number;
      commissionListero: number;
      winningTicketsCount: number;
      neto: number;
      margin: number;
      payoutRatio: number;
      sorteos?: Array<{
        sorteoId: string;
        sorteoName: string;
        scheduledAt: string;
        status: string;
        ventasTotal: number;
        ticketsCount: number;
        payoutTotal: number;
      }>;
    }> = loteriasWithCommission.map(l => ({
      loteriaId: l.loteriaId,
      loteriaName: l.loteria_name,
      loteriaCode: '', // No hay código en el schema actual
      isActive: l.is_active,
      ventasTotal: parseFloat(l.ventas_total.toString()),
      ticketsCount: parseInt(l.tickets_count.toString()),
      jugadasCount: parseInt(l.jugadas_count.toString()),
      avgTicketAmount: parseFloat(l.avg_ticket_amount.toString()),
      payoutTotal: parseFloat(l.payout_total.toString()),
      commissionListero: parseFloat((l.commission_listero || 0).toString()),
      winningTicketsCount: parseInt(l.winning_tickets_count.toString()),
      neto: parseFloat(l.neto.toString()),
      margin: parseFloat(l.margin.toString()),
      payoutRatio: parseFloat(l.payout_ratio.toString()),
    }));

    // Si se especifica loteriaId, agregar detalle por sorteos
    if (filters.loteriaId && loteriasData.length > 0) {
      const sorteos = await prisma.sorteo.findMany({
        where: {
          loteriaId: filters.loteriaId,
          status: SorteoStatus.EVALUATED,
          scheduledAt: {
            gte: dateRange.from,
            lte: dateRange.to,
          },
        },
        include: {
          tickets: {
            where: {
              status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
              deletedAt: null,
            },
            select: {
              id: true,
              totalAmount: true,
              totalPayout: true,
              businessDate: true,
              createdAt: true,
            },
          },
        },
      });

      const sorteosData = sorteos.map(s => {
        // Filtrar tickets por businessDate dentro del rango solicitado
        const ticketsInRange = s.tickets.filter(t => {
          const ticketBusinessDate = t.businessDate 
            ? new Date(t.businessDate).toISOString().split('T')[0]
            : new Date(t.createdAt).toISOString().split('T')[0];
          return ticketBusinessDate >= fromDateStr && ticketBusinessDate <= toDateStr;
        });
        
        const ventasTotal = ticketsInRange.reduce((sum, t) => sum + t.totalAmount, 0);
        const payoutTotal = ticketsInRange.reduce((sum, t) => sum + (t.totalPayout || 0), 0);
        return {
          sorteoId: s.id,
          sorteoName: s.name,
          scheduledAt: formatIsoLocal(s.scheduledAt),
          status: s.status,
          ventasTotal,
          ticketsCount: ticketsInRange.length,
          payoutTotal,
        };
      });

      loteriasData[0].sorteos = sorteosData;
    }

    return {
      data: {
        loterias: loteriasData,
        summary: {
          totalVentas,
          totalPayout,
          totalCommissionListero,
          totalNeto,
          overallMargin: parseFloat(overallMargin.toFixed(2)),
          activeLoterias,
        },
      },
      meta: {
        dateRange: {
          from: dateRange.fromString,
          to: dateRange.toString,
        },
        comparisonEnabled: filters.includeComparison || false,
      },
    };
  },
};

