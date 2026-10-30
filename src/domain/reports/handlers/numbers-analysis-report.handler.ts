/**
 * Handler de reportes para Análisis de Números (Frecuencias, Drill-down, Exposición)
 */

import { Prisma, TicketStatus, SorteoStatus, BetType } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { resolveDateRange, calculatePreviousPeriod } from '../../../api/v1/utils/reports.utils';
import { DateToken } from '../../../api/v1/types/reports.types';
import { CacheService } from '../../../core/cache.service';
import { crDateService } from '../../../utils/crDateService';
import { withConnectionRetry } from '../../../core/withConnectionRetry';
import { formatDateOnly, resolveBreakdowns, getHybridBreakdown } from './reports-common.helper';

export interface NumbersAnalysisFilters {
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  loteriaId?: string;
  ventanaId?: string;
  vendedorId?: string;
  betType?: BetType | 'all';
  top?: number;
  includeComparison?: boolean;
  includeWinners?: boolean;
  includeExposure?: boolean;
  bancaId?: string;
}

export interface NumbersAnalysisDetailFilters {
  number: string;
  loteriaId: string;
  ventanaId?: string;
  vendedorId?: string;
  date?: DateToken;
  fromDate?: string;
  toDate?: string;
  betType?: BetType | 'all';
  bancaId?: string;
}

