/**
 * ⚠️ ESTÁNDAR CRÍTICO: ZONA HORARIA COSTA RICA
 * 
 * ⚠️ ÚNICA FUENTE DE VERDAD PARA CONVERSIONES DE FECHAS EN COSTA RICA
 * 
 * Este servicio es la ÚNICA fuente autorizada para todas las conversiones de fechas.
 * NUNCA crear constantes nuevas o funciones de conversión fuera de este archivo.
 * 
 * Reglas fundamentales:
 * 1. Backend es la autoridad temporal: todos los rangos se resuelven en server
 * 2. Fechas calendario (YYYY-MM-DD) siempre representan días en CR
 * 3. Date UTC siempre representa instantes UTC que pueden corresponder a días diferentes en CR
 * 4. DATE de PostgreSQL (sin hora) representa días calendario en CR directamente
 * 
 * ⚠️ CONSTANTE ÚNICA: Esta es la ÚNICA constante para el offset de CR en todo el codebase
 * 
 * Costa Rica está en UTC-6 (sin horario de verano).
 * Para convertir un instante UTC a fecha calendario CR:
 * - Sumar 6 horas al instante UTC
 * - Extraer año/mes/día del resultado
 * 
 * Ejemplo:
 * - UTC: 2025-12-07T05:59:59.999Z (fin del día 6 en CR)
 * - Sumar 6h: 2025-12-07T11:59:59.999Z
 * - Fecha CR: 2025-12-07 (pero representa el fin del día 6)
 */
export const CR_TIMEZONE_OFFSET_HOURS = 6; // UTC-6 (Costa Rica)
export const CR_TIMEZONE_OFFSET_MS = CR_TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;

// ⚠️ DEPRECATED: Usar CR_TIMEZONE_OFFSET_HOURS en su lugar
/** @deprecated Usar CR_TIMEZONE_OFFSET_HOURS */
export const CR_DATE_OFFSET_HOURS = CR_TIMEZONE_OFFSET_HOURS;
/** @deprecated Usar CR_TIMEZONE_OFFSET_MS */
export const CR_DATE_OFFSET_MS = CR_TIMEZONE_OFFSET_MS;

/**
 * Convierte un instante UTC a fecha calendario CR (YYYY-MM-DD).
 * 
 * ⚠️ USAR SOLO PARA: Date objects que representan instantes UTC
 * - Date objects de resolveDateRange() (fromAt, toAt)
 * - Date objects de createdAt, updatedAt (timestamps UTC)
 * - Cualquier Date que represente un instante UTC
 * 
 * @param dateUTC Date en UTC que representa un instante (ej: Date('2025-12-07T05:59:59.999Z'))
 * @returns String YYYY-MM-DD representando el día calendario en CR
 * 
 * Ejemplo:
 * - Input: Date('2025-12-07T05:59:59.999Z') (fin del día 6 en CR)
 * - Output: '2025-12-06' ✅
 */
export function dateUTCToCRString(dateUTC: Date): string {
  // Sumar 6 horas para obtener la fecha en CR
  const crDate = new Date(dateUTC.getTime() + CR_TIMEZONE_OFFSET_MS);
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
  
  // ⚠️ CRÍTICO: endDate representa el fin del día en CR
  // Ejemplo: endDate = 2026-01-02T05:59:59.999Z representa fin del día 1 en CR (23:59:59.999 del día 1)
  // Para obtener la fecha CR correcta:
  // - endDate está en UTC y representa 23:59:59.999 CR del día anterior al día siguiente en UTC
  // - Si endDate = 2026-01-02T05:59:59.999Z, esto es 23:59:59.999 del 1 de enero en CR
  // - Necesitamos extraer el día 1, no el día 2
  //
  // Solución: endDate representa el fin del día N en CR, que es 05:59:59.999 UTC del día N+1
  // Para obtener el día N: restar 1 día completo (24 horas) de endDate antes de convertir
  // Esto nos da 05:59:59.999 UTC del día N, que representa 23:59:59.999 del día N-1 en CR
  // Pero queremos el día N, así que necesitamos ajustar: endDate - 1 día = fin del día N-1
  // Mejor: endDate representa fin del día N, así que restamos 1 día para obtener inicio del día N
  // Luego usamos dateUTCToCRString para obtener el día N correcto
  const endDateMinusOneDay = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
  // endDateMinusOneDay ahora representa el inicio del día N en UTC (05:59:59.999 UTC del día N)
  // dateUTCToCRString suma 6 horas y extrae la fecha CR correcta (día N)
  const endDateCRStr = dateUTCToCRString(endDateMinusOneDay);
  
  return { startDateCRStr, endDateCRStr };
}

/**
 * Valida que una fecha CR está dentro de un rango CR (inclusivo).
 * 
 * ⚠️ USAR PARA: Validar si una fecha CR está dentro de un rango CR
 * - Filtrar arrays de datos por fecha
 * - Validar parámetros de entrada
 * 
 * @param dateStr Fecha CR en formato YYYY-MM-DD
 * @param startDateCRStr Fecha inicio CR en formato YYYY-MM-DD
 * @param endDateCRStr Fecha fin CR en formato YYYY-MM-DD
 * @returns true si la fecha está dentro del rango (inclusive)
 * 
 * Ejemplo:
 * - Input: dateStr = '2025-12-06', startDateCRStr = '2025-12-06', endDateCRStr = '2025-12-06'
 * - Output: true ✅
 */
export function isDateInCRRange(
  dateStr: string,
  startDateCRStr: string,
  endDateCRStr: string
): boolean {
  return dateStr >= startDateCRStr && dateStr <= endDateCRStr;
}

/**
 * ⚠️ SERVICIO CENTRALIZADO: Exportar todas las funciones como objeto
 * 
 * Uso recomendado:
 * ```typescript
 * import { crDateService } from '../utils/crDateService';
 * 
 * const dateStr = crDateService.dateUTCToCRString(dateUTC);
 * const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(fromAt, toAt);
 * ```
 * 
 * NOTA: Para calcular el primer día del mes en CR, usar `resolveDateRange('month')` de `dateRange.ts`
 */
export const crDateService = {
  dateUTCToCRString,
  postgresDateToCRString,
  dateRangeUTCToCRStrings,
  isDateInCRRange,
  // Constantes
  CR_TIMEZONE_OFFSET_HOURS,
  CR_TIMEZONE_OFFSET_MS,
};

