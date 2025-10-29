/**
 * Fecha/hora: utilidades para trabajar en UTC de forma consistente.
 * 
 * NOTA: Las horas configuradas en loterías se interpretan como hora local
 * de Costa Rica (GMT-6) y se convierten automáticamente a UTC para almacenamiento.
 */

// Zona horaria de Costa Rica: GMT-6 (UTC-6)
// Costa Rica no usa horario de verano (DST), por lo que siempre es -6 horas
const COSTA_RICA_OFFSET_HOURS = -6;

// Normaliza entrada a Date (UTC instant). Acepta Date o ISO string.
export function toUtcDate(input: Date | string): Date {
  if (input instanceof Date) return new Date(input.getTime());
  // new Date(iso) ya interpreta en UTC si es ISO válido
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d;
}

// Compara por instante (ms desde epoch)
export function sameInstant(a: Date | string, b: Date | string): boolean {
  return toUtcDate(a).getTime() === toUtcDate(b).getTime();
}

// ISO UTC sin pérdida
export function formatIsoUtc(d: Date | string): string {
  return toUtcDate(d).toISOString();
}

// Inicio de día en UTC
export function startOfUtcDay(d: Date | string): Date {
  const x = toUtcDate(d);
  const out = new Date(x.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

export function addUtcDays(d: Date | string, days: number): Date {
  const x = toUtcDate(d);
  const out = new Date(x.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Construye un Date en UTC interpretando HH:mm como hora LOCAL de Costa Rica.
 * 
 * Ejemplo:
 * - Input: "12:55" (mediodía en Costa Rica)
 * - Output: Date con 18:55 UTC (12:55 + 6 horas)
 * 
 * Esto garantiza que cuando el frontend (en Costa Rica) muestre la fecha,
 * automáticamente la convierta de UTC a local y muestre "12:55" correctamente.
 */
export function atUtcTime(baseUtcDate: Date | string, hhmm: string): Date {
  const [hRaw, mRaw] = hhmm.split(":");
  const localHour = Number.parseInt(hRaw ?? "0", 10);
  const localMinute = Number.parseInt(mRaw ?? "0", 10);
  
  if (!isFinite(localHour) || !isFinite(localMinute)) {
    throw new Error(`Invalid time format: ${hhmm}`);
  }
  
  // Empezar con el inicio del día en UTC
  const base = startOfUtcDay(baseUtcDate);
  
  // Convertir hora local de Costa Rica (GMT-6) a UTC
  // Si son las 12:55 en Costa Rica, en UTC son las 18:55 (12 + 6)
  const utcHour = localHour - COSTA_RICA_OFFSET_HOURS;
  
  base.setUTCHours(utcHour, localMinute, 0, 0);
  
  return base;
}

// Pequeño buffer en ms a ambos lados de un rango para consultas por frontera
export function extendRangeWithBuffer(min: Date, max: Date, bufferMs = 60_000) {
  return {
    min: new Date(min.getTime() - bufferMs),
    max: new Date(max.getTime() + bufferMs),
  };
}

