/**
 * Helpers comunes para la generación de reportes
 */

import { Prisma } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { DateRange } from '../../../api/v1/types/reports.types';
import { formatIsoLocal } from '../../../utils/datetime';

/**
 * Helper para formatear solo fecha YYYY-MM-DD
 */
export const formatDateOnly = (date: Date): string => formatIsoLocal(date).split('T')[0];

/**
 * Determina qué desgloses incluir según los filtros aplicados.
 * Regla:
 *  - byLoteria:  cuando NO hay loteriaId
 *  - bySorteo:   cuando SÍ hay loteriaId
 *  - byVentana:  cuando NO hay ventanaId Y NO hay vendedorId
 *  - byVendedor: cuando NO hay vendedorId Y SÍ hay ventanaId
 */
export function resolveBreakdowns(filters: { loteriaId?: string; ventanaId?: string; vendedorId?: string }) {
  const hasLoteria = !!(filters.loteriaId && filters.loteriaId.trim() !== '');
  const hasVentana = !!(filters.ventanaId && filters.ventanaId.trim() !== '');
  const hasVendedor = !!(filters.vendedorId && filters.vendedorId.trim() !== '');

  return {
    includeLoteria: !hasLoteria,
    includeSorteo: hasLoteria,
    includeVentana: !hasVentana && !hasVendedor,
    includeVendedor: !hasVendedor && hasVentana,
  };
}

export async function getHybridBreakdown(
  groupByField: 'sorteoId' | 'loteriaId' | 'ventanaId' | 'vendedorId',
  entityTable: 'Sorteo' | 'Loteria' | 'Ventana' | 'User',
  dailySalesFilters: Prisma.Sql,
  dateRange: DateRange
): Promise<any[]> {
  const q = Prisma.sql`
    SELECT
      db."${Prisma.raw(groupByField)}" as id,
      e.name as name,
      SUM(db."totalAmount")::double precision as total_amount,
      SUM(db."ticketsCount")::integer as tickets_count
    FROM "DailyNumberSales" db
    INNER JOIN "${Prisma.raw(entityTable)}" e ON db."${Prisma.raw(groupByField)}" = e.id
    WHERE db."businessDate" BETWEEN ${dateRange.fromString}::date AND ${dateRange.toString}::date
      ${dailySalesFilters}
    GROUP BY db."${Prisma.raw(groupByField)}", e.name
    ORDER BY total_amount DESC
  `;
  return await prisma.$queryRaw<any[]>(q);
}
