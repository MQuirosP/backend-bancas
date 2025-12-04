// src/api/v1/types/accounts-export.types.ts

/**
 * Formato de exportación
 */
export type ExportFormat = 'csv' | 'excel' | 'pdf';

/**
 * Item de estado de cuenta para exportación (resumen por día)
 */
export interface AccountStatementExportItem {
  date: string; // YYYY-MM-DD
  ventanaId?: string | null;
  ventanaName?: string | null;
  ventanaCode?: string | null;
  vendedorId?: string | null;
  vendedorName?: string | null;
  vendedorCode?: string | null;

  // Totales del día
  totalSales: number;
  totalPayouts: number;
  listeroCommission: number;
  vendedorCommission: number;

  // Balance y movimientos
  balance: number; // Puede ser negativo
  totalPaid: number;
  totalCollected: number;
  remainingBalance: number; // Puede ser negativo

  // Estado y metadata
  isSettled: boolean;
  canEdit: boolean;
  ticketCount: number;
}

/**
 * Item de desglose por sorteo
 */
export interface AccountStatementSorteoItem {
  date: string; // YYYY-MM-DD
  ventanaName?: string | null;
  vendedorName?: string | null;
  loteriaName: string;
  sorteoTime: string; // HH:MM AM/PM
  totalSales: number;
  totalPayouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  balance: number;
  ticketCount: number;
}

/**
 * Item de movimiento de pago/cobro
 */
export interface AccountMovementItem {
  movementDate: Date; // Fecha del movimiento
  statementDate: string; // YYYY-MM-DD - Fecha a la que se aplicó
  ventanaName?: string | null;
  vendedorName?: string | null;
  type: 'PAGO' | 'COBRO';
  amount: number;
  method: string; // "Efectivo", "Transferencia", etc.
  notes?: string | null;
  registeredBy: string; // Nombre del usuario
  status: 'ACTIVO' | 'REVERTIDO';
}

/**
 * Totales del período o mes
 */
export interface AccountStatementTotals {
  totalSales: number;
  totalPayouts: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  totalBalance: number;
  totalPaid: number;
  totalCollected: number;
  totalRemainingBalance: number;
  settledDays: number;
  pendingDays: number;
}

/**
 * Payload completo para exportación
 */
export interface AccountStatementExportPayload {
  // Datos principales
  statements: AccountStatementExportItem[];

  // Desglose por sorteo (opcional)
  breakdown?: AccountStatementSorteoItem[];

  // Movimientos de pago/cobro (opcional)
  movements?: AccountMovementItem[];

  // Totales
  totals: AccountStatementTotals; // Totales del período filtrado
  monthlyAccumulated?: AccountStatementTotals; // Saldo a Hoy (acumulado del mes)

  // Metadata
  metadata: {
    generatedAt: Date;
    timezone: string; // America/Costa_Rica
    month: string; // YYYY-MM
    startDate: string; // YYYY-MM-DD - inicio del período filtrado
    endDate: string; // YYYY-MM-DD - fin del período filtrado
    monthStartDate: string; // YYYY-MM-01 - siempre primer día del mes
    monthEndDate: string; // YYYY-MM-DD - último día del mes
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      ventanaName?: string;
      vendedorId?: string;
      vendedorName?: string;
      bancaId?: string;
    };
    totalDays: number;
  };
}

/**
 * Opciones de exportación
 */
export interface AccountStatementExportOptions {
  format: ExportFormat;
  includeBreakdown: boolean;
  includeMovements: boolean;
  filename?: string;
}
