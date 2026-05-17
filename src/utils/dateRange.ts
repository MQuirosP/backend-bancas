/**
 * Utilidades de rango de fechas — delegan a src/utils/timezone.ts
 *
 * ✅ API pública intacta. Internamente sin aritmética manual de offsets.
 */

import { AppError } from '../core/errors';
import { tz } from './timezone';

export interface DateRangeResolution {
  fromAt: Date;
  toAt: Date;
  fromBusinessDate: Date;
  toBusinessDate: Date;
  tz: string;
  description: string;
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function getTodayStr(serverNow: Date = new Date()): string {
  return tz.toDateStr(serverNow);
}

function dateStrToUtcRange(dateStr: string): { fromAt: Date; toAt: Date; fromBusinessDate: Date; toBusinessDate: Date } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const fromAt = tz.startOfDay(new Date(Date.UTC(y, m - 1, d, 12)));
  // Asegurar que fromAt corresponde exactamente al inicio del día
  const fromAtCorrect = tz.startOfDay(fromAt);
  const toAt = tz.endOfDay(fromAt);
  const fromBusinessDate = new Date(Date.UTC(y, m - 1, d));
  return { fromAt: fromAtCorrect, toAt, fromBusinessDate, toBusinessDate: fromBusinessDate };
}

function dateRangeStrToUtcRange(fromDateStr: string, toDateStr: string): {
  fromAt: Date; toAt: Date; fromBusinessDate: Date; toBusinessDate: Date;
} {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const fromAt = tz.startOfDay(new Date(Date.UTC(fy, fm - 1, fd, 12)));
  const toAt = tz.endOfDay(new Date(Date.UTC(ty, tm - 1, td, 12)));
  const fromBusinessDate = new Date(Date.UTC(fy, fm - 1, fd));
  const toBusinessDate = new Date(Date.UTC(ty, tm - 1, td));
  return { fromAt, toAt, fromBusinessDate, toBusinessDate };
}

function isValidDateFormat(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [year, month, date] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || date < 1 || date > 31) return false;
  const d = new Date(year, month - 1, date);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === date;
}

function getWeekRange(serverNow: Date): { fromDateStr: string; toDateStr: string } {
  const todayStr = getTodayStr(serverNow);
  const [y, m, d] = todayStr.split('-').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12));
  // Día de semana en TZ del negocio
  const dow = tz.dayOfWeek(ref);
  const daysToMonday = dow === 0 ? 6 : dow - 1;
  const monday = tz.addDays(ref, -daysToMonday);
  const sunday = tz.addDays(monday, 6);
  return { fromDateStr: tz.toDateStr(monday), toDateStr: tz.toDateStr(sunday) };
}

function getMonthRange(serverNow: Date): { fromDateStr: string; toDateStr: string } {
  const todayStr = getTodayStr(serverNow);
  const [y, m] = todayStr.split('-').map(Number);
  const firstDay = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDayDate = new Date(y, m, 0); // último día del mes
  const lastDay = `${y}-${String(m).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;
  return { fromDateStr: firstDay, toDateStr: lastDay };
}

function getYearRange(serverNow: Date): { fromDateStr: string; toDateStr: string } {
  const todayStr = getTodayStr(serverNow);
  const y = todayStr.split('-')[0];
  return { fromDateStr: `${y}-01-01`, toDateStr: `${y}-12-31` };
}

// ─── API Pública ──────────────────────────────────────────────────────────────

export function resolveDateRange(
  date: string = 'today',
  fromDate?: string,
  toDate?: string,
  serverNow: Date = new Date()
): DateRangeResolution {
  if ((fromDate || toDate) && date !== 'range') {
    throw new AppError('date must be "range" when fromDate or toDate are provided', 400, { code: 'SLS_2001' });
  }

  const validDates = ['today', 'yesterday', 'week', 'month', 'year', 'range'];
  if (!validDates.includes(date)) {
    throw new AppError('Invalid date parameter', 400, { code: 'SLS_2001' });
  }

  const todayStr = getTodayStr(serverNow);
  let fromDateStr: string;
  let toDateStr: string;
  let description: string;

  if (date === 'today') {
    fromDateStr = toDateStr = todayStr;
    description = `Today (${todayStr}) in ${tz.name}`;
  } else if (date === 'yesterday') {
    const yest = tz.addDays(new Date(), -1);
    fromDateStr = toDateStr = tz.toDateStr(yest);
    description = `Yesterday (${fromDateStr}) in ${tz.name}`;
  } else if (date === 'week') {
    const { fromDateStr: f, toDateStr: t } = getWeekRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This week (${f} to ${t}) in ${tz.name}`;
  } else if (date === 'month') {
    const { fromDateStr: f, toDateStr: t } = getMonthRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This month (${f} to ${t}) in ${tz.name}`;
  } else if (date === 'year') {
    const { fromDateStr: f, toDateStr: t } = getYearRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This year (${f} to ${t}) in ${tz.name}`;
  } else {
    // range
    if (!fromDate || !toDate) throw new AppError('fromDate and toDate required for date=range', 400, { code: 'SLS_2001' });
    if (!isValidDateFormat(fromDate)) throw new AppError('Invalid fromDate format', 400, { code: 'SLS_2001' });
    if (!isValidDateFormat(toDate)) throw new AppError('Invalid toDate format', 400, { code: 'SLS_2001' });
    if (fromDate > toDate) throw new AppError('fromDate must be ≤ toDate', 400, { code: 'SLS_2001' });
    if (toDate > todayStr) throw new AppError('toDate cannot be in the future', 400, { code: 'SLS_2001' });
    fromDateStr = fromDate; toDateStr = toDate;
    description = `Range ${fromDate} to ${toDate} in ${tz.name}`;
  }

  const { fromAt, toAt, fromBusinessDate, toBusinessDate } = dateRangeStrToUtcRange(fromDateStr, toDateStr);
  return { fromAt, toAt, fromBusinessDate, toBusinessDate, tz: tz.name, description };
}

