/**
 * @deprecated Usar `tz` de './timezone' directamente.
 *
 * Este archivo se mantiene solo por compatibilidad con importaciones existentes.
 * Toda la lógica real está en `src/utils/timezone.ts`.
 */
import { tz } from './timezone';

export const CR_TIMEZONE_OFFSET_HOURS = 6;
export const CR_TIMEZONE_OFFSET_MS = CR_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
/** @deprecated */ export const CR_DATE_OFFSET_HOURS = CR_TIMEZONE_OFFSET_HOURS;
/** @deprecated */ export const CR_DATE_OFFSET_MS = CR_TIMEZONE_OFFSET_MS;

export function dateUTCToCRString(dateUTC: Date): string {
  return tz.toDateStr(dateUTC);
}

export function postgresDateToCRString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dateRangeUTCToCRStrings(startDate: Date, endDate: Date) {
  return {
    startDateCRStr: tz.toDateStr(startDate),
    endDateCRStr: tz.toDateStr(endDate),
  };
}

export function isDateInCRRange(dateStr: string, startDateCRStr: string, endDateCRStr: string): boolean {
  return dateStr >= startDateCRStr && dateStr <= endDateCRStr;
}

export function subtractDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d - days, 12));
  return tz.toDateStr(target);
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + days, 12));
  return tz.toDateStr(target);
}

export function getTodayCRString(): string {
  return tz.toDateStr();
}

export const crDateService = {
  dateUTCToCRString,
  postgresDateToCRString,
  dateRangeUTCToCRStrings,
  isDateInCRRange,
  getTodayCRString,
  getStartOfToday: () => tz.startOfDay(new Date()),
  subtractDays,
  addDays,
  CR_TIMEZONE_OFFSET_HOURS,
  CR_TIMEZONE_OFFSET_MS,
};
