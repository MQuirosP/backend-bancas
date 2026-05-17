/**
 * Utilidades de fecha — delegan a src/utils/timezone.ts
 *
 * ✅ API pública intacta: todos los imports existentes siguen funcionando.
 * La lógica interna ahora usa Intl nativo, sin aritmética +6/-6 manual.
 */

import { tz } from './timezone';
import { AppError } from '../core/errors';

// ─── Re-exports de timezone.ts ────────────────────────────────────────────────

export const COSTA_RICA_OFFSET_HOURS = -6;

/** Inicio del día en TZ del negocio, expresado en UTC */
export function startOfLocalDay(d: Date | string): Date {
  return tz.startOfDay(typeof d === 'string' ? new Date(d) : d);
}

/** Agrega N días manteniendo hora relativa en TZ del negocio */
export function addLocalDays(d: Date | string, days: number): Date {
  return tz.addDays(typeof d === 'string' ? new Date(d) : d, days);
}

/** Fin del día (23:59:59.999) en TZ del negocio */
export function endOfLocalDay(d: Date | string): Date {
  return tz.endOfDay(typeof d === 'string' ? new Date(d) : d);
}

/** Date actual — conservado por compatibilidad */
export function nowCR(): Date {
  return new Date();
}

// ─── Formateadores ────────────────────────────────────────────────────────────

/**
 * Formatea un Date como ISO string en la TZ del negocio, sin 'Z'.
 * Ejemplo: "2026-05-16T12:00:00.000" (en hora CR)
 */
export function formatIsoLocal(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz.name,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const [y, mo, d2, h, min, s] = [
    get('year'), get('month'), get('day'),
    get('hour'), get('minute'), get('second'),
  ];
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${y}-${mo}-${d2}T${h}:${min}:${s}.${ms}`;
}

/** Alias deprecated */
export const formatIsoUtc = formatIsoLocal;
export const formatDateCR = formatIsoLocal;
export function formatDateCRWithTZ(date: Date): string {
  return `${formatIsoLocal(date)}-06:00`;
}

// ─── atLocalTime ─────────────────────────────────────────────────────────────

/**
 * Construye un Date para la hora HH:mm en la TZ del negocio sobre una fecha base.
 * Ejemplo: atLocalTime("2026-05-16", "14:30") → Date que representa las 14:30 CR
 */
export function atLocalTime(baseDate: Date | string, hhmm: string): Date {
  const base = typeof baseDate === 'string' ? new Date(baseDate) : baseDate;
  const [hRaw, mRaw] = hhmm.split(':');
  const localHour = Number.parseInt(hRaw ?? '0', 10);
  const localMinute = Number.parseInt(mRaw ?? '0', 10);

  if (!isFinite(localHour) || !isFinite(localMinute)) {
    throw new Error(`Invalid time format: ${hhmm}`);
  }

  // Obtenemos el inicio del día base en UTC
  const dayStart = tz.startOfDay(base);
  // Sumamos las horas/minutos como si estuviéramos en TZ del negocio
  // El offset de ese instante nos da el ajuste correcto
  const testDate = new Date(dayStart.getTime() + localHour * 3600000 + localMinute * 60000);
  return testDate;
}

// ─── Parsing y validación ─────────────────────────────────────────────────────

export function toLocalDate(input: Date | string): Date {
  if (input instanceof Date) return new Date(input.getTime());
  return parseCostaRicaDateTime(input);
}

export function validateDate(date: Date | null | undefined, fieldName: string): Date {
  if (!date) throw new AppError(`${fieldName} es requerido`, 400, 'INVALID_DATE');
  if (!(date instanceof Date)) throw new AppError(`${fieldName} debe ser un Date`, 400, 'INVALID_DATE');
  if (isNaN(date.getTime())) throw new AppError(`${fieldName} tiene un valor de fecha inválido`, 400, 'INVALID_DATE');
  return date;
}

export function normalizeDateCR(
  input: Date | string | number | null | undefined,
  fieldName: string = 'date'
): Date {
  if (!input) throw new AppError(`${fieldName} es requerido`, 400, 'INVALID_DATE');
  let date: Date;
  if (input instanceof Date) date = input;
  else if (typeof input === 'number') date = new Date(input);
  else if (typeof input === 'string') date = parseCostaRicaDateTime(input);
  else throw new AppError(`${fieldName} tiene formato inválido`, 400, 'INVALID_DATE');
  return validateDate(date, fieldName);
}

export function sameInstant(a: Date | string, b: Date | string): boolean {
  return toLocalDate(a).getTime() === toLocalDate(b).getTime();
}

export function extendRangeWithBuffer(min: Date, max: Date, bufferMs = 60_000) {
  return {
    min: new Date(min.getTime() - bufferMs),
    max: new Date(max.getTime() + bufferMs),
  };
}

/**
 * Parser robusto para ISO strings sin zona horaria (interpreta como TZ del negocio).
 */
export function parseCostaRicaDateTime(input: string | Date): Date {
  if (input instanceof Date) return new Date(input.getTime());
  const raw = input.trim();
  if (!raw) throw new Error(`Invalid date: ${input}`);

  // Si viene con 'Z' o offset explícito, parsear directamente
  if (/[zZ]$/.test(raw) || /[+-]\d\d:\d\d$/.test(raw)) {
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) throw new Error(`Invalid date: ${input}`);
    return parsed;
  }

  const [datePart, timePartRaw] = raw.split(/[T\s]/);
  if (!datePart) throw new Error(`Invalid date: ${input}`);

  const [yearStr, monthStr, dayStr] = datePart.split('-');
  const year = parseInt(yearStr ?? '0', 10);
  const month = parseInt(monthStr ?? '0', 10);
  const day = parseInt(dayStr ?? '0', 10);

  const timePart = timePartRaw ?? '00:00:00';
  const [mainTime, msPartRaw] = timePart.split('.');
  const [hourStr, minuteStr, secondStr] = mainTime.split(':');

  const hours = parseInt(hourStr ?? '0', 10);
  const minutes = parseInt(minuteStr ?? '0', 10);
  const seconds = parseInt(secondStr ?? '0', 10);
  const msPart = msPartRaw ? (msPartRaw + '000').slice(0, 3) : '000';
  const milliseconds = parseInt(msPart, 10);

  if (
    !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) ||
    !Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)
  ) {
    throw new Error(`Invalid date: ${input}`);
  }

  // Construir el instante UTC para esa fecha/hora en TZ del negocio
  // Truco: construir como si fuera UTC, luego ajustar con el offset real
  const approxUtc = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds));
  // Calcular el offset para ese momento
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.name,
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const tzParts = formatter.formatToParts(approxUtc);
  const tzH = parseInt(tzParts.find(p => p.type === 'hour')?.value ?? '0');
  const tzMin = parseInt(tzParts.find(p => p.type === 'minute')?.value ?? '0');
  const offsetMs = (tzH * 60 + tzMin - hours * 60 - minutes) * 60000;
  return new Date(approxUtc.getTime() - offsetMs);
}

// ─── Aliases deprecated ───────────────────────────────────────────────────────
/** @deprecated */ export const toUtcDate = toLocalDate;
/** @deprecated */ export const startOfUtcDay = startOfLocalDay;
/** @deprecated */ export const addUtcDays = addLocalDays;
/** @deprecated */ export const atUtcTime = atLocalTime;
