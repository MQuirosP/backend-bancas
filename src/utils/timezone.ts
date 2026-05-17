/**
 * ✅ FUENTE ÚNICA DE VERDAD PARA TIMEZONE DEL NEGOCIO
 *
 * Configurable via variable de entorno. Sin aritmética manual.
 * Sin +6, sin -6, sin conversiones manuales.
 *
 * Uso:
 *   import { tz } from '../utils/timezone';
 *
 *   tz.toDateStr(new Date())          → "2026-05-16"
 *   tz.startOfDay(new Date())         → Date (inicio del día en la TZ del negocio, en UTC)
 *   tz.endOfDay(new Date())           → Date (fin del día, 23:59:59.999 en TZ negocio, en UTC)
 *   tz.dayOfWeek(new Date())          → 0-6 (0=Domingo) según TZ del negocio
 *   tz.addDays(date, n)               → Date (n días después, mantiene la hora en TZ negocio)
 *   tz.toSqlLiteral()                 → "'America/Costa_Rica'" para queries SQL
 *   tz.name                           → "America/Costa_Rica"
 */

const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE ?? 'America/Costa_Rica';

/**
 * Calcula el offset en ms entre la TZ del negocio y UTC en un instante dado.
 * Compatible con DST — recalcula en cada llamada.
 *
 * @internal
 */
function getOffsetMs(utcInstant: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcInstant);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value);
  const [y, mo, d, h, min, s] = [
    get('year'), get('month'), get('day'),
    get('hour'), get('minute'), get('second'),
  ];
  // Construir el instante "como si fuera UTC" para calcular la diferencia
  const tzAsUtc = Date.UTC(y, mo - 1, d, h === 24 ? 0 : h, min, s);
  return tzAsUtc - utcInstant.getTime();
}

/**
 * Convierte un instante UTC a string YYYY-MM-DD en la TZ del negocio.
 */
function toDateStr(utcDate: Date = new Date()): string {
  return utcDate.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  // en-CA produce formato YYYY-MM-DD de forma nativa
}

/**
 * Inicio del día calendario en TZ negocio, expresado como instante UTC.
 * Ej: "2026-05-16" en CR → 2026-05-16T06:00:00.000Z
 */
function startOfDay(utcDate: Date = new Date()): Date {
  const dateStr = toDateStr(utcDate);
  const [y, m, d] = dateStr.split('-').map(Number);
  const approxMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const offsetMs = getOffsetMs(approxMidnight);
  // midnight en TZ negocio = approxMidnight - offsetMs
  return new Date(approxMidnight.getTime() - offsetMs);
}

/**
 * Fin del día calendario en TZ negocio (23:59:59.999), expresado como instante UTC.
 */
function endOfDay(utcDate: Date = new Date()): Date {
  const next = addDays(startOfDay(utcDate), 1);
  return new Date(next.getTime() - 1);
}

/**
 * Suma N días manteniendo la hora relativa en TZ negocio.
 */
function addDays(utcDate: Date, days: number): Date {
  const dateStr = toDateStr(utcDate);
  const [y, m, d] = dateStr.split('-').map(Number);
  const nextDateStr = new Date(Date.UTC(y, m - 1, d + days, 12)) // mediodía para evitar edge cases
    .toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
  const [ny, nm, nd] = nextDateStr.split('-').map(Number);
  // Preservar la hora original relativa a TZ
  const origOffset = getOffsetMs(utcDate);
  const origLocalHour = new Date(utcDate.getTime() + origOffset);
  const h = origLocalHour.getUTCHours();
  const min = origLocalHour.getUTCMinutes();
  const s = origLocalHour.getUTCSeconds();
  const ms = origLocalHour.getUTCMilliseconds();
  const newApprox = new Date(Date.UTC(ny, nm - 1, nd, 0, 0, 0, 0));
  const newOffset = getOffsetMs(newApprox);
  return new Date(Date.UTC(ny, nm - 1, nd, h, min, s, ms) - newOffset);
}

/**
 * Día de la semana (0=Domingo) según la TZ del negocio.
 * Reemplaza cursor.getDay() que usa TZ del servidor.
 */
function dayOfWeek(utcDate: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    weekday: 'short',
  });
  const day = formatter.format(utcDate);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

/**
 * Literal para usar en queries SQL crudas.
 * Ejemplo: `AT TIME ZONE ${tz.toSqlLiteral()}`
 */
function toSqlLiteral(): string {
  return `'${BUSINESS_TZ}'`;
}

export const tz = {
  /** Nombre IANA de la zona horaria del negocio */
  name: BUSINESS_TZ,
  /** Literal SQL: 'America/Costa_Rica' */
  toSqlLiteral,
  /** YYYY-MM-DD en TZ del negocio */
  toDateStr,
  /** Inicio del día (00:00:00 TZ negocio) como UTC */
  startOfDay,
  /** Fin del día (23:59:59.999 TZ negocio) como UTC */
  endOfDay,
  /** Suma N días */
  addDays,
  /** Día de la semana (0=Dom) según TZ negocio */
  dayOfWeek,
};

// ─── Aliases para compatibilidad con el código existente ──────────────────────
// Permite migrar gradualmente sin romper imports existentes.

/** @deprecated Usar tz.startOfDay() */
export function startOfLocalDay(d: Date | string): Date {
  return tz.startOfDay(typeof d === 'string' ? new Date(d) : d);
}
/** @deprecated Usar tz.addDays() */
export function addLocalDays(d: Date | string, days: number): Date {
  return tz.addDays(typeof d === 'string' ? new Date(d) : d, days);
}
/** @deprecated Usar tz.endOfDay() */
export function endOfLocalDay(d: Date | string): Date {
  return tz.endOfDay(typeof d === 'string' ? new Date(d) : d);
}
/** @deprecated Usar tz.toDateStr() */
export function getTodayCRString(): string {
  return tz.toDateStr();
}
