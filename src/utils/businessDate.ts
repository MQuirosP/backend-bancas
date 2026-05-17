/**
 * Business date utilities — delegan a src/utils/timezone.ts
 *
 * ✅ API pública intacta. Sin CR_TZ_OFFSET_MS manual.
 */

import { tz } from './timezone';

type GetBusinessDateArgs = {
  scheduledAt?: Date | null;
  nowUtc: Date;
  cutoffHour: string; // 'HH:mm' 24h
};

function parseCutoff(hhmm: string): { h: number; m: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid cutoffHour format: ${hhmm}`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Extrae componentes locales en TZ del negocio de un instante UTC */
export function getCRLocalComponents(dateUtc: Date): {
  year: number; month: number; day: number; dow: number; hour: number; minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.name,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = formatter.formatToParts(dateUtc);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: parseInt(get('year')),
    month: parseInt(get('month')),
    day: parseInt(get('day')),
    dow: days.indexOf(get('weekday')),
    hour: parseInt(get('hour')),
    minute: parseInt(get('minute')),
  };
}

export function getBusinessDateCRInfo(args: GetBusinessDateArgs): {
  prefixYYMMDD: string;
  businessDate: Date;
  businessDateISO: string;
  source: 'sorteo' | 'cutoff';
} {
  const { scheduledAt, nowUtc, cutoffHour } = args;

  if (scheduledAt) {
    const dateStr = tz.toDateStr(scheduledAt);
    const [y, m, d] = dateStr.split('-').map(Number);
    const yy = pad2(y % 100);
    const mm = pad2(m);
    const dd = pad2(d);
    return {
      prefixYYMMDD: `${yy}${mm}${dd}`,
      businessDate: new Date(Date.UTC(y, m - 1, d)),
      businessDateISO: `${y}-${mm}-${dd}`,
      source: 'sorteo',
    };
  }

  const { h: cutH, m: cutM } = parseCutoff(cutoffHour);
  const { year, month, day, hour, minute } = getCRLocalComponents(nowUtc);
  const beforeCutoff = hour < cutH || (hour === cutH && minute < cutM);

  let fy = year, fm = month, fd = day;
  if (beforeCutoff) {
    const prevDay = tz.addDays(new Date(Date.UTC(year, month - 1, day, 12)), -1);
    const prevStr = tz.toDateStr(prevDay);
    [fy, fm, fd] = prevStr.split('-').map(Number);
  }

  const yy = pad2(fy % 100);
  const mm = pad2(fm);
  const dd = pad2(fd);
  return {
    prefixYYMMDD: `${yy}${mm}${dd}`,
    businessDate: new Date(Date.UTC(fy, fm - 1, fd)),
    businessDateISO: `${fy}-${mm}-${dd}`,
    source: 'cutoff',
  };
}

export function getBusinessDateCR(args: GetBusinessDateArgs): string {
  return getBusinessDateCRInfo(args).prefixYYMMDD;
}

/** Rango UTC del día calendario de negocio que contiene `nowUtc` */
export function getCRDayRangeUTC(nowUtc: Date): { fromAt: Date; toAtExclusive: Date; isoDate: string } {
  const dateStr = tz.toDateStr(nowUtc);
  const fromAt = tz.startOfDay(nowUtc);
  const toAtExclusive = tz.addDays(fromAt, 1);
  return { fromAt, toAtExclusive, isoDate: dateStr };
}
