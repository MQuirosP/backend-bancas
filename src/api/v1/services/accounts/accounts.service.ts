import { AccountsFilters } from "./accounts.types";
import { resolveDateRange } from "../../../../utils/dateRange";
import { getMonthDateRange, toCRDateString } from "./accounts.dates.utils";
import { getDailySummariesFromMaterializedView, getMovementsForDay } from "./accounts.queries";
import { getStatementDirect, calculateDayStatement } from "./accounts.calculations";
import { registerPayment, reversePayment, deleteStatement } from "./accounts.movements";
import { AccountStatementRepository } from "../../../../repositories/accountStatement.repository";
import prisma from "../../../../core/prismaClient";

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

    /**
     * Obtiene el balance acumulado actual de una ventana
     * Balance = ventas - premios - comisiones + comisiones propias - pagos realizados
     * Sin filtro de fecha (acumulado desde el inicio hasta HOY)
     */
    async getCurrentBalance(ventanaId: string) {
        const today = new Date();
        // Establecer rango desde el inicio del tiempo hasta hoy
        const startDate = new Date(Date.UTC(2020, 0, 1)); // Fecha arbitraria en el pasado
        const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));

        // Obtener información de la ventana
        const ventana = await prisma.ventana.findUnique({
            where: { id: ventanaId },
            select: { id: true, name: true },
        });

        if (!ventana) {
            throw new Error("Ventana no encontrada");
        }

        // Usar la misma lógica que getStatementDirect para calcular el balance
        // Calcular balance acumulado directamente desde tickets/jugadas
        const startDateCRStr = toCRDateString(startDate);
        const endDateCRStr = toCRDateString(endDate);

        // Construir query SQL para obtener totales acumulados
        // IMPORTANTE: Calcular sales y commissions desde jugadas (suma de todas)
        // Pero payouts debe ser la suma de totalPayout de tickets únicos (no duplicar por jugada)
        const salesAndCommissions = await prisma.$queryRaw<Array<{
            total_sales: number;
            listero_commission: number;
            vendedor_commission: number;
        }>>`
            SELECT
                COALESCE(SUM(j.amount), 0) as total_sales,
                COALESCE(SUM(j."listeroCommissionAmount"), 0) as listero_commission,
                COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0) as vendedor_commission
            FROM "Ticket" t
            INNER JOIN "Jugada" j ON j."ticketId" = t.id
            WHERE t."ventanaId" = ${ventanaId}::uuid
            AND t."deletedAt" IS NULL
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
            AND j."deletedAt" IS NULL
            AND COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) <= ${endDateCRStr}::date
        `;

        // Calcular payouts desde tickets (no desde jugadas para evitar duplicar)
        const payoutsResult = await prisma.$queryRaw<Array<{
            total_payouts: number;
        }>>`
            SELECT
                COALESCE(SUM(t."totalPayout"), 0) as total_payouts
            FROM "Ticket" t
            WHERE t."ventanaId" = ${ventanaId}::uuid
            AND t."deletedAt" IS NULL
            AND t.status IN ('ACTIVE', 'EVALUATED', 'PAID')
            AND COALESCE(
                t."businessDate",
                DATE((t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica'))
            ) <= ${endDateCRStr}::date
        `;

        const totalSales = Number(salesAndCommissions[0]?.total_sales || 0);
        const totalPayouts = Number(payoutsResult[0]?.total_payouts || 0);
        const listeroCommission = Number(salesAndCommissions[0]?.listero_commission || 0);

        // Balance = ventas - premios - comisión listero (dimensión ventana)
        const balance = totalSales - totalPayouts - listeroCommission;

        // Obtener pagos y cobros acumulados usando Prisma ORM (igual que AccountPaymentRepository)
        const payments = await prisma.accountPayment.findMany({
            where: {
                ventanaId: ventanaId,
                isReversed: false,
                date: {
                    lte: endDate,
                },
            },
            select: {
                type: true,
                amount: true,
            },
        });

        // Calcular totales
        const totalPaid = payments
            .filter(p => p.type === "payment")
            .reduce((sum, p) => sum + p.amount, 0);
        const totalCollected = payments
            .filter(p => p.type === "collection")
            .reduce((sum, p) => sum + p.amount, 0);

        // remainingBalance = balance - totalCollected + totalPaid
        const remainingBalance = balance - totalCollected + totalPaid;

        return {
            balance,
            remainingBalance,
            ventanaId: ventana.id,
            ventanaName: ventana.name,
            updatedAt: new Date().toISOString(),
        };
    },
};