export const NumbersAnalysisReportHandler = {
  /**
   * Reporte de números más jugados
   */
  async getNumbersAnalysis(filters: NumbersAnalysisFilters): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    const todayCRStr = crDateService.dateUTCToCRString(new Date());
    const isToday = dateRange.toString >= todayCRStr;
    const ttl = isToday ? 45 : 300;
    const topLimit = filters.top || 10;

    const cacheKey = `reports:tickets:numbers-analysis:${filters.bancaId || 'all'}:${filters.ventanaId || 'all'}:${filters.vendedorId || 'all'}:${filters.loteriaId || 'all'}:${filters.betType || 'all'}:${dateRange.fromString}:${dateRange.toString}:${topLimit}:${Boolean(filters.includeComparison)}:${Boolean(filters.includeWinners)}:${Boolean(filters.includeExposure)}`;

    return CacheService.wrap(
      cacheKey,
      async () => {
        return withConnectionRetry(async () => {
          // Filtros de entidad para queries de Jugada/Ticket (filtrado por t.bancaId)
          const jugadaEntityFilters = Prisma.sql`
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
            ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
          `;

          // Filtros de entidad para queries de DailyNumberSales
          const dailySalesFilters = Prisma.sql`
            ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND db."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId && filters.ventanaId.trim() !== '' ? Prisma.sql`AND db."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId && filters.vendedorId.trim() !== '' ? Prisma.sql`AND db."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
            ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND db."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND db.type = ${filters.betType}::"BetType"` : Prisma.empty}
          `;

          const [numberSummary] = await prisma.$queryRaw<Array<{
            total_numbers: number;
            total_amount: number;
            total_tickets: number;
            total_jugadas: number;
            numbers: Array<{
              number: string;
              totalAmount: number;
              ticketsCount: number;
              jugadasCount: number;
              avgAmount: number;
              rank: number;
            }>;
          }>>(Prisma.sql`
            WITH per_number AS (
              SELECT
                j.number,
                SUM(j.amount)::double precision AS total_amount,
                COUNT(DISTINCT j."ticketId")::integer AS tickets_count,
                COUNT(*)::integer AS jugadas_count
              FROM "Jugada" j
              INNER JOIN "Ticket" t ON j."ticketId" = t.id
              WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
                AND t."deletedAt" IS NULL
                AND t."isActive" = true
                AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID', 'PAGADO')
                AND j."deletedAt" IS NULL
                AND j."isExcluded" = false
                ${jugadaEntityFilters}
              GROUP BY j.number
            ),
            summary AS (
              SELECT
                COUNT(*)::integer AS total_numbers,
                COALESCE(SUM(total_amount), 0)::double precision AS total_amount,
                COALESCE(SUM(tickets_count), 0)::integer AS total_tickets,
                COALESCE(SUM(jugadas_count), 0)::integer AS total_jugadas
              FROM per_number
            ),
            top_numbers AS (
              SELECT
                per_number.*,
                ROW_NUMBER() OVER (ORDER BY total_amount DESC, number)::integer AS rank
              FROM per_number
              ORDER BY total_amount DESC, number
              LIMIT ${topLimit}
            )
            SELECT
              summary.total_numbers,
              summary.total_amount,
              summary.total_tickets,
              summary.total_jugadas,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'number', top_numbers.number,
                    'totalAmount', top_numbers.total_amount,
                    'ticketsCount', top_numbers.tickets_count,
                    'jugadasCount', top_numbers.jugadas_count,
                    'avgAmount', top_numbers.total_amount / NULLIF(top_numbers.jugadas_count, 0),
                    'rank', top_numbers.rank
                  )
                  ORDER BY top_numbers.total_amount DESC, top_numbers.number
                ) FILTER (WHERE top_numbers.number IS NOT NULL),
                '[]'::jsonb
              ) AS numbers
            FROM summary
            LEFT JOIN top_numbers ON true
            GROUP BY
              summary.total_numbers,
              summary.total_amount,
              summary.total_tickets,
              summary.total_jugadas
          `);

          if (!numberSummary) {
            throw new Error('La consulta agregada de números no devolvió su fila de resumen.');
          }

          const finalNumbersRaw = numberSummary.numbers;
          const topNumberItem = finalNumbersRaw[0] || null;
          const summary = {
            totalNumbersPlayed: numberSummary.total_numbers,
            totalAmount: numberSummary.total_amount,
            totalTickets: numberSummary.total_tickets,
            topNumber: topNumberItem?.number || null,
            topNumberAmount: topNumberItem?.totalAmount || 0,
          };

          const DEFAULT_MULTIPLIER = 30;

          // Si se incluye exposure, calcular exposición por número
          let numbersWithExposure: any[] = [];
          let totalExposure = 0;
          let highRiskNumbers = 0;

          if (filters.includeExposure) {
            const exposureQuery = Prisma.sql`
              SELECT
                db.number,
                SUM(db."totalAmount") as total_amount,
                80 as avg_multiplier
              FROM "DailyNumberSales" db
              WHERE db."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
                ${dailySalesFilters}
              GROUP BY db.number
            `;

            const exposureData = await prisma.$queryRaw<Array<{
              number: string;
              total_amount: number;
              avg_multiplier: number | null;
            }>>(exposureQuery);

            const exposureMap = new Map(exposureData.map(e => [
              e.number,
              {
                exposure: parseFloat(e.total_amount.toString()) * parseFloat(e.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString()),
                multiplier: parseFloat(e.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString()),
              },
            ]));

            numbersWithExposure = finalNumbersRaw.map(n => {
              const expData = exposureMap.get(n.number);
              const exposure = expData?.exposure || 0;
              totalExposure += exposure;
              if (exposure > 100000) highRiskNumbers++;
              return {
                number: n.number,
                exposure,
              };
            });
          }

          // Números ganadores (hot/cold numbers) si se solicita
          let hotNumbers: any[] = [];
          let coldNumbers: any[] = [];

          if (filters.includeWinners) {
            // Hot numbers: números que más han ganado
            const hotNumbersQuery = Prisma.sql`
              SELECT
                s."winningNumber" as number,
                COUNT(*) as times_won,
                MAX(s."updatedAt") as last_won_date
              FROM "Sorteo" s
              WHERE s."winningNumber" IS NOT NULL
                AND s.status::text = ${SorteoStatus.EVALUATED}
                AND s."deletedAt" IS NULL
                ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
              GROUP BY s."winningNumber"
              ORDER BY times_won DESC
              LIMIT 10
            `;

            const hotNumbersRaw = await prisma.$queryRaw<Array<{
              number: string;
              times_won: bigint;
              last_won_date: Date;
            }>>(hotNumbersQuery);

            hotNumbers = hotNumbersRaw.map(h => ({
              number: h.number,
              timesWon: parseInt(h.times_won.toString()),
              lastWonDate: h.last_won_date ? formatDateOnly(h.last_won_date) : null,
            }));

            // Cold numbers: números sin ganar hace mucho tiempo
            const coldNumbersQuery = Prisma.sql`
              WITH all_numbers AS (
                SELECT DISTINCT j.number
                FROM "Jugada" j
                INNER JOIN "Ticket" t ON j."ticketId" = t.id
                WHERE t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
                  AND t.status::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
                  AND t."deletedAt" IS NULL
                  AND t."isActive" = true
                  AND j."deletedAt" IS NULL
                  AND j."isActive" = true
                  AND j."isExcluded" = false
                  ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
              ),
              last_wins AS (
                SELECT
                  s."winningNumber" as number,
                  MAX(s."updatedAt") as last_won_date
                FROM "Sorteo" s
                WHERE s."winningNumber" IS NOT NULL
                  AND s.status::text = ${SorteoStatus.EVALUATED}
                  ${filters.loteriaId && filters.loteriaId.trim() !== '' ? Prisma.sql`AND s."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
                GROUP BY s."winningNumber"
              )
              SELECT
                an.number,
                lw.last_won_date,
                EXTRACT(DAY FROM NOW() - COALESCE(lw.last_won_date, '2000-01-01'::timestamp)) as days_since_last_win
              FROM all_numbers an
              LEFT JOIN last_wins lw ON an.number = lw.number
              ORDER BY days_since_last_win DESC
              LIMIT 10
            `;

            const coldNumbersRaw = await prisma.$queryRaw<Array<{
              number: string;
              last_won_date: Date | null;
              days_since_last_win: number;
            }>>(coldNumbersQuery);

            coldNumbers = coldNumbersRaw.map(c => ({
              number: c.number,
              daysSinceLastWin: parseInt(c.days_since_last_win?.toString() || '0'),
              lastWonDate: c.last_won_date ? formatDateOnly(c.last_won_date) : null,
            }));
          }

          // Enriquecer finalNumbersRaw con ganadores/exposición
          const winnerDataMap = new Map<string, { timesWon: number; lastWonDate: string | null }>();
          hotNumbers.forEach(h => {
            winnerDataMap.set(h.number, { timesWon: h.timesWon, lastWonDate: h.lastWonDate });
          });

          const exposureMap = new Map(numbersWithExposure.map(n => [n.number, n.exposure]));

          const numbersData = finalNumbersRaw.map((n) => ({
            number: n.number,
            totalAmount: n.totalAmount,
            ticketsCount: n.ticketsCount,
            jugadasCount: n.jugadasCount,
            avgAmount: n.avgAmount,
            rank: n.rank,
            // Campos adicionales si se solicitan
            ...(filters.includeExposure && {
              exposure: exposureMap.get(n.number) || 0,
            }),
            ...(filters.includeWinners && {
              timesWon: winnerDataMap.get(n.number)?.timesWon || 0,
              lastWonDate: winnerDataMap.get(n.number)?.lastWonDate || null,
            }),
          }));

          const topNumber = numbersData[0] || null;

          let previousPeriod: any = null;
          if (filters.includeComparison) {
            const previousRange = calculatePreviousPeriod(dateRange);
            // Opcional, reservado para comparativas
          }

          // DESGLOSES (breakdowns) híbridos según filtros
          const nbk = resolveBreakdowns(filters);

          let numBySorteo: any[] | undefined;
          if (nbk.includeSorteo) {
            const sorted = await getHybridBreakdown(
              'sorteoId',
              'Sorteo',
              dailySalesFilters,
              dateRange
            );
            numBySorteo = sorted.map(r => ({
              sorteoId: r.id,
              sorteoName: r.name,
              totalAmount: r.total_amount,
              ticketsCount: r.tickets_count,
            }));
          }

          let numByLoteria: any[] | undefined;
          if (nbk.includeLoteria) {
            const sorted = await getHybridBreakdown(
              'loteriaId',
              'Loteria',
              dailySalesFilters,
              dateRange
            );
            numByLoteria = sorted.map(r => ({
              loteriaId: r.id,
              loteriaName: r.name,
              totalAmount: r.total_amount,
              ticketsCount: r.tickets_count,
            }));
          }

          let numByVentana: any[] | undefined;
          if (nbk.includeVentana) {
            const sorted = await getHybridBreakdown(
              'ventanaId',
              'Ventana',
              dailySalesFilters,
              dateRange
            );
            numByVentana = sorted.map(r => ({
              ventanaId: r.id,
              ventanaName: r.name,
              totalAmount: r.total_amount,
              ticketsCount: r.tickets_count,
            }));
          }

          let numByVendedor: any[] | undefined;
          if (nbk.includeVendedor) {
            const sorted = await getHybridBreakdown(
              'vendedorId',
              'User',
              dailySalesFilters,
              dateRange
            );
            numByVendedor = sorted.map(r => ({
              vendedorId: r.id,
              vendedorName: r.name,
              totalAmount: r.total_amount,
              ticketsCount: r.tickets_count,
            }));
          }

          return {
            data: {
              currentPeriod: {
                from: dateRange.fromString,
                to: dateRange.toString,
                numbers: numbersData,
              },
              ...(previousPeriod && { previousPeriod }),
              ...(filters.includeWinners && { hotNumbers, coldNumbers }),
              summary: {
                totalNumbersPlayed: summary.totalNumbersPlayed,
                totalAmount: summary.totalAmount,
                totalTickets: summary.totalTickets,
                topNumber: topNumber?.number || null,
                topNumberAmount: topNumber?.totalAmount || 0,
                ...(filters.includeExposure && {
                  totalExposure,
                  highRiskNumbers,
                }),
              },
              ...(numBySorteo && { bySorteo: numBySorteo }),
              ...(numByLoteria && { byLoteria: numByLoteria }),
              ...(numByVentana && { byVentana: numByVentana }),
              ...(numByVendedor && { byVendedor: numByVendedor }),
            },
            meta: {
              dateRange: {
                from: dateRange.fromString,
                to: dateRange.toString,
              },
              comparisonEnabled: filters.includeComparison || false,
            },
          };
        }, { context: 'ticketsReport.getNumbersAnalysis' });
      },
      ttl,
      ['reports', 'dashboard'],
      true,
      5_000
    );
  },

  /**
   * Detalle desglosado de un número (Drill-down)
   * GET /api/v1/reports/tickets/numbers-analysis/detail
   */
  async getNumbersAnalysisDetail(filters: NumbersAnalysisDetailFilters): Promise<any> {
    const dateRange = resolveDateRange(
      filters.date || 'today',
      filters.fromDate,
      filters.toDate
    );

    return withConnectionRetry(async () => {
      // 1. Obtener información de la lotería
      const loteria = await prisma.loteria.findUnique({
        where: { id: filters.loteriaId },
        select: { id: true, name: true },
      });

      if (!loteria) {
        throw new AppError('Lotería no encontrada', 404);
      }

      // 2. Query optimizada para el desglose
      const detailQuery = Prisma.sql`
        WITH filtered_jugadas AS (
          SELECT
            t."sorteoId",
            s.name as sorteo_name,
            t."vendedorId",
            u.name as vendedor_name,
            j.amount,
            j."ticketId"
          FROM "Jugada" j
          INNER JOIN "Ticket" t ON j."ticketId" = t.id
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "User" u ON t."vendedorId" = u.id
          WHERE t."loteriaId" = CAST(${filters.loteriaId} AS uuid)
            AND j.number = ${filters.number}
            AND t."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
            AND t."status"::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
            AND t."isActive" = true
            AND t."deletedAt" IS NULL
            AND j."deletedAt" IS NULL
            AND j."isExcluded" = false
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
            ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
            ${filters.betType && filters.betType !== 'all' ? Prisma.sql`AND j.type = ${filters.betType}::"BetType"` : Prisma.empty}
        ),
        sorteo_agg AS (
          SELECT
            "sorteoId",
            sorteo_name,
            SUM(amount) as total_amount,
            COUNT(DISTINCT "ticketId") as tickets_count,
            COUNT(*) as jugadas_count
          FROM filtered_jugadas
          GROUP BY "sorteoId", sorteo_name
        ),
        vendedor_agg AS (
          SELECT
            "sorteoId",
            "vendedorId",
            vendedor_name,
            SUM(amount) as total_amount,
            COUNT(DISTINCT "ticketId") as tickets_count
          FROM filtered_jugadas
          GROUP BY "sorteoId", "vendedorId", vendedor_name
        )
        SELECT
          sa.*,
          COALESCE(
            json_agg(
              json_build_object(
                'vendedorId', va."vendedorId",
                'vendedorName', va.vendedor_name,
                'totalAmount', va.total_amount,
                'ticketsCount', va.tickets_count
              ) ORDER BY va.total_amount DESC
            ) FILTER (WHERE va."vendedorId" IS NOT NULL),
            '[]'::json
          ) as by_vendedor
        FROM sorteo_agg sa
        LEFT JOIN vendedor_agg va ON sa."sorteoId" = va."sorteoId"
        GROUP BY sa."sorteoId", sa.sorteo_name, sa.total_amount, sa.tickets_count, sa.jugadas_count
        ORDER BY sa.total_amount DESC
      `;

      const rawResults = await prisma.$queryRaw<any[]>(detailQuery);

      // 3. Formatear resultados
      let totalAmount = 0;
      let totalTicketsCount = 0;
      let totalJugadasCount = 0;

      const bySorteo = rawResults.map(row => {
        const sorteoAmount = Number(row.total_amount);
        const sorteoTickets = Number(row.tickets_count);
        const sorteoJugadas = Number(row.jugadas_count);

        totalAmount += sorteoAmount;
        totalTicketsCount += sorteoTickets;
        totalJugadasCount += sorteoJugadas;

        return {
          sorteoId: row.sorteoId,
          sorteoName: row.sorteo_name,
          totalAmount: sorteoAmount,
          ticketsCount: sorteoTickets,
          jugadasCount: sorteoJugadas,
          byVendedor: (row.by_vendedor || []).map((v: any) => ({
            vendedorId: v.vendedorId,
            vendedorName: v.vendedorName,
            totalAmount: Number(v.totalAmount),
            ticketsCount: Number(v.ticketsCount),
          })),
        };
      });

      return {
        data: {
          number: filters.number,
          loteriaId: loteria.id,
          loteriaName: loteria.name,
          summary: {
            totalAmount,
            ticketsCount: totalTicketsCount,
            jugadasCount: totalJugadasCount,
          },
          bySorteo,
        },
        meta: {
          dateRange: {
            from: formatDateOnly(dateRange.from),
            to: formatDateOnly(dateRange.to),
          },
        },
      };
    }, { context: 'ticketsReport.getNumbersAnalysisDetail' });
  },
};
