/**
 * Fecha/hora: utilidades para trabajar en UTC de forma consistente.
 */

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

// Construye un Date en UTC con HH:mm sobre la fecha base (UTC)
export function atUtcTime(baseUtcDate: Date | string, hhmm: string): Date {
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number.parseInt(hRaw ?? "0", 10);
  const m = Number.parseInt(mRaw ?? "0", 10);
  const base = startOfUtcDay(baseUtcDate);
  base.setUTCHours(isFinite(h) ? h : 0, isFinite(m) ? m : 0, 0, 0);
  return base;
}

// Pequeño buffer en ms a ambos lados de un rango para consultas por frontera
export function extendRangeWithBuffer(min: Date, max: Date, bufferMs = 60_000) {
  return {
    min: new Date(min.getTime() - bufferMs),
    max: new Date(max.getTime() + bufferMs),
  };
}

