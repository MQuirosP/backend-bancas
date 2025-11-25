/**
 * Fecha/hora: utilidades para trabajar con hora LOCAL de Costa Rica.
 * 
 * IMPORTANTE: El backend maneja TODA la lógica de fechas en hora LOCAL de Costa Rica (GMT-6).
 * La base de datos guarda timestamps sin zona horaria (TIMESTAMP WITHOUT TIME ZONE),
 * por lo que todos los Date objects deben usar hora local directamente.
 * 
 * REGLAS DE ORO:
 * 1. NUNCA uses `new Date()` directamente → Usa `nowCR()`
 * 2. SIEMPRE valida fechas antes de usar → Usa `validateDate()`
 * 3. NORMALIZA entrada externa → Usa `normalizeDateCR()`
 */

import { AppError } from '../core/errors';

// Zona horaria de Costa Rica: GMT-6 (UTC-6) sin DST
export const COSTA_RICA_OFFSET_HOURS = -6;
const COSTA_RICA_OFFSET_MS = COSTA_RICA_OFFSET_HOURS * 60 * 60 * 1000;

function shiftToCostaRica(date: Date): Date {
  return new Date(date.getTime() + COSTA_RICA_OFFSET_MS);
}

function shiftFromCostaRica(date: Date): Date {
  return new Date(date.getTime() - COSTA_RICA_OFFSET_MS);
}

// ============================================================================
// 🛡️ UTILIDADES DEFENSIVAS - Previenen errores "Invalid time value"
// ============================================================================

/**
 * Crea un Date en hora de Costa Rica AHORA.
 * Reemplaza TODOS los `new Date()` del código.
 * 
 * @returns Date actual del servidor (debe estar en UTC)
 */
export function nowCR(): Date {
  return new Date();
}

/**
 * Valida que un Date sea válido.
 * Lanza AppError si es inválido, null o undefined.
 * 
 * @param date - Date a validar
 * @param fieldName - Nombre del campo para mensaje de error
 * @returns El mismo Date si es válido
 * @throws AppError si es inválido
 */
export function validateDate(date: Date | null | undefined, fieldName: string): Date {
  if (!date) {
    throw new AppError(`${fieldName} es requerido`, 400, 'INVALID_DATE');
  }
  if (!(date instanceof Date)) {
    throw new AppError(`${fieldName} debe ser un Date`, 400, 'INVALID_DATE');
  }
  if (isNaN(date.getTime())) {
    throw new AppError(
      `${fieldName} tiene un valor de fecha inválido`,
      400,
      'INVALID_DATE'
    );
  }
  return date;
}

/**
 * Normaliza entrada de fecha desde FE/DB a Date válido en CR.
 * Acepta: Date, ISO string, timestamp number
 * 
 * @param input - Fecha en cualquier formato
 * @param fieldName - Nombre del campo para mensaje de error
 * @returns Date normalizado y validado
 * @throws AppError si el formato es inválido
 */
export function normalizeDateCR(
  input: Date | string | number | null | undefined,
  fieldName: string = 'date'
): Date {
  if (!input) {
    throw new AppError(`${fieldName} es requerido`, 400, 'INVALID_DATE');
  }

  let date: Date;

  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'number') {
    date = new Date(input);
  } else if (typeof input === 'string') {
    date = parseCostaRicaDateTime(input);
  } else {
    throw new AppError(
      `${fieldName} tiene formato inválido (tipo: ${typeof input})`,
      400,
      'INVALID_DATE'
    );
  }

  return validateDate(date, fieldName);
}

/**
 * Formatea Date a ISO string CON timezone CR explícito.
 * Para respuestas del API y debugging.
 * 
 * @param date - Date a formatear
 * @returns ISO string con timezone: "2025-11-25T12:00:00.000-06:00"
 */
export function formatDateCRWithTZ(date: Date): string {
  validateDate(date, 'date');
  const iso = formatIsoLocal(date);
  return `${iso}-06:00`; // Agregar timezone CR
}

/**
 * Formatea Date a ISO string SIN timezone (asume CR).
 * Alias de formatIsoLocal para compatibilidad.
 * 
 * @param date - Date a formatear
 * @returns ISO string sin timezone: "2025-11-25T12:00:00.000"
 */
export function formatDateCR(date: Date | string): string {
  return formatIsoLocal(date);
}

// ============================================================================
// UTILIDADES EXISTENTES (mantener compatibilidad)
// ============================================================================

// Normaliza entrada a Date. Acepta Date o ISO string interpretado en hora local (CR).
export function toLocalDate(input: Date | string): Date {
  if (input instanceof Date) return new Date(input.getTime());
  return parseCostaRicaDateTime(input);
}

// Compara por instante (ms desde epoch)
export function sameInstant(a: Date | string, b: Date | string): boolean {
  return toLocalDate(a).getTime() === toLocalDate(b).getTime();
}

