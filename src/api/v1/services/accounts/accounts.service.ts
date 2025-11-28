import { AccountsFilters } from "./accounts.types";
import { resolveDateRange } from "../../../../utils/dateRange";
import { getMonthDateRange, toCRDateString } from "./accounts.dates.utils";
import { getDailySummariesFromMaterializedView, getMovementsForDay } from "./accounts.queries";
import { getStatementDirect, calculateDayStatement } from "./accounts.calculations";
import { registerPayment, reversePayment, deleteStatement } from "./accounts.movements";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";

/**
 * Accounts Service
 * Proporciona endpoints para consultar y gestionar estados de cuenta
 * Refactorizado para usar módulos especializados
 */
export const AccountsService = {
    /**
     * Obtiene el estado de cuenta día a día del mes o período
     */
    async getStatement(filters: AccountsFilters) {
        const { month, date, fromDate, toDate, dimension, ventanaId, vendedorId, bancaId, sort = "desc" } = filters;

        // ✅ NUEVO: Resolver rango de fechas según filtros proporcionados
        // Prioridad: date > month > mes actual por defecto
        let startDate: Date;
        let endDate: Date;
        let daysInMonth: number;
        let effectiveMonth: string;

        if (date) {
            // Usar filtros de período (date, fromDate, toDate)
            try {
                const dateRange = resolveDateRange(date, fromDate, toDate);
                startDate = dateRange.fromAt;
                endDate = dateRange.toAt;
            } catch (e) {
                // Fallback simple si resolveDateRange no está disponible
                const now = new Date();
                startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
                endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
            }

            // Calcular días en el rango
            const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
            daysInMonth = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
            // Usar el mes del inicio del rango para compatibilidad
            effectiveMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
        } else if (month) {
            // Usar filtro de mes (comportamiento existente)
            const monthRange = getMonthDateRange(month);
            startDate = monthRange.startDate;
            endDate = monthRange.endDate;
            daysInMonth = monthRange.daysInMonth;
            effectiveMonth = month;
        } else {
            // Por defecto: mes actual
            const today = new Date();
            const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
            const monthRange = getMonthDateRange(currentMonth);
            startDate = monthRange.startDate;
            endDate = monthRange.endDate;
            daysInMonth = monthRange.daysInMonth;
            effectiveMonth = currentMonth;
        }

        // ✅ OPTIMIZACIÓN: Intentar leer de la vista materializada primero (MUY RÁPIDO)
        const materializedSummaries = await getDailySummariesFromMaterializedView(
            startDate,
            endDate,
            dimension,
            ventanaId,
            vendedorId,
            sort as "asc" | "desc"
        );

        // ✅ CRÍTICO: Calcular TODO directamente desde tickets/jugadas (sin AccountStatement)
        return await getStatementDirect(
            filters,
            startDate,
            endDate,
            daysInMonth,
            effectiveMonth,
            dimension,
            ventanaId,
            vendedorId,
            bancaId,
            filters.userRole || "ADMIN",
            sort as "asc" | "desc"
        );
    },

    /**
     * Obtiene el estado de cuenta de un día específico
     * (Wrapper para calculateDayStatement)
     */
    getDayStatement: calculateDayStatement,

    /**
     * Registra un pago o cobro
     */
    createPayment: registerPayment, // Alias para compatibilidad
    registerPayment,

    /**
     * Revierte un pago o cobro
     */
    reversePayment,

    /**
     * Obtiene el historial de pagos de un statement
     * Mantiene compatibilidad con la firma anterior: (date: Date, filters: AccountsFilters)
     */
    async getPaymentHistory(date: any, filters: any) {
        // Si el primer argumento es string, asumir que es statementId (uso interno nuevo)
        if (typeof date === 'string' && !date.includes('-')) {
            return getMovementsForDay(date);
        }

        // Si es fecha y filtros (uso legacy del controller)
        let targetDate: Date;
        if (typeof date === 'string') {
            // Parse date string in format YYYY-MM-DD
            // This represents a day in Costa Rica timezone
            const [year, month, day] = date.split('-').map(Number);
            targetDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
        } else {
            targetDate = date;
        }

        const { ventanaId, vendedorId } = filters;

        // Buscar el statement correspondiente
        const statement = await AccountStatementRepository.findByDate(targetDate, {
            ventanaId,
            vendedorId,
        });

        if (!statement) {
            return [];
        }

        return getMovementsForDay(statement.id);
    },

    /**
     * Elimina un estado de cuenta
     */
    deleteStatement,
};
