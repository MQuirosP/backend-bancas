/**
 * Utilidad para resolver rangos de fechas desde tokens semánticos a UTC.
 *
 * Backend es la autoridad temporal: todos los rangos se resuelven en server.
 * Frontend envía solo: date (today|yesterday|range) y, si range, fromDate/toDate en YYYY-MM-DD.
 *
 * Zona horaria fija: America/Costa_Rica (UTC-6, sin horario de verano).
 */

import { AppError } from '../core/errors';

const BUSINESS_TZ = 'America/Costa_Rica';
const TZ_OFFSET_HOURS = -6; // UTC-6

/**
 * Obtener la fecha actual en la zona horaria de negocio (CR).
 */
function getTodayInTz(serverNow: Date): string {
  // Convertir UTC a CR: restar 6 horas
  const crDate = new Date(serverNow.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  const year = crDate.getUTCFullYear();
  const month = String(crDate.getUTCMonth() + 1).padStart(2, '0');
  const date = String(crDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

/**
 * Convertir una fecha calendario (YYYY-MM-DD) en CR a un instante UTC.
 * Ejemplo: '2025-10-26' a las 00:00:00 CR = 2025-10-26T06:00:00Z
 */
function crDateToUtc(dateStr: string): Date {
  // dateStr es '2025-10-26'
  const [year, month, date] = dateStr.split('-').map(Number);

  // Crear un Date en "UTC" pero con esos valores YMD
  const d = new Date(Date.UTC(year, month - 1, date, 0, 0, 0, 0));

  // Ahora restar el offset (-6 horas) para obtener el instante UTC real
  // Porque 00:00:00 CR = 06:00:00 UTC
  return new Date(d.getTime() - TZ_OFFSET_HOURS * 60 * 60 * 1000);
}

/**
 * Formatear un Date en YYYY-MM-DD.
 */
function formatDateComponents(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validar formato YYYY-MM-DD.
 */
function isValidDateFormat(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) return false;

  const [year, month, date] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (date < 1 || date > 31) return false;

  // Validar que sea una fecha real (ej: no 2025-02-30)
  const d = new Date(year, month - 1, date);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === date
  );
}

export interface DateRangeResolution {
  fromAt: Date;     // UTC instant (inicio del rango, inclusivo)
  toAt: Date;       // UTC instant (fin del rango, exclusivo: inicio del día siguiente)
  tz: string;       // 'America/Costa_Rica'
  description: string; // Descripción legible
}

/**
 * Resuelve un rango de fechas desde parámetros semánticos a UTC.
 *
 * Soporta dos modos:
 * 1. Semantic tokens: 'today', 'yesterday', 'week', 'month', 'year'
 * 2. Custom range: date='range' con fromDate/toDate en YYYY-MM-DD
 *
 * @param date 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range'
 * @param fromDate YYYY-MM-DD (requerido si date='range')
 * @param toDate YYYY-MM-DD (requerido si date='range')
 * @param serverNow Fecha actual (para testing); defecto: new Date()
 *
 * @throws AppError(400, 'SLS_2001') si fechas son inválidas
 * @throws AppError(400, 'SLS_2001') si rango es futuro
 * @throws AppError(400, 'SLS_2001') si fromDate > toDate
 */
export function resolveDateRange(
  date: string = 'today',
  fromDate?: string,
  toDate?: string,
  serverNow: Date = new Date()
): DateRangeResolution {
  // Validar parámetro 'date'
  const validDates = ['today', 'yesterday', 'week', 'month', 'year', 'range'];
  if (!validDates.includes(date)) {
    throw new AppError('Invalid date parameter', 400, {
      code: 'SLS_2001',
      details: [
        {
          field: 'date',
          reason: `Must be one of: ${validDates.join(', ')}`
        }
      ]
    });
  }

  const todayInCr = getTodayInTz(serverNow);

  let fromDateStr: string;
  let toDateStr: string;
  let description: string;

  if (date === 'today') {
    fromDateStr = todayInCr;
    toDateStr = todayInCr;
    description = `Today (${todayInCr}) in ${BUSINESS_TZ}`;
  } else if (date === 'yesterday') {
    const yesterday = new Date(serverNow.getTime() - 24 * 60 * 60 * 1000);
    fromDateStr = getTodayInTz(yesterday);
    toDateStr = fromDateStr;
    description = `Yesterday (${fromDateStr}) in ${BUSINESS_TZ}`;
  } else if (date === 'week') {
    // Semana actual (Lunes a Domingo en CR)
    const today = new Date(serverNow.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
    const dayOfWeek = today.getUTCDay(); // 0 = Domingo
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today.getTime() - daysToMonday * 24 * 60 * 60 * 1000);
    const sunday = new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);

    fromDateStr = formatDateComponents(monday);
    toDateStr = formatDateComponents(sunday);
    description = `This week (${fromDateStr} to ${toDateStr}) in ${BUSINESS_TZ}`;
  } else if (date === 'month') {
    // Mes actual
    const today = new Date(serverNow.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
    const firstDay = new Date(today.getUTCFullYear(), today.getUTCMonth(), 1);
    const lastDay = new Date(today.getUTCFullYear(), today.getUTCMonth() + 1, 0);

    fromDateStr = formatDateComponents(firstDay);
    toDateStr = formatDateComponents(lastDay);
    description = `This month (${fromDateStr} to ${toDateStr}) in ${BUSINESS_TZ}`;
  } else if (date === 'year') {
    // Año actual
    const today = new Date(serverNow.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
    const firstDay = new Date(today.getUTCFullYear(), 0, 1);
    const lastDay = new Date(today.getUTCFullYear(), 11, 31);

    fromDateStr = formatDateComponents(firstDay);
    toDateStr = formatDateComponents(lastDay);
    description = `This year (${fromDateStr} to ${toDateStr}) in ${BUSINESS_TZ}`;
  } else {
    // date === 'range'
    if (!fromDate || !toDate) {
      throw new AppError('fromDate and toDate required for date=range', 400, {
        code: 'SLS_2001',
        details: [
          {
            field: fromDate ? 'toDate' : 'fromDate',
            reason: 'Required when date=range'
          }
        ]
      });
    }

    if (!isValidDateFormat(fromDate)) {
      throw new AppError('Invalid fromDate format', 400, {
        code: 'SLS_2001',
        details: [
          {
            field: 'fromDate',
            reason: 'Use format YYYY-MM-DD'
          }
        ]
      });
    }

    if (!isValidDateFormat(toDate)) {
      throw new AppError('Invalid toDate format', 400, {
        code: 'SLS_2001',
        details: [
          {
            field: 'toDate',
            reason: 'Use format YYYY-MM-DD'
          }
        ]
      });
    }

    if (fromDate > toDate) {
      throw new AppError('fromDate must be ≤ toDate', 400, {
        code: 'SLS_2001',
        details: [
          {
            field: 'fromDate/toDate',
            reason: 'fromDate must be before or equal to toDate'
          }
        ]
      });
    }

    if (toDate > todayInCr) {
      throw new AppError('toDate cannot be in the future', 400, {
        code: 'SLS_2001',
        details: [
          {
            field: 'toDate',
            reason: `toDate must be ≤ today (${todayInCr})`
          }
        ]
      });
    }

    fromDateStr = fromDate;
    toDateStr = toDate;
    description = `Range ${fromDate} to ${toDate} in ${BUSINESS_TZ}`;
  }

  // Convertir a UTC
  const fromAt = crDateToUtc(fromDateStr);

  // toAt es el final del día (23:59:59.999 CR) = casi 06:00:00 del día siguiente en UTC
  // Mejor dicho: 00:00:00 del día siguiente en CR = 06:00:00 del día siguiente en UTC - 1ms
  const toParsed = new Date(serverNow);
  const [toYear, toMonth, toDay] = toDateStr.split('-').map(Number);
  toParsed.setUTCFullYear(toYear, toMonth - 1, toDay);
  toParsed.setUTCHours(0, 0, 0, 0);
  // Calcular 06:00:00 UTC del día siguiente (00:00:00 CR del día siguiente)
  const toAtMidnight = new Date(toParsed.getTime() + 24 * 60 * 60 * 1000 - TZ_OFFSET_HOURS * 60 * 60 * 1000);
  // Restar 1ms para que sea 23:59:59.999 del día actual en CR
  const toAt = new Date(toAtMidnight.getTime() - 1);

  return {
    fromAt,
    toAt,
    tz: BUSINESS_TZ,
    description
  };
}

/**
 * Validar un rango según granularidad de timeseries.
 *
 * @throws AppError(400, 'SLS_2001') si rango excede límite
 */
export function validateTimeseriesRange(
  fromAt: Date,
  toAt: Date,
  granularity: 'hour' | 'day' | 'week' = 'day'
): void {
  const diffMs = toAt.getTime() - fromAt.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (granularity === 'hour' && diffDays > 30) {
    throw new AppError('Range exceeds 30 days for hour granularity', 400, {
      code: 'SLS_2001',
      details: [
        {
          field: 'granularity',
          reason: 'hour granularity supports max 30 days'
        }
      ]
    });
  }

  if (granularity === 'day' && diffDays > 90) {
    throw new AppError('Range exceeds 90 days for day granularity', 400, {
      code: 'SLS_2001',
      details: [
        {
          field: 'granularity',
          reason: 'day granularity supports max 90 days'
        }
      ]
    });
  }
}
