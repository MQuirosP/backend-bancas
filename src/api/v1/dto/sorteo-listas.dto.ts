export interface ExcludeListaDTO {
  ventanaId: string;
  vendedorId?: string | null; // NULL = excluir listero completo
  reason?: string;
}

export interface IncludeListaDTO {
  ventanaId: string;
  vendedorId?: string | null;
}

export interface ListaExclusionResponse {
  id: string;
  sorteoId: string;
  ventanaId: string;
  vendedorId: string | null;
  excludedAt: string;
  excludedBy: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ✅ NUEVO: Estructura agrupada por ventana
export interface VendedorSummary {
  vendedorId: string | null;
  vendedorName: string | null;
  vendedorCode: string | null;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  // ✅ NUEVO: Commission breakdown por tipo de jugada
  commissionByNumber: number;
  commissionByReventado: number;
  isExcluded: boolean;
  exclusionId: string | null;
  exclusionReason: string | null;
  excludedAt: string | null;
  excludedBy: string | null;
  excludedByName: string | null;
}

export interface ListeroSummary {
  ventanaId: string;
  ventanaName: string;
  ventanaCode: string;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  // ✅ NUEVO: Commission breakdown por tipo de jugada
  commissionByNumber: number;
  commissionByReventado: number;
  isExcluded: boolean;
  exclusionId: string | null;
  exclusionReason: string | null;
  excludedAt: string | null;
  excludedBy: string | null;
  excludedByName: string | null;
  vendedores: VendedorSummary[];
}

export interface SorteoInfo {
  id: string;
  name: string;
  status: string;
  scheduledAt: string;
  winningNumber: string | null;
  loteria: {
    id: string;
    name: string;
  };
}

export interface ListasResponse {
  sorteo: SorteoInfo;
  listeros: ListeroSummary[];
  meta: {
    totalSales: number;
    totalTickets: number;
    totalCommission: number;
    totalExcluded: number;
  };
}

// ✅ LEGACY: Mantener para compatibilidad (deprecated)
export interface ListaSummaryItem {
  ventanaId: string;
  ventanaName: string;
  ventanaCode: string;
  vendedorId: string | null;
  vendedorName: string | null;
  vendedorCode: string | null;
  totalSales: number;
  ticketCount: number;
  isExcluded: boolean;
  exclusionId: string | null;
  exclusionReason: string | null;
  excludedAt: string | null;
  excludedBy: string | null;
  excludedByName: string | null;
}
