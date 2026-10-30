import { Role } from "../../generated/prisma/client";

export interface DashboardFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string; // Para RBAC
  vendedorId?: string; // Filtro global por vendedor
  bancaId?: string; // Para filtrar por banca activa (ADMIN multibanca)
  loteriaId?: string; // Filtro por lotería
  betType?: 'NUMERO' | 'REVENTADO'; // Filtro por tipo de apuesta
  status?: string; // Filtro por estado del sorteo (OPEN, EVALUATED, CLOSED)
  scope?: 'all' | 'byVentana';
  dimension?: 'ventana' | 'loteria' | 'vendedor'; // Agrupación
  top?: number; // Limitar resultados
  orderBy?: string; // Campo para ordenar
  order?: 'asc' | 'desc'; // Dirección
  page?: number; // Paginación
  pageSize?: number; // Tamaño de página
  interval?: 'day' | 'hour' | 'week' | 'month'; // Para timeseries
  aging?: boolean; // Para CxC aging
  compare?: boolean; // Para comparación con período anterior
  cxcDimension?: 'ventana' | 'vendedor'; // Dimensión para CxC/CxP (default: 'ventana')
}

export interface GananciaResult {
  totalAmount: number; // comisiones totales (usuario + ventana)
  totalSales: number;
  totalPayouts: number;
  totalNet: number;
  margin: number;
  commissionUserTotal: number;
  commissionVentanaTotal: number;
  byVentana: Array<{
    ventanaId: string;
    ventanaName: string;
    sales: number;
    amount: number; // comisiones totales
    commissions: number;
    commissionUser: number;
    commissionVentana: number;
    payout: number;
    net: number;
    margin: number;
    tickets: number;
    winners: number;
    winRate: number;
    isActive: boolean;
    periodBalance: number; // Saldo del periodo filtrado
  }>;
  byLoteria: Array<{
    loteriaId: string;
    loteriaName: string;
    sales: number;
    amount: number; // comisiones totales
    commissions: number;
    commissionUser: number;
    commissionVentana: number;
    payout: number;
    net: number;
    margin: number;
    tickets: number;
    winners: number;
    isActive: boolean;
  }>;
}

export interface CxCResult {
  totalAmount: number;
  byVentana?: Array<{
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    amount: number; // saldo positivo (CxC)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; // Saldo a Hoy
    };
    isActive: boolean;
  }>;
  byVendedor?: Array<{
    vendedorId: string;
    vendedorName: string;
    vendedorCode?: string;
    ventanaId?: string;
    ventanaName?: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    amount: number; // saldo positivo (CxC)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; // Saldo a Hoy
    };
    isActive: boolean;
  }>;
}

export interface CxPResult {
  totalAmount: number;
  byVentana?: Array<{
    ventanaId: string;
    ventanaName: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    totalPaidToVentana: number;
    amount: number; // saldo positivo (CxP)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; // Saldo a Hoy
    };
    isActive: boolean;
  }>;
  byVendedor?: Array<{
    vendedorId: string;
    vendedorName: string;
    vendedorCode?: string;
    ventanaId?: string;
    ventanaName?: string;
    totalSales: number;
    totalPayouts: number;
    totalListeroCommission: number;
    totalVendedorCommission: number;
    totalPaid: number;
    totalPaidOut: number;
    totalCollected: number;
    totalPaidToCustomer: number;
    totalPaidToVentana: number;
    amount: number; // saldo positivo (CxP)
    remainingBalance: number; // Período filtrado
    monthlyAccumulated: {
      remainingBalance: number; // Saldo a Hoy
    };
    isActive: boolean;
  }>;
}

export interface DashboardSummary {
  totalSales: number;
  totalPayouts: number;
  totalCommissions: number;
  commissionUser: number;
  commissionVentana: number;
  commissionVentanaTotal: number; // Alias para compatibilidad con frontend
  gananciaListeros?: number; // Ganancia neta de listeros (commissionVentana - commissionUser)
  gananciaBanca?: number; // Alias conceptual para net
  totalTickets: number;
  winningTickets: number;
  net: number;
  margin: number; // Margen neto con máximo 2 decimales (toFixed(2))
  winRate: number; // Tasa de ganancia con máximo 2 decimales (toFixed(2))
}