// ISO string (sin 'Z', hora local)
export function formatIsoLocal(d: Date | string): string {
  const utcDate = toLocalDate(d);
  const local = shiftToCostaRica(utcDate);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const seconds = String(local.getUTCSeconds()).padStart(2, '0');
  const ms = String(local.getUTCMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}`;
}

// Inicio de día en hora local
export function startOfLocalDay(d: Date | string): Date {
  const original = toLocalDate(d);
  const local = shiftToCostaRica(original);
  local.setUTCHours(0, 0, 0, 0);
  return shiftFromCostaRica(local);
}

// Agregar días en hora local
export function addLocalDays(d: Date | string, days: number): Date {
  const original = toLocalDate(d);
  const local = shiftToCostaRica(original);
  local.setUTCDate(local.getUTCDate() + days);
  return shiftFromCostaRica(local);
}

// Fin de día en hora local (23:59:59.999)
export function endOfLocalDay(d: Date | string): Date {
  const start = startOfLocalDay(d);
  const nextDay = addLocalDays(start, 1);
  // El fin del día es el inicio del día siguiente menos 1ms
  return new Date(nextDay.getTime() - 1);
}

/**
 * Construye un Date interpretando HH:mm como hora LOCAL de Costa Rica.
 * 
 * Ejemplo:
 * - Input: baseDate="2025-10-29", hhmm="12:55"
 * - Output: Date con hora local 12:55 (sin conversión UTC)
 * 
 * El Date resultante tendrá:
 * - getHours() = 12
 * - getMinutes() = 55
 * - Se guarda en BD como "2025-10-29T12:55:00" (sin 'Z')
 */
export function atLocalTime(baseDate: Date | string, hhmm: string): Date {
  const [hRaw, mRaw] = hhmm.split(":");
  const localHour = Number.parseInt(hRaw ?? "0", 10);
  const localMinute = Number.parseInt(mRaw ?? "0", 10);

  if (!isFinite(localHour) || !isFinite(localMinute)) {
    throw new Error(`Invalid time format: ${hhmm}`);
  }

  // Empezar con el inicio del día en hora local
  const start = startOfLocalDay(baseDate);
  const local = shiftToCostaRica(start);
  local.setUTCHours(localHour, localMinute, 0, 0);
  return shiftFromCostaRica(local);
}

// Pequeño buffer en ms a ambos lados de un rango para consultas por frontera
export function extendRangeWithBuffer(min: Date, max: Date, bufferMs = 60_000) {
  return {
    min: new Date(min.getTime() - bufferMs),
    max: new Date(max.getTime() + bufferMs),
  };
}

// ============================================================================
// Alias para compatibilidad hacia atrás (DEPRECATED)
// ============================================================================
/** @deprecated Usar toLocalDate() en su lugar */
export const toUtcDate = toLocalDate;

/** @deprecated Usar formatIsoLocal() en su lugar */
export const formatIsoUtc = formatIsoLocal;

/** @deprecated Usar startOfLocalDay() en su lugar */
export const startOfUtcDay = startOfLocalDay;

/** @deprecated Usar addLocalDays() en su lugar */
export const addUtcDays = addLocalDays;

/** @deprecated Usar atLocalTime() en su lugar */
export const atUtcTime = atLocalTime;

/**
 * Parser robusto para strings ISO sin zona (tratadas como hora local Costa Rica).
 */
export function parseCostaRicaDateTime(input: string | Date): Date {
  if (input instanceof Date) return new Date(input.getTime());

  const raw = input.trim();
  if (!raw) throw new Error(`Invalid date: ${input}`);

  // Si viene con 'Z' o offset explícito, delegar al parser estándar
  if (/[zZ]$/.test(raw) || /[+-]\d\d:\d\d$/.test(raw)) {
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) throw new Error(`Invalid date: ${input}`);
    return parsed;
  }

  const [datePart, timePartRaw] = raw.split(/[T\s]/);
  if (!datePart) throw new Error(`Invalid date: ${input}`);

  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const year = Number.parseInt(yearStr ?? "0", 10);
  const month = Number.parseInt(monthStr ?? "0", 10);
  const day = Number.parseInt(dayStr ?? "0", 10);

  const timePart = timePartRaw ?? "00:00:00";
  const [mainTime, msPartRaw] = timePart.split(".");
  const [hourStr, minuteStr, secondStr] = mainTime.split(":");

  const hours = Number.parseInt(hourStr ?? "0", 10);
  const minutes = Number.parseInt(minuteStr ?? "0", 10);
  const seconds = Number.parseInt(secondStr ?? "0", 10);
  const msPart = msPartRaw ? (msPartRaw + "000").slice(0, 3) : "000";
  const milliseconds = Number.parseInt(msPart, 10);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(milliseconds)
  ) {
    throw new Error(`Invalid date: ${input}`);
  }

  const utcMillis = Date.UTC(
    year,
    month - 1,
    day,
    hours - COSTA_RICA_OFFSET_HOURS,
    minutes,
    seconds,
    milliseconds
  );

  return new Date(utcMillis);
}

