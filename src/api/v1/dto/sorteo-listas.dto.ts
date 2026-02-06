export interface ExcludeListaDTO {
  ventanaId: string;
  vendedorId?: string | null; // NULL = excluir listero completo
  multiplierId?: string | null; // NULL = todos los multiplicadores
  reason?: string;
}

export interface IncludeListaDTO {
  ventanaId: string;
  vendedorId?: string | null;
  multiplierId?: string | null;
}

export type ListaMode = 'full' | 'compact';

export interface MultiplierTotalSummary {
  multiplierId: string | null;
  multiplierName: string | null;
  multiplierValue: number | null;
  totalSales: number;
  totalCommission: number;
  totalTickets: number;
  totalExcluded: number;
}

export interface CompactListeroSummary {
  ventanaId: string;
  ventanaName: string;
  ventanaCode: string;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  totalExcluded: number;
  totalsByMultiplier: MultiplierTotalSummary[];
}

export interface ListaExclusionResponse {
  id: string;
  sorteoId: string;
  sorteoName: string;
  loteriaId: string;
  loteriaName: string;
  ventanaId: string;
  ventanaName: string;
  ventanaCode: string;
  vendedorId: string | null;
  vendedorName: string | null;
  vendedorCode: string | null;
  multiplierId: string | null;
  multiplierName: string | null;
  multiplierValue: number | null;
  totalJugadas: number;
  totalAmount: number;
  excludedAt: string | null;
  excludedBy: string | null;
  excludedByName: string | null;
  reason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ListaExclusionFilters {
  sorteoId?: string;
  ventanaId?: string;
  vendedorId?: string;
  multiplierId?: string;
  fromDate?: string;
  toDate?: string;
  loteriaId?: string;
}

export interface ExcludeIncludeResponse {
  id: string;
  sorteoId: string;
  ventanaId: string;
  vendedorId: string | null;
  multiplierId: string | null;
  excludedAt: string;
  excludedBy: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

//  NUEVO: Estructura agrupada por ventana
export interface VendedorSummary {
  vendedorId: string | null;
  vendedorName: string | null;
  vendedorCode: string | null;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  //  NUEVO: Commission breakdown por tipo de jugada
  commissionByNumber: number;
  commissionByReventado: number;
  isExcluded: boolean;
  exclusionId: string | null;
  exclusionReason: string | null;
  excludedAt: string | null;
  excludedBy: string | null;
  excludedByName: string | null;
  //  NUEVO: Multiplier info if specific exclusion exists
  multiplierId?: string | null;
  multiplierName?: string | null;
  multiplierValue?: number | null; // Renamed from multiplierValueX for FE compatibility
}

export interface ListeroSummary {
  ventanaId: string;
  ventanaName: string;
  ventanaCode: string;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  //  NUEVO: Commission breakdown por tipo de jugada
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
  listerosCompact?: CompactListeroSummary[];
  mode?: ListaMode;
  meta: {
    totalSales: number;
    totalTickets: number;
    totalCommission: number;
    totalExcluded: number;
  };
  refreshedAt?: string;
}

//  LEGACY: Mantener para compatibilidad (deprecated)
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
