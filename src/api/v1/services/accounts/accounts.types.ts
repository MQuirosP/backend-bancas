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
    dimension: "banca" | "ventana" | "vendedor"; // ✅ NUEVO: Agregado 'banca'
    ventanaId?: string;
    vendedorId?: string;
    bancaId?: string; // ✅ NUEVO: Filtro opcional por banca (puede combinarse con ventanaId/vendedorId)
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
    sorteoAccumulated?: number;   // ✅ NUEVO: Acumulado progresivo de sorteos dentro del día
}

/**
 * Desglose por banca (cuando hay agrupación por banca)
 * ✅ NUEVO: Incluye byVentana y byVendedor específicos de esta banca
 */
export interface BancaBreakdown {
    bancaId: string;
    bancaName: string;
    bancaCode?: string | null;
    totalSales: number;
    totalPayouts: number;
    listeroCommission: number;
    vendedorCommission: number;
    balance: number;              // sales - payouts - commissions
    remainingBalance: number;     // balance - totalCollected + totalPaid
    totalPaid?: number;          // Opcional: pagos aplicados
    totalCollected?: number;     // Opcional: cobros aplicados
    ticketCount?: number;        // Opcional: cantidad de tickets
    // ✅ CRÍTICO: Desglose por listero para ESTA banca específica
    byVentana?: VentanaBreakdown[];
    // ✅ CRÍTICO: Desglose por vendedor para ESTA banca específica
    byVendedor?: VendedorBreakdown[];
    // ✅ CRÍTICO: Movimientos específicos de esta banca (NO agrupados con otras bancas)
    movements?: any[];            // AccountPaymentHistoryItem[]
}

/**
 * Desglose por ventana (cuando hay agrupación)
 * ✅ CRÍTICO: Incluye bySorteo y movements específicos de esta ventana
 */
export interface VentanaBreakdown {
    ventanaId: string;
    ventanaName: string;
    ventanaCode?: string | null; // ✅ NUEVO: Código de ventana
    bancaId?: string | null;     // ✅ NUEVO: ID de banca (si está disponible)
    bancaName?: string | null;   // ✅ NUEVO: Nombre de banca (si está disponible)
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
    bancaId?: string | null;      // ✅ NUEVO: Solo si dimension='banca' o si hay filtro por banca
    bancaName?: string | null;    // ✅ NUEVO
    bancaCode?: string | null;    // ✅ NUEVO
    ventanaId: string | null;
    ventanaName: string | null;
    ventanaCode?: string | null;  // ✅ NUEVO: Código de ventana
    vendedorId: string | null;
    vendedorName: string | null;
    vendedorCode?: string | null; // ✅ NUEVO: Código de vendedor
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
    byBanca?: BancaBreakdown[];   // ✅ NUEVO: Solo cuando bancaId es null y dimension='banca'
    byVentana?: VentanaBreakdown[];
    byVendedor?: VendedorBreakdown[];
    // ✅ NUEVO: Flag para lazy loading de bySorteo
    hasSorteos?: boolean;          // Indica si hay sorteos disponibles (para lazy loading)
    bySorteo?: any[] | null;      // Sorteos intercalados con movimientos (null si lazy loading activo)
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
        dimension: "banca" | "ventana" | "vendedor"; // ✅ NUEVO: Agregado 'banca'
        totalDays: number;
        monthStartDate: string;             // Siempre primer día del mes (YYYY-MM-01)
        monthEndDate: string;               // Siempre último día del mes
    };
}
