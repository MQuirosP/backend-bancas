/**
 * Utilidades para el módulo de reportes
 */

import { DateToken, DateRange } from '../types/reports.types';
import { tz } from '../../../utils/timezone';
import { getCRLocalComponents } from '../../../utils/businessDate';

/**
 * Resuelve un token de fecha a un rango de fechas en hora de Costa Rica
 */
export function resolveDateRange(
  date: DateToken,
  fromDate?: string,
  toDate?: string
): DateRange {
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (date) {
    case 'today':
      start = tz.startOfDay(now);
      end = tz.endOfDay(now);
      break;

    case 'yesterday': {
      const yesterday = tz.addDays(now, -1);
      start = tz.startOfDay(yesterday);
      end = tz.endOfDay(yesterday);
      break;
    }

    case 'week': {
      // Semana: lunes → domingo completo (ISO, decisión 2026-07-22)
      const todayStr = tz.toDateStr(now);
      const [y, m, d] = todayStr.split('-').map(Number);
      const ref = new Date(Date.UTC(y, m - 1, d, 12));
      const dow = tz.dayOfWeek(ref); // 0=Dom, 1=Lun ... 6=Sáb
      const daysToMonday = dow === 0 ? 6 : dow - 1;
      const monday = tz.addDays(ref, -daysToMonday);
      const sunday = tz.addDays(monday, 6);
      start = tz.startOfDay(monday);
      end = tz.endOfDay(sunday);
      break;
    }

    case 'month': {
      // Mes: inicio-de-mes → hoy (no futuro en cero, decisión 2026-07-22)
      const todayStr = tz.toDateStr(now);
      const [y, m] = todayStr.split('-').map(Number);
      const firstDayStr = `${y}-${String(m).padStart(2, '0')}-01`;
      start = tz.startOfDay(tz.parse(firstDayStr));
      end = tz.endOfDay(now);
      break;
    }

    case 'year':
      start = tz.startOfDay(tz.addDays(now, -364));
      end = tz.endOfDay(now);
      break;

    case 'range':
      if (!fromDate || !toDate) {
        throw new Error('fromDate y toDate son requeridos cuando date=range');
      }
      start = tz.startOfDay(tz.parse(fromDate));
      end = tz.endOfDay(tz.parse(toDate));
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
    from: tz.startOfDay(previousStart),
    to: tz.endOfDay(previousEnd),
    fromString: formatDateOnly(tz.startOfDay(previousStart)),
    toString: formatDateOnly(tz.endOfDay(previousEnd)),
  };
}

/**
 * Formatea una fecha a YYYY-MM-DD
 */
function formatDateOnly(date: Date): string {
  const { year, month, day } = getCRLocalComponents(date);
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  return `${year}-${monthStr}-${dayStr}`;
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

