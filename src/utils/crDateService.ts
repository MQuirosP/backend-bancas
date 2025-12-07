/**
 * ⚠️ ESTÁNDAR CRÍTICO: ZONA HORARIA COSTA RICA
 * 
 * Servicio centralizado para manejo de fechas en zona horaria Costa Rica.
 * TODAS las conversiones de fechas deben usar este servicio.
 * 
 * Reglas fundamentales:
 * 1. Backend es la autoridad temporal: todos los rangos se resuelven en server
 * 2. Fechas calendario (YYYY-MM-DD) siempre representan días en CR
 * 3. Date UTC siempre representa instantes UTC que pueden corresponder a días diferentes en CR
 * 4. DATE de PostgreSQL (sin hora) representa días calendario en CR directamente
 */

export const CR_DATE_OFFSET_HOURS = 6; // UTC-6
export const CR_DATE_OFFSET_MS = CR_DATE_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Convierte un Date UTC a fecha calendario en CR (YYYY-MM-DD)
 * 
 * @param date Date en UTC que representa un instante
 * @returns String YYYY-MM-DD representando el día calendario en CR
 * 
 * Ejemplo:
 * - Input: Date('2025-12-07T05:59:59.999Z') (fin del día 6 en CR)
 * - Output: '2025-12-06' (día correcto en CR)
 */
export function dateUTCToCRString(date: Date): string {
  // Sumar 6 horas para obtener la fecha en CR
  const crDate = new Date(date.getTime() + CR_DATE_OFFSET_MS);
  const year = crDate.getUTCFullYear();
  const month = String(crDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(crDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Extrae fecha CR de un DATE de PostgreSQL (sin hora)
 * 
 * Cuando PostgreSQL devuelve DATE(... AT TIME ZONE 'America/Costa_Rica'),
 * devuelve un DATE (sin hora) que representa el día calendario en CR.
 * Prisma lo convierte a Date con 00:00:00.000Z, pero ya representa el día correcto.
 * 
 * @param date Date que viene de PostgreSQL DATE (sin hora)
 * @returns String YYYY-MM-DD representando el día calendario en CR
 * 
 * Ejemplo:
 * - Input: Date('2025-12-06T00:00:00.000Z') (DATE de PostgreSQL)
 * - Output: '2025-12-06' (día correcto en CR)
 */
export function postgresDateToCRString(date: Date): string {
  // DATE de PostgreSQL ya representa el día correcto, solo extraer
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convierte un rango de fechas UTC a strings CR
 * 
 * ⚠️ CRÍTICO: Para endDate, extrae la fecha CR correctamente considerando que
 * puede ser 05:59:59.999 UTC del día siguiente (fin del día anterior en CR)
 * 
 * @param startDate Date UTC que representa inicio del período
 * @param endDate Date UTC que representa fin del período (puede ser del día siguiente en UTC)
 * @returns Objeto con startDateCRStr y endDateCRStr en formato YYYY-MM-DD
 * 
 * Ejemplo:
 * - Input: startDate = Date('2025-12-06T06:00:00.000Z'), endDate = Date('2025-12-07T05:59:59.999Z')
 * - Output: { startDateCRStr: '2025-12-06', endDateCRStr: '2025-12-06' }
 */
export function dateRangeUTCToCRStrings(startDate: Date, endDate: Date): {
  startDateCRStr: string;
  endDateCRStr: string;
} {
  const startDateCRStr = dateUTCToCRString(startDate);
  
  // ⚠️ CRÍTICO: endDate es 05:59:59.999 UTC del día siguiente (fin del día anterior en CR)
  // Ejemplo: endDate = 2025-12-07T05:59:59.999Z representa fin del día 6 en CR
  // 
  // Cálculo paso a paso:
  // - endDate = 2025-12-07T05:59:59.999Z (fin del día 6 en CR)
  // - Restar 6 horas: 2025-12-06T23:59:59.999Z
  // - dateUTCToCRString suma 6 horas: 2025-12-07T05:59:59.999Z → "2025-12-07" ❌
  //
  // Solución: Extraer directamente la fecha CR sin usar dateUTCToCRString
  // porque ya sabemos que endDate representa el fin del día anterior
  const endDateAdjusted = new Date(endDate.getTime() - CR_DATE_OFFSET_MS);
  // Extraer directamente año, mes, día sin convertir (ya está en el día correcto)
  const endYear = endDateAdjusted.getUTCFullYear();
  const endMonth = String(endDateAdjusted.getUTCMonth() + 1).padStart(2, '0');
  const endDay = String(endDateAdjusted.getUTCDate()).padStart(2, '0');
  const endDateCRStr = `${endYear}-${endMonth}-${endDay}`;
  
  return { startDateCRStr, endDateCRStr };
}

/**
 * Valida que una fecha CR está dentro de un rango CR
 * 
 * @param dateStr Fecha CR en formato YYYY-MM-DD
 * @param startDateCRStr Fecha inicio CR en formato YYYY-MM-DD
 * @param endDateCRStr Fecha fin CR en formato YYYY-MM-DD
 * @returns true si la fecha está dentro del rango (inclusive)
 */
export function isDateInCRRange(
  dateStr: string,
  startDateCRStr: string,
  endDateCRStr: string
): boolean {
  return dateStr >= startDateCRStr && dateStr <= endDateCRStr;
}

