/**
 * Handler de reportes para Exposición y Riesgo por Número
 */

import { Prisma, TicketStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { AppError } from '../../../core/errors';
import { formatIsoLocal } from '../../../utils/datetime';

export interface ExposureFilters {
  sorteoId: string;
  loteriaId?: string;
  top?: number;
  minExposure?: number;
  bancaId?: string;
}

export const ExposureReportHandler = {
  /**
   * Reporte de exposición y riesgo por número
   * CRÍTICO: Para gestión de riesgo financiero
   */
  async getExposure(filters: ExposureFilters): Promise<any> {
    // Obtener información del sorteo
    const sorteo = await prisma.sorteo.findUnique({
      where: { id: filters.sorteoId },
      include: {
        loteria: { select: { id: true, name: true } },
      },
    });

    if (!sorteo) {
      throw new AppError('Sorteo no encontrado', 404);
    }

    const top = filters.top || 20;
    const DEFAULT_MULTIPLIER = 30;

    // Query para obtener exposición por número (consolidado, sin duplicados)
    const numbersQuery = Prisma.sql`
      SELECT
        j.number,
        SUM(j.amount) as total_amount,
        COUNT(DISTINCT j."ticketId") as tickets_count,
        COUNT(*) as jugadas_count,
        COALESCE(AVG(j."finalMultiplierX"), ${DEFAULT_MULTIPLIER}) as avg_multiplier
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
        AND t."status"::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
        AND t."isActive" = true
        AND t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND j."isActive" = true
        AND j."isExcluded" = false
        ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
        ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
      GROUP BY j.number
      ORDER BY total_amount DESC
    `;

    const numbersRaw = await prisma.$queryRaw<Array<{
      number: string;
      total_amount: number;
      tickets_count: bigint;
      jugadas_count: bigint;
      avg_multiplier: number;
    }>>(numbersQuery);

    // Calcular totales
    const totalVentas = numbersRaw.reduce((sum, n) => sum + parseFloat(n.total_amount.toString()), 0);
    let totalExposure = 0;
    let highRiskNumbers = 0;

    // Procesar números y calcular exposición
    const numbersData = numbersRaw.map(n => {
      const totalAmount = parseFloat(n.total_amount.toString());
      const multiplier = parseFloat(n.avg_multiplier?.toString() || DEFAULT_MULTIPLIER.toString());
      const exposure = totalAmount * multiplier;
      totalExposure += exposure;

      // Determinar nivel de riesgo basado en concentración
      const percentOfTotal = totalVentas > 0 ? (totalAmount / totalVentas) * 100 : 0;
      let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
      if (percentOfTotal > 15) {
        riskLevel = 'critical';
        highRiskNumbers++;
      } else if (percentOfTotal > 10) {
        riskLevel = 'high';
        highRiskNumbers++;
      } else if (percentOfTotal > 5) {
        riskLevel = 'medium';
      }

      return {
        number: n.number,
        totalAmount,
        ticketsCount: parseInt(n.tickets_count.toString()),
        jugadasCount: parseInt(n.jugadas_count.toString()),
        exposure,
        multiplier: parseFloat(multiplier.toFixed(2)),
        percentOfTotal: parseFloat(percentOfTotal.toFixed(2)),
        riskLevel,
      };
    });

    // Filtrar por exposición mínima si se especifica
    let filteredNumbers = numbersData;
    if (filters.minExposure) {
      filteredNumbers = numbersData.filter(n => n.exposure >= filters.minExposure!);
    }

    // Limitar al top solicitado
    const topNumbers = filteredNumbers.slice(0, top);

    // Generar alertas
    const alerts: Array<{
      type: string;
      number: string;
      message: string;
      severity: 'info' | 'warning' | 'critical';
    }> = [];

    numbersData.forEach(n => {
      if (n.percentOfTotal > 10) {
        alerts.push({
          type: 'HIGH_CONCENTRATION',
          number: n.number,
          message: `El número ${n.number} tiene el ${n.percentOfTotal.toFixed(1)}% de las ventas totales`,
          severity: n.percentOfTotal > 15 ? 'critical' : 'warning',
        });
      }
    });

    // Agrupación por ventana con ventana-functions para obtener el top number en una sola query
    const byVentanaQuery = Prisma.sql`
      WITH number_exposure AS (
        SELECT
          t."sorteoId",
          t."ventanaId",
          j.number,
          SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER}))::float as exposure
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
          AND t."status"::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."isExcluded" = false
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND t."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY t."sorteoId", t."ventanaId", j.number
      ),
      top_numbers AS (
        SELECT
          *,
          ROW_NUMBER() OVER(PARTITION BY "sorteoId", "ventanaId" ORDER BY exposure DESC) as rnk
        FROM number_exposure
      ),
      ventana_totals AS (
        SELECT
          t."ventanaId",
          v.name as ventana_name,
          SUM(j.amount)::float as total_amount,
          SUM(j.amount * COALESCE(j."finalMultiplierX", ${DEFAULT_MULTIPLIER}))::float as exposure
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE t."sorteoId" = CAST(${filters.sorteoId} AS uuid)
          AND t."status"::text IN (${TicketStatus.ACTIVE}, ${TicketStatus.EVALUATED}, ${TicketStatus.PAID}, ${TicketStatus.PAGADO})
          AND t."isActive" = true
          AND t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          AND j."isActive" = true
          AND j."isExcluded" = false
          ${filters.bancaId && filters.bancaId.trim() !== '' ? Prisma.sql`AND v."bancaId" = CAST(${filters.bancaId} AS uuid)` : Prisma.empty}
        GROUP BY t."ventanaId", v.name
      )
      SELECT
        vt.*,
        tn.number as top_number,
        COALESCE(tn.exposure, 0) as top_number_exposure
      FROM ventana_totals vt
      LEFT JOIN top_numbers tn ON vt."ventanaId" = tn."ventanaId" AND tn.rnk = 1
      ORDER BY vt.exposure DESC
    `;

    const byVentanaRaw = await prisma.$queryRaw<Array<{
      ventanaId: string;
      ventana_name: string;
      total_amount: number;
      exposure: number;
      top_number: string | null;
      top_number_exposure: number;
    }>>(byVentanaQuery);

    const byVentana = byVentanaRaw.map(v => ({
      ventanaId: v.ventanaId,
      ventanaName: v.ventana_name,
      ventas: v.total_amount,
      exposure: v.exposure,
      topNumber: v.top_number,
      topNumberExposure: v.top_number_exposure,
    }));

    return {
      data: {
        sorteo: {
          id: sorteo.id,
          name: sorteo.name,
          loteriaId: sorteo.loteriaId,
          loteriaName: sorteo.loteria.name,
          scheduledAt: formatIsoLocal(sorteo.scheduledAt),
          status: sorteo.status,
        },
        summary: {
          totalVentas,
          totalExposure,
          maxPotentialPayout: totalExposure,
          highRiskNumbers,
          averageExposurePerNumber: numbersData.length > 0 ? totalExposure / numbersData.length : 0,
        },
        numbers: topNumbers,
        alerts,
        byVentana,
      },
      meta: {
        generatedAt: new Date().toISOString(),
      },
    };
  },
};