export function resolveDateRangeAllowFuture(
  date: string = 'today',
  fromDate?: string,
  toDate?: string,
  serverNow: Date = new Date()
): DateRangeResolution {
  const validDates = ['today', 'yesterday', 'week', 'month', 'year', 'range'];
  if (!validDates.includes(date)) {
    throw new AppError('Invalid date parameter', 400, { code: 'SLS_2001' });
  }

  const todayStr = getTodayStr(serverNow);
  let fromDateStr: string;
  let toDateStr: string;
  let description: string;

  if (date === 'today') {
    fromDateStr = toDateStr = todayStr;
    description = `Today (${todayStr}) in ${tz.name}`;
  } else if (date === 'yesterday') {
    const yest = tz.addDays(new Date(), -1);
    fromDateStr = toDateStr = tz.toDateStr(yest);
    description = `Yesterday (${fromDateStr}) in ${tz.name}`;
  } else if (date === 'week') {
    const { fromDateStr: f, toDateStr: t } = getWeekRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This week (${f} to ${t}) in ${tz.name}`;
  } else if (date === 'month') {
    const { fromDateStr: f, toDateStr: t } = getMonthRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This month (${f} to ${t}) in ${tz.name}`;
  } else if (date === 'year') {
    const { fromDateStr: f, toDateStr: t } = getYearRange(serverNow);
    fromDateStr = f; toDateStr = t;
    description = `This year (${f} to ${t}) in ${tz.name}`;
  } else {
    if (!fromDate || !toDate) throw new AppError('fromDate and toDate required for date=range', 400, { code: 'SLS_2001' });
    if (!isValidDateFormat(fromDate)) throw new AppError('Invalid fromDate format', 400, { code: 'SLS_2001' });
    if (!isValidDateFormat(toDate)) throw new AppError('Invalid toDate format', 400, { code: 'SLS_2001' });
    if (fromDate > toDate) throw new AppError('fromDate must be ≤ toDate', 400, { code: 'SLS_2001' });
    fromDateStr = fromDate; toDateStr = toDate;
    description = `Range ${fromDate} to ${toDate} in ${tz.name} (future allowed)`;
  }

  const { fromAt, toAt, fromBusinessDate, toBusinessDate } = dateRangeStrToUtcRange(fromDateStr, toDateStr);
  return { fromAt, toAt, fromBusinessDate, toBusinessDate, tz: tz.name, description };
}

export function validateTimeseriesRange(fromAt: Date, toAt: Date, granularity: 'hour' | 'day' | 'week' = 'day'): void {
  const diffDays = (toAt.getTime() - fromAt.getTime()) / (1000 * 60 * 60 * 24);
  if (granularity === 'hour' && diffDays > 30) {
    throw new AppError('Range exceeds 30 days for hour granularity', 400, { code: 'SLS_2001' });
  }
  if (granularity === 'day' && diffDays > 90) {
    throw new AppError('Range exceeds 90 days for day granularity', 400, { code: 'SLS_2001' });
  }
}
