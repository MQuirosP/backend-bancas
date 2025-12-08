// src/api/v1/types/accounts-export.types.ts

/**
 * Formato de exportación
 */
export type ExportFormat = 'csv' | 'excel' | 'pdf';

/**
 * Desglose por ventana para exportación (cuando hay agrupación)
 */
export interface AccountStatementVentanaBreakdownExport {
  ventanaId: string;
  ventanaName: string;
  ventanaCode?: string | null;
  totalSales: number;
  totalPayouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  balance: number;
  totalPaid: number;
  totalCollected: number;
  totalPaymentsCollections: number;
  remainingBalance: number;
  ticketCount: number;
  // ✅ NUEVO: Desglose por sorteo de esta ventana
  bySorteo?: AccountStatementSorteoItem[];
  // ✅ NUEVO: Movimientos de esta ventana
  movements?: AccountMovementItem[];
}

/**
 * Desglose por vendedor para exportación (cuando hay agrupación)
 */
export interface AccountStatementVendedorBreakdownExport {
  vendedorId: string;
  vendedorName: string;
  vendedorCode?: string | null;
  ventanaId: string;
  ventanaName: string;
  ventanaCode?: string | null;
  totalSales: number;
  totalPayouts: number;
  listeroCommission: number;
  vendedorCommission: number;
  balance: number;
  totalPaid: number;
  totalCollected: number;
  totalPaymentsCollections: number;
  remainingBalance: number;
  ticketCount: number;
  // ✅ NUEVO: Desglose por sorteo de este vendedor
  bySorteo?: AccountStatementSorteoItem[];
  // ✅ NUEVO: Movimientos de este vendedor
  movements?: AccountMovementItem[];
}

/**
 * Item de estado de cuenta para exportación (resumen por día)
 */
export interface AccountStatementExportItem {
  id: string;
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
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
  totalPaymentsCollections: number; // ✅ NUEVO: totalPaid + totalCollected
  remainingBalance: number; // Puede ser negativo

  // Estado y metadata
  isSettled: boolean;
  canEdit: boolean;
  ticketCount: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601

  // ✅ NUEVO: Desglose por entidad (cuando hay agrupación)
  byVentana?: AccountStatementVentanaBreakdownExport[];
  byVendedor?: AccountStatementVendedorBreakdownExport[];
  
  // ✅ NUEVO: Desglose por sorteo del statement principal (cuando NO hay agrupación)
  bySorteo?: AccountStatementSorteoItem[];
  
  // ✅ NUEVO: Movimientos del statement principal (cuando NO hay agrupación)
  movements?: AccountMovementItem[];
}

/**
 * Item de desglose por sorteo
 */
export interface AccountStatementSorteoItem {
  date: string; // YYYY-MM-DD
  sorteoId: string; // ✅ NUEVO
  sorteoName: string; // ✅ NUEVO
  loteriaId: string; // ✅ NUEVO
  loteriaName: string;
  scheduledAt: string; // ✅ NUEVO: ISO 8601 completo
  sorteoTime: string; // HH:MM AM/PM
  ventanaId?: string | null; // ✅ NUEVO
  ventanaName?: string | null;
  ventanaCode?: string | null; // ✅ NUEVO
  vendedorId?: string | null; // ✅ NUEVO
  vendedorName?: string | null;
  vendedorCode?: string | null; // ✅ NUEVO
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
  id: string; // ✅ NUEVO
  movementDate: Date; // Fecha del movimiento
  statementDate: string; // YYYY-MM-DD - Fecha a la que se aplicó
  accountStatementId: string; // ✅ NUEVO
  ventanaId?: string | null; // ✅ NUEVO
  ventanaName?: string | null;
  ventanaCode?: string | null; // ✅ NUEVO
  vendedorId?: string | null; // ✅ NUEVO
  vendedorName?: string | null;
  vendedorCode?: string | null; // ✅ NUEVO
  type: 'PAGO' | 'COBRO';
  amount: number;
  method: string; // "Efectivo", "Transferencia", etc.
  notes?: string | null;
  registeredBy: string; // Nombre del usuario
  registeredById?: string | null; // ✅ NUEVO
  status: 'ACTIVO' | 'REVERTIDO';
  isFinal: boolean; // ✅ NUEVO
  isReversed: boolean; // ✅ NUEVO
  reversedAt?: Date | null; // ✅ NUEVO
  reversedBy?: string | null; // ✅ NUEVO: Nombre del usuario que revirtió
  reversedById?: string | null; // ✅ NUEVO
  createdAt: Date; // ✅ NUEVO
  updatedAt: Date; // ✅ NUEVO
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
      bancaId?: string;
      bancaName?: string;
      ventanaId?: string;
      ventanaName?: string;
      vendedorId?: string;
      vendedorName?: string;
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
