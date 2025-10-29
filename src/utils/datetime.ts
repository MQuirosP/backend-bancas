/**
 * Fecha/hora: utilidades para trabajar con hora LOCAL de Costa Rica.
 * 
 * IMPORTANTE: El backend maneja TODA la lógica de fechas en hora LOCAL de Costa Rica (GMT-6).
 * La base de datos guarda timestamps sin zona horaria (TIMESTAMP WITHOUT TIME ZONE),
 * por lo que todos los Date objects deben usar hora local directamente.
 */

// Zona horaria de Costa Rica: GMT-6 (UTC-6)
// Costa Rica no usa horario de verano (DST), por lo que siempre es -6 horas
const COSTA_RICA_OFFSET_HOURS = -6;

// Normaliza entrada a Date. Acepta Date o ISO string.
export function toLocalDate(input: Date | string): Date {
  if (input instanceof Date) return new Date(input.getTime());
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d;
}

// Compara por instante (ms desde epoch)
export function sameInstant(a: Date | string, b: Date | string): boolean {
  return toLocalDate(a).getTime() === toLocalDate(b).getTime();
}

// ISO string (sin 'Z', hora local)
export function formatIsoLocal(d: Date | string): string {
  const date = toLocalDate(d);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}`;
}

// Inicio de día en hora local
export function startOfLocalDay(d: Date | string): Date {
  const x = toLocalDate(d);
  const out = new Date(x.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

// Agregar días en hora local
export function addLocalDays(d: Date | string, days: number): Date {
  const x = toLocalDate(d);
  const out = new Date(x.getTime());
  out.setDate(out.getDate() + days);
  return out;
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
  const base = startOfLocalDay(baseDate);
  
  // Establecer hora local directamente (sin conversión UTC)
  base.setHours(localHour, localMinute, 0, 0);
  
  return base;
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

