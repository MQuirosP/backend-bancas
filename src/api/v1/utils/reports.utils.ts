/**
 * Utilidades para el módulo de reportes
 */

import { DateToken, DateRange } from '../types/reports.types';
import { startOfLocalDay, addLocalDays, endOfLocalDay } from '../../../utils/datetime';

function nowInCostaRica(): Date {
  return new Date(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Costa_Rica',
    })
  );
}


/**
 * Resuelve un token de fecha a un rango de fechas en hora de Costa Rica
 */
export function resolveDateRange(
  date: DateToken,
  fromDate?: string,
  toDate?: string
): DateRange {
  const now = nowInCostaRica();
  let start: Date;
  let end: Date;

  switch (date) {
    case 'today':
      start = startOfLocalDay(now);
      end = endOfLocalDay(now);
      break;

    case 'yesterday': {
      const yesterday = addLocalDays(now, -1);
      start = startOfLocalDay(yesterday);
      end = endOfLocalDay(yesterday);
      break;
    }

    case 'week': {
      const dayOfWeek = now.getDay(); // 0 dom, 1 lun
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      start = startOfLocalDay(addLocalDays(now, -daysToMonday));
      end = endOfLocalDay(now);
      break;
    }

    case 'month': {
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');

      const fromString = `${year}-${month}-01`;
      const toString = formatDateOnly(now);

      return {
        from: new Date(`${fromString}T00:00:00-06:00`),
        to: new Date(`${toString}T23:59:59-06:00`),
        fromString,
        toString,
      };
    }


    case 'year':
      start = startOfLocalDay(addLocalDays(now, -364));
      end = endOfLocalDay(now);
      break;

    case 'range':
      if (!fromDate || !toDate) {
        throw new Error('fromDate y toDate son requeridos cuando date=range');
      }
      start = startOfLocalDay(
        new Date(`${fromDate}T00:00:00`)
      );
      end = endOfLocalDay(
        new Date(`${toDate}T23:59:59`)
      );
      break;

    default:
      throw new Error(`Token de fecha inválido: ${date}`);
  }

  return {
    from: start,
    to: end,
    fromString: formatDateOnly(start),
    toString: formatDateOnly(end),
  };
}

/**
 * Calcula el período anterior de igual duración
 */
export function calculatePreviousPeriod(range: DateRange): DateRange {
  const durationMs = range.to.getTime() - range.from.getTime();
  const previousEnd = new Date(range.from.getTime() - 1); // Un día antes del inicio
  const previousStart = new Date(previousEnd.getTime() - durationMs);

  return {
    from: startOfLocalDay(previousStart),
    to: endOfLocalDay(previousEnd),
    fromString: formatDateOnly(startOfLocalDay(previousStart)),
    toString: formatDateOnly(endOfLocalDay(previousEnd)),
  };
}

/**
 * Formatea una fecha a YYYY-MM-DD
 */
function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Calcula el porcentaje de cambio entre dos valores
 */
export function calculateChangePercent(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 100 : (current < 0 ? -100 : 0);
  }
  return parseFloat(((current - previous) / previous * 100).toFixed(2));
}

/**
 * Calcula el porcentaje con precisión de 2 decimales
 */
export function calculatePercentage(part: number, total: number): number {
  if (total === 0) return 0;
  return parseFloat((part / total * 100).toFixed(2));
}

/**
 * Valida y normaliza parámetros de paginación
 */
export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number; skip: number } {
  const normalizedPage = Math.max(1, page || 1);
  const normalizedPageSize = Math.min(100, Math.max(1, pageSize || 20));
  const skip = (normalizedPage - 1) * normalizedPageSize;

  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    skip,
  };
}

