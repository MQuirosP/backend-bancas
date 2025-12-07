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

/**
 * Desglose por sorteo (usado en byVentana y byVendedor)
 */
export interface SorteoBreakdownItem {
    sorteoId: string;
    sorteoName: string;
    loteriaId: string;
    loteriaName: string;
    scheduledAt: string;          // ISO 8601
    sales: number;
    payouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;
    ticketCount: number;
}

/**
 * Desglose por ventana (cuando hay agrupación)
 * ✅ CRÍTICO: Incluye bySorteo y movements específicos de esta ventana
 */
export interface VentanaBreakdown {
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;              // sales - payouts - commissions
    remainingBalance: number;     // balance - totalCollected + totalPaid
    totalPaid?: number;          // Opcional: pagos aplicados
    totalCollected?: number;     // Opcional: cobros aplicados
    ticketCount?: number;        // Opcional: cantidad de tickets
    // ✅ CRÍTICO: Sorteos específicos de esta ventana (NO agrupados con otras ventanas)
    bySorteo?: SorteoBreakdownItem[];
    // ✅ CRÍTICO: Movimientos específicos de esta ventana (NO agrupados con otras ventanas)
    movements?: any[];            // AccountPaymentHistoryItem[]
}

/**
 * Desglose por vendedor (cuando hay agrupación)
 * ✅ CRÍTICO: Incluye bySorteo y movements específicos de este vendedor
 */
export interface VendedorBreakdown {
    vendedorId: string;
    vendedorName: string;
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;              // sales - payouts - commissions
    remainingBalance: number;     // balance - totalCollected + totalPaid
    totalPaid?: number;          // Opcional: pagos aplicados
    totalCollected?: number;     // Opcional: cobros aplicados
    ticketCount?: number;        // Opcional: cantidad de tickets
    // ✅ CRÍTICO: Sorteos específicos de este vendedor (NO agrupados con otros vendedores)
    bySorteo?: SorteoBreakdownItem[];
    // ✅ CRÍTICO: Movimientos específicos de este vendedor (NO agrupados con otros vendedores)
    movements?: any[];            // AccountPaymentHistoryItem[]
}

export interface DayStatement {
    id: string;
    date: Date;
    month: string;
    ventanaId: string | null;
    ventanaName: string | null;
    vendedorId: string | null;
    vendedorName: string | null;
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
    // ✅ NUEVO: Desglose por entidad (cuando hay agrupación)
    byVentana?: VentanaBreakdown[];
    byVendedor?: VendedorBreakdown[];
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
