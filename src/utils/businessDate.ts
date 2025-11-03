/**
 * Business date utilities for Costa Rica timezone (America/Costa_Rica, UTC-6, no DST).
 *
 * Rules:
 * - Prefer the Sorteo.scheduledAt local calendar day in CR when provided.
 * - Fallback to a business-day cutoff hour (HH:mm) over nowUtc in CR.
 * - Returns prefix YYMMDD and a Date (UTC midnight) representing the business calendar day.
 */

type GetBusinessDateArgs = {
  scheduledAt?: Date | null;
  nowUtc: Date; // server current time in UTC
  cutoffHour: string; // 'HH:mm' in 24h (e.g., '06:00')
};

const CR_TZ_OFFSET_MS = -6 * 60 * 60 * 1000; // UTC-6, no DST in CR

function parseCutoff(hhmm: string): { h: number; m: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid cutoffHour format: ${hhmm}`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

function getCRYMDFromUtc(instantUtc: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const ms = instantUtc.getTime() + CR_TZ_OFFSET_MS;
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Returns { prefixYYMMDD, businessDate, businessDateISO, source }
 * - prefixYYMMDD: string 'YYMMDD'
 * - businessDate: Date at UTC midnight of the business calendar day
 * - businessDateISO: 'YYYY-MM-DD'
 * - source: 'sorteo' | 'cutoff'
 */
export function getBusinessDateCRInfo(args: GetBusinessDateArgs): {
  prefixYYMMDD: string;
  businessDate: Date;
  businessDateISO: string;
  source: 'sorteo' | 'cutoff';
} {
  const { scheduledAt, nowUtc, cutoffHour } = args;

  // If scheduledAt provided, use its CR calendar day directly
  if (scheduledAt) {
    const ymd = getCRYMDFromUtc(scheduledAt);
    const yy = pad2(ymd.year % 100);
    const mm = pad2(ymd.month);
    const dd = pad2(ymd.day);
    const businessDate = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, 0, 0, 0, 0));
    return {
      prefixYYMMDD: `${yy}${mm}${dd}`,
      businessDate,
      businessDateISO: `${ymd.year}-${mm}-${dd}`,
      source: 'sorteo',
    };
  }

  // Fallback: cutoff by clock in CR against nowUtc
  const { h, m } = parseCutoff(cutoffHour);
  const ymdNow = getCRYMDFromUtc(nowUtc);

  // If current CR time is before cutoff, business date is the previous day
  let year = ymdNow.year;
  let month = ymdNow.month;
  let day = ymdNow.day;
  const beforeCutoff = ymdNow.hour < h || (ymdNow.hour === h && ymdNow.minute < m);
  if (beforeCutoff) {
    // subtract 1 day in CR
    const crMidnightUtc = Date.UTC(ymdNow.year, ymdNow.month - 1, ymdNow.day, 0, 0, 0, 0);
    const prevCrMidnightUtc = crMidnightUtc - 24 * 60 * 60 * 1000; // minus one day
    const ymdPrev = getCRYMDFromUtc(new Date(prevCrMidnightUtc - CR_TZ_OFFSET_MS));
    year = ymdPrev.year;
    month = ymdPrev.month;
    day = ymdPrev.day;
  }

  const yy = pad2(year % 100);
  const mm = pad2(month);
  const dd = pad2(day);
  const businessDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return {
    prefixYYMMDD: `${yy}${mm}${dd}`,
    businessDate,
    businessDateISO: `${year}-${mm}-${dd}`,
    source: 'cutoff',
  };
}

/** Convenience: returns just the YYMMDD prefix */
export function getBusinessDateCR(args: GetBusinessDateArgs): string {
  return getBusinessDateCRInfo(args).prefixYYMMDD;
}

/** Returns CR local components (year, month, day, dow, hour, minute) for a UTC instant */
export function getCRLocalComponents(dateUtc: Date): {
  year: number; month: number; day: number; dow: number; hour: number; minute: number;
} {
  const ms = dateUtc.getTime() + CR_TZ_OFFSET_MS;
  const d = new Date(ms);
  // Use UTC getters because we've shifted by the offset already
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Day range in UTC instants for the CR calendar day containing `nowUtc`. */
export function getCRDayRangeUTC(nowUtc: Date): { fromAt: Date; toAtExclusive: Date; isoDate: string } {
  const { year, month, day } = getCRLocalComponents(nowUtc);
  const fromAt = new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0)); // 00:00 CR = 06:00Z
  const toAtExclusive = new Date(Date.UTC(year, month - 1, day + 1, 6, 0, 0, 0));
  const mm = pad2(month);
  const dd = pad2(day);
  return { fromAt, toAtExclusive, isoDate: `${year}-${mm}-${dd}` };
}
