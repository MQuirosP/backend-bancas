import { Role } from "@prisma/client";

/**
 * Filtros para queries de accounts
 */
export interface AccountsFilters {
    month?: string; // YYYY-MM (opcional si se usa date)
    // ✅ NUEVO: Filtros de período
    date?: "today" | "yesterday" | "week" | "month" | "year" | "range";
    fromDate?: string; // YYYY-MM-DD (requerido si date='range')
    toDate?: string; // YYYY-MM-DD (requerido si date='range')
    scope: "mine" | "ventana" | "all";
    dimension: "ventana" | "vendedor";
    ventanaId?: string;
    vendedorId?: string;
    bancaId?: string; // Para ADMIN multibanca
    sort?: "asc" | "desc";
    userRole?: "ADMIN" | "VENTANA" | "VENDEDOR"; // ✅ CRÍTICO: Rol del usuario para calcular balance correctamente
}

export interface DayStatement {
    id: string;
    date: Date;
    month: string;
    ventanaId: string | null;
    vendedorId: string | null;
    totalSales: number;
    totalPayouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    totalPaid: number;
    totalCollected: number;
    totalPaymentsCollections: number;
    remainingBalance: number;
    isSettled: boolean;
    canEdit: boolean;
    ticketCount: number;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Totales del período (para totals) o del mes (para monthlyAccumulated)
 */
export interface StatementTotals {
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission?: number;        // Opcional en response
    totalVendedorCommission?: number;       // Opcional en response
    totalBalance: number;
    totalPaid: number;
    totalCollected: number;
    totalRemainingBalance: number;
    settledDays: number;
    pendingDays: number;
}

/**
 * Response de /api/v1/accounts/statement
 * Retorna:
 * - statements: Statements del período filtrado
 * - totals: Totales del período filtrado (cambian según filtro)
 * - monthlyAccumulated: Totales del mes completo (inmutable respecto a período)
 * - meta: Información del período y mes
 */
export interface StatementResponse {
    statements: DayStatement[];
    totals: StatementTotals;                // Período seleccionado
    monthlyAccumulated: StatementTotals;    // ✅ NUEVO: Acumulado del mes completo
    meta: {
        month: string;                      // Mes del período
        startDate: string;                  // Inicio del período filtrado
        endDate: string;                    // Fin del período filtrado
        dimension: "ventana" | "vendedor";
        totalDays: number;
        monthStartDate: string;             // Siempre primer día del mes (YYYY-MM-01)
        monthEndDate: string;               // Siempre último día del mes
    };
}
