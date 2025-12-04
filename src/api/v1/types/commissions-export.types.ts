// src/api/v1/types/commissions-export.types.ts

/**
 * Formato de exportación
 */
export type ExportFormat = 'csv' | 'excel' | 'pdf';

/**
 * Datos de comisión para exportación
 */
export interface CommissionExportData {
  date: string; // YYYY-MM-DD
  ventanaId?: string;
  ventanaName?: string;
  vendedorId?: string;
  vendedorName?: string;
  totalSales: number;
  totalTickets: number;
  totalCommission: number;
  totalPayouts: number;
  commissionListero?: number;
  commissionVendedor?: number;
  net?: number;
}

/**
 * Breakdown por lotería, sorteo y multiplicador
 */
export interface CommissionBreakdownItem {
  date: string; // YYYY-MM-DD
  ventanaName?: string;
  vendedorName?: string;
  loteriaName: string;
  sorteoTime: string;
  multiplierName: string;
  totalSales: number;
  commission: number;
  commissionPercent: number;
  ticketsCount: number;
}

/**
 * Advertencias/warnings detectados
 */
export interface CommissionWarning {
  type: 'missing_policy' | 'exclusion' | 'inconsistency';
  description: string;
  affectedEntity: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * Datos completos para exportación
 */
export interface CommissionExportPayload {
  // Datos principales
  summary: CommissionExportData[];

  // Breakdown detallado (opcional)
  breakdown?: CommissionBreakdownItem[];

  // Advertencias (opcional)
  warnings?: CommissionWarning[];

  // Metadata
  metadata: {
    generatedAt: Date;
    timezone: string;
    dateRange: {
      from: string; // YYYY-MM-DD
      to: string;   // YYYY-MM-DD
    };
    filters: {
      scope: string;
      dimension: string;
      ventanaId?: string;
      vendedorId?: string;
      ventanaName?: string;
      vendedorName?: string;
    };
    totals: {
      totalSales: number;
      totalTickets: number;
      totalCommission: number;
      totalPayouts: number;
      commissionListero?: number;
      commissionVendedor?: number;
      net?: number;
    };
  };
}

/**
 * Opciones de exportación
 */
export interface ExportOptions {
  format: ExportFormat;
  includeBreakdown: boolean;
  includeWarnings: boolean;
  filename?: string;
}
