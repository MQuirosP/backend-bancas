/**
 * Utilidades para el módulo de reportes
 */

import { DateToken, DateRange } from '../types/reports.types';
import { startOfLocalDay, addLocalDays, endOfLocalDay, nowCR } from '../../../utils/datetime';

/**
 * Resuelve un token de fecha a un rango de fechas en hora de Costa Rica
 */
export function resolveDateRange(
  date: DateToken,
  fromDate?: string,
  toDate?: string
): DateRange {
  const now = nowCR();
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
      const startOfToday = startOfLocalDay(now);
      // startOfLocalDay ya nos da un Date en UTC que representa las 00:00 CR
      // shiftToCostaRica en datetime.ts es el que maneja el offset.
      // Pero para obtener el día de la semana en CR, necesitamos ver el Date "movido"
      // datetime.ts usa shiftToCostaRica internamente en startOfLocalDay
      
      const dayOfWeek = getCostaRicaDayOfWeek(now);
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      start = startOfLocalDay(addLocalDays(now, -daysToMonday));
      end = endOfLocalDay(now);
      break;
    }

    case 'month': {
      start = startOfLocalMonth(now);
      end = endOfLocalDay(now);
      break;
    }

    case 'year':
      start = startOfLocalDay(addLocalDays(now, -364));
      end = endOfLocalDay(now);
      break;

    case 'range':
      if (!fromDate || !toDate) {
        throw new Error('fromDate y toDate son requeridos cuando date=range');
      }
      start = startOfLocalDay(fromDate);
      end = endOfLocalDay(toDate);
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
 * Helpers internos para manejar la lógica de CR sin duplicar desplazamientos
 */

function getCostaRicaDayOfWeek(date: Date): number {
  // Obtenemos el día de la semana interpretando el Date en CR
  const CR_OFFSET = -6;
  const crDate = new Date(date.getTime() + CR_OFFSET * 60 * 60 * 1000);
  return crDate.getUTCDay();
}

function startOfLocalMonth(date: Date): Date {
  const CR_OFFSET = -6;
  const crDate = new Date(date.getTime() + CR_OFFSET * 60 * 60 * 1000);
  const year = crDate.getUTCFullYear();
  const month = crDate.getUTCMonth();
  
  // Crear el primer día del mes en UTC y "des-desplazarlo" para obtener el Date real que representa las 00:00 CR
  const startOfMonthCR = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return new Date(startOfMonthCR.getTime() - CR_OFFSET * 60 * 60 * 1000);
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

