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
