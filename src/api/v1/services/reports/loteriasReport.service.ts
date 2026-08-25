/**
 * Servicio de reportes de loterías
 */

import { Prisma, SorteoStatus, Role, BetType } from '../../../../generated/prisma/client';
import prisma from '../../../../core/prismaClient';
import { resolveDateRange, calculatePreviousPeriod, calculateChangePercent, calculatePercentage } from '../../utils/reports.utils';
import { DateToken, ReportMeta } from '../../types/reports.types';
import { formatIsoLocal } from '../../../../utils/datetime';
import { commissionResolver } from '../../../../services/commission/CommissionResolver';

/**
 * Calcula comisiones de listero (ventana) desde las políticas de comisión
 * Similar a computeVentanaCommissionFromPolicies pero agrupado por lotería
 */
async function computeListeroCommissionByLoteria(
  fromBusinessDate: Date,
  toBusinessDate: Date,
  loteriaId?: string,
  bancaId?: string
): Promise<Map<string, number>> {
  // Obtener jugadas en el rango con businessDate del ticket.
  // CORRECCIÓN: el filtro de fecha se delega a la base de datos (WHERE en Prisma)
  // para evitar traer millones de filas y filtrarlas en memoria.
  const jugadasInRange = await prisma.jugada.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      ticket: {
        deletedAt: null,
        isActive: true,
        status: { in: ['ACTIVE', 'EVALUATED', 'PAID'] },
        businessDate: {
          gte: fromBusinessDate,
          lte: toBusinessDate,
        },
        ...(loteriaId ? { loteriaId } : {}),
        ...(bancaId ? { bancaId } : {}),
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
        const policy = commissionResolver.parsePolicy(userPolicyJson, "USER");
        const resolution = commissionResolver.resolveFromPolicy(policy, {
          userId: ventanaUserId,
          loteriaId: ticket.loteriaId,
          betType: jugada.type as BetType,
          finalMultiplierX: jugada.finalMultiplierX ?? undefined,
        });
        ventanaAmount = parseFloat(((jugada.amount * resolution.percent) / 100).toFixed(2));
      } catch (err) {
        // Si falla, usar políticas de VENTANA/BANCA
        const fallback = commissionResolver.resolveVendedorCommission(
          {
            loteriaId: ticket.loteriaId,
            betType: jugada.type as BetType,
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
      const fallback = commissionResolver.resolveVendedorCommission(
        {
          loteriaId: ticket.loteriaId,
          betType: jugada.type as BetType,
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
    bancaId?: string;
  }): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    // Convertir fechas a strings en formato CR para comparación con businessDate
    const fromDateStr = dateRange.fromString; // YYYY-MM-DD
    const toDateStr = dateRange.toString; // YYYY-MM-DD

    // Query optimizada usando CTEs (Matriz Unificada: Ticket para OPEN, ResumenCierreDiario para EVALUATED, 0 JOINs a Jugada)
    const loteriasQuery = Prisma.sql`
      WITH open_sales AS (
        SELECT 
          t."loteriaId",
          COUNT(t.id) as tickets_count,
          COALESCE(SUM(t."totalAmount"), 0) as ventas_total,
          COUNT(DISTINCT CASE WHEN t."isWinner" = true THEN t.id END) as winning_tickets_count,
          COALESCE(SUM(t."totalPayout"), 0) as payout_total,
          COALESCE(SUM(t."totalListeroCommission"), 0) as commission_listero,
          COUNT(t.id) as jugadas_count
        FROM "Ticket" t
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        WHERE t."deletedAt" IS NULL
          AND t."isActive" = true
          AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
          AND s.status = 'OPEN'
          AND t."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY t."loteriaId"
      ),
      evaluated_sales AS (
        SELECT
          rcd."loteriaId",
          COALESCE(SUM(rcd."ticketsCount"), 0) as tickets_count,
          COALESCE(SUM(rcd."totalVendida"), 0) as ventas_total,
          0 as winning_tickets_count,
          COALESCE(SUM(rcd."ganado"), 0) as payout_total,
          COALESCE(SUM(rcd."comisionTotal"), 0) as commission_listero,
          COALESCE(SUM(rcd."jugadasCount"), 0) as jugadas_count
        FROM "ResumenCierreDiario" rcd
        WHERE rcd."businessDate" BETWEEN ${fromDateStr}::date AND ${toDateStr}::date
          ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND rcd."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND rcd."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY rcd."loteriaId"
      ),
      combined_sales AS (
        SELECT "loteriaId", tickets_count, ventas_total, winning_tickets_count, payout_total, commission_listero, jugadas_count FROM open_sales
        UNION ALL
        SELECT "loteriaId", tickets_count, ventas_total, winning_tickets_count, payout_total, commission_listero, jugadas_count FROM evaluated_sales
      ),
      loteria_stats AS (
        SELECT 
          "loteriaId",
          SUM(tickets_count)::bigint as tickets_count,
          SUM(ventas_total)::double precision as ventas_total,
          CASE WHEN SUM(tickets_count) > 0 THEN SUM(ventas_total) / SUM(tickets_count) ELSE 0 END as avg_ticket_amount,
          SUM(winning_tickets_count)::bigint as winning_tickets_count,
          SUM(payout_total)::double precision as payout_total,
          SUM(commission_listero)::double precision as commission_listero,
          SUM(jugadas_count)::bigint as jugadas_count
        FROM combined_sales
        GROUP BY "loteriaId"
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
      commission_listero: number;
      neto_sin_comision: number;
      margin_sin_comision: number;
      payout_ratio: number;
    }>>(loteriasQuery);

    // Aplicar comisiones de listero pre-calculadas directamente desde la base de datos (0 scans a Jugada)
    const loteriasWithCommission = loterias.map(l => {
      const commissionListero = Number(l.commission_listero) || 0;
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
      // CORRECCIÓN: el filtro de fecha se mueve al WHERE de Prisma para evitar
      // filtrado en memoria con toISOString() que viola el estándar de TZ Costa Rica.
      const [fy2, fm2, fd2] = dateRange.fromString.split('-').map(Number);
      const [ty2, tm2, td2] = dateRange.toString.split('-').map(Number);

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
              businessDate: {
                gte: new Date(Date.UTC(fy2, fm2 - 1, fd2)),
                lte: new Date(Date.UTC(ty2, tm2 - 1, td2)),
              },
            },
            select: {
              id: true,
              totalAmount: true,
              totalPayout: true,
            },
          },
        },
      });

      const sorteosData = sorteos.map(s => {
        const ventasTotal = s.tickets.reduce((sum, t) => sum + t.totalAmount, 0);
        const payoutTotal = s.tickets.reduce((sum, t) => sum + (t.totalPayout || 0), 0);
        return {
          sorteoId: s.id,
          sorteoName: s.name,
          scheduledAt: formatIsoLocal(s.scheduledAt),
          status: s.status,
          ventasTotal,
          ticketsCount: s.tickets.length,
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

