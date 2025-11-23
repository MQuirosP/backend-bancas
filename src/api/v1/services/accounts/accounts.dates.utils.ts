/**
 * ⚠️ ESTÁNDAR CRÍTICO: ZONA HORARIA COSTA RICA
 * 
 * TODAS las fechas en este proyecto se manejan en hora LOCAL de Costa Rica (UTC-6).
 * NUNCA usar toISOString().split('T')[0] directamente en fechas UTC sin convertir primero a CR.
 * 
 * Reglas:
 * - startDate/endDate de resolveDateRange son instantes UTC que representan días en CR
 * - Para extraer la fecha CR de un Date UTC: convertir primero a CR, luego extraer YYYY-MM-DD
 * - La base de datos almacena fechas como DATE (sin hora), representando días calendario en CR
 * - Siempre convertir a CR antes de comparar o formatear fechas
 */
export const COSTA_RICA_UTC_OFFSET_HOURS = 6; // Costa Rica está en UTC-6, así que 00:00 local = 06:00 UTC
export const COSTA_RICA_UTC_OFFSET_MS = COSTA_RICA_UTC_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Convierte un Date UTC a fecha calendario en CR (YYYY-MM-DD)
 * 
 * ⚠️ CRÍTICO: Usar esta función cuando necesites extraer la fecha CR de un Date UTC
 * 
 * @param date Date en UTC que representa un instante en CR
 * @returns String YYYY-MM-DD representando el día calendario en CR
 * 
 * Ejemplo:
 * - Input: Date('2025-11-20T05:59:59.999Z') (fin del día 19 en CR)
 * - Output: '2025-11-19' (día correcto en CR)
 */
export function toCRDateString(date: Date): string {
    // Convertir UTC a CR: sumar 6 horas para obtener la fecha en CR
    const crDate = new Date(date.getTime() + COSTA_RICA_UTC_OFFSET_MS);
    const year = crDate.getUTCFullYear();
    const month = String(crDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(crDate.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function toCostaRicaISODate(date: Date): string {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            COSTA_RICA_UTC_OFFSET_HOURS,
            0,
            0,
            0
        )
    ).toISOString();
}

/**
 * Obtiene el rango de fechas del mes
 * FIX: Si el mes consultado es el mes actual, limita endDate a hoy para excluir días futuros
 */
export function getMonthDateRange(month: string): { startDate: Date; endDate: Date; daysInMonth: number } {
    const [year, monthNum] = month.split("-").map(Number);
    const startDate = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0));

    // Obtener fecha actual en UTC
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));

    // Calcular último día del mes consultado
    const monthEndDate = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59, 999));

    // Si el mes consultado es el mes actual, limitar a hoy
    // Si es un mes pasado, usar el último día de ese mes
    // Si es un mes futuro, usar el último día del mes consultado (aunque no debería pasar)
    const isCurrentMonth = year === now.getUTCFullYear() && monthNum === now.getUTCMonth() + 1;
    const endDate = isCurrentMonth ? (today < startDate ? startDate : today) : monthEndDate;

    const daysInMonth = monthEndDate.getDate();
    return { startDate, endDate, daysInMonth };
}

/**
 * Obtiene la fecha de un día específico del mes
 */
export function getDateForDay(month: string, day: number): Date {
    const [year, monthNum] = month.split("-").map(Number);
    return new Date(Date.UTC(year, monthNum - 1, day, 0, 0, 0, 0));
}

/**
 * Helper: Construye filtro de tickets por fecha usando businessDate (prioridad) o createdAt (fallback)
 * FIX: Usa businessDate si existe, fallback a createdAt para tickets antiguos sin businessDate
 */
/**
 * Construye filtro de fecha para tickets
 * @param date - Date que representa un día en CR (ej: Date.UTC(2025, 0, 19) = 19 de enero 2025 en CR)
 * @returns Filtro Prisma que busca tickets por businessDate o createdAt (convertido a CR)
 * 
 * CRÍTICO: date debe representar un día calendario en CR, no en UTC
 * Para createdAt: 00:00 CR = 06:00 UTC, entonces filtramos desde 06:00 UTC hasta 05:59:59.999 UTC del día siguiente
 */
export function buildTicketDateFilter(date: Date): any {
    // date representa un día calendario en CR (ej: Date.UTC(2025, 0, 19) = 19 enero 2025 en CR)
    // Extraer año, mes, día en UTC (que representan el día en CR)
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();

    // businessDate se guarda como fecha sin hora (00:00:00 UTC del día)
    const businessDateStart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));

    // createdAt está en UTC, pero representa horas en CR
    // 00:00 CR = 06:00 UTC del mismo día calendario
    // 23:59:59.999 CR = 05:59:59.999 UTC del día siguiente
    // ⚠️ CRÍTICO: Usar límite exclusivo para excluir el inicio del día siguiente
    // Para un día específico: desde 06:00 UTC hasta (pero no incluyendo) 06:00 UTC del día siguiente
    const createdAtStart = new Date(Date.UTC(year, month, day, 6, 0, 0, 0)); // 00:00 CR
    const createdAtEndExclusive = new Date(Date.UTC(year, month, day + 1, 6, 0, 0, 0)); // 00:00 CR del día siguiente (exclusivo)

    return {
        OR: [
            // Prioridad: businessDate (fecha de negocio correcta)
            { businessDate: businessDateStart },
            // Fallback: createdAt para tickets antiguos sin businessDate
            // ⚠️ CRÍTICO: Usar `lt` (less than) en lugar de `lte` para excluir el inicio del día siguiente
            // Convertir rango de CR a UTC: 00:00 CR hasta (pero no incluyendo) 00:00 CR del día siguiente
            // = 06:00 UTC hasta (pero no incluyendo) 06:00 UTC del día siguiente
            {
                businessDate: null,
                createdAt: {
                    gte: createdAtStart,
                    lt: createdAtEndExclusive, // ⚠️ CRÍTICO: Exclusivo para no incluir datos del día siguiente
                },
            },
        ],
    };
}
