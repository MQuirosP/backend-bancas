/**
 * Tipos para el módulo de Cierre Operativo
 */

export type LoteriaType = 'TICA' | 'PANAMA' | 'HONDURAS' | 'PRIMERA';
export type CierreScope = 'mine' | 'all';
// Vista del export: total, seller o un valor numérico de banda dinámico
export type CierreView = 'total' | 'seller' | string;

/**
 * Filtros para consultas de cierre
 */
export interface CierreFilters {
  fromDate: Date;
  toDate: Date;
  ventanaId?: string;
  scope: CierreScope;
  loteriaId?: string;
  vendedorId?: string;
}

/**
 * Métricas por celda (dimensión cruzada: lotería x banda x turno)
 */
export interface CeldaMetrics {
  totalVendida: number; // suma de jugada.amount
  ganado: number; // payout total
  comisionTotal: number; // suma de commissionAmount
  netoDespuesComision: number; // totalVendida - comisionTotal
  refuerzos: number; // placeholder (0 por ahora)
  ticketsCount: number;
  jugadasCount: number;
}

/**
 * Métricas por turno/hora (ej: "19:30")
 */
export interface TurnoMetrics extends CeldaMetrics {
  turno: string; // formato "HH:MM" o "HH:MMAM/PM"
}

/**
 * Métricas por lotería (agrega todos los turnos)
 */
export interface LoteriaMetrics {
  turnos: Record<string, TurnoMetrics>; // key: "19:30", "20:30", etc.
  subtotal: CeldaMetrics;
}

/**
 * Métricas por banda (agrega todas las loterías)
 */
export interface BandaMetrics {
  loterias: Record<LoteriaType, LoteriaMetrics>; // key: "TICA", "PANAMA", etc.
  total: CeldaMetrics;
}

/**
 * Métricas por vendedor (para reporte by-seller)
 */
export interface VendedorMetrics extends CeldaMetrics {
  vendedorId: string;
  vendedorNombre: string;
  ventanaId: string;
  ventanaNombre: string;
  bands?: Record<number, CeldaMetrics>; // desglose por banda (dinámico)
}

/**
 * Datos retornados por el servicio weekly (solo datos, sin meta)
 */
export interface CierreWeeklyData {
  totals: CeldaMetrics;
  bands: Record<string, BandaMetrics>; // Dinámico: key = banda (80, 85, 90, 92, 200, etc.)
}

/**
 * Datos retornados por el servicio by-seller (solo datos, sin meta)
 */
export interface CierreBySellerData {
  totals: CeldaMetrics;
  vendedores: VendedorMetrics[];
}

/**
 * Performance metrics para incluir en meta del controlador
 */
export interface CierrePerformance {
  queryExecutionTime: number;
  totalQueries: number;
}

/**
 * Ejemplo de anomalía (jugada sin multiplicador válido)
 */
export interface AnomalyExample {
  jugadaId: string;
  ticketId: string;
  loteriaId: string;
  loteriaNombre: string;
  finalMultiplierX: number;
  createdAt: string;
  amount: number;
}

/**
 * Información de anomalías detectadas
 */
export interface CierreAnomalies {
  outOfBandCount: number;
  examples: AnomalyExample[];
}

/**
 * Banda utilizada en el periodo (multiplicador activo)
 */
export interface BandaUsada {
  value: number;
  loteriaId: string;
  loteriaNombre: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/**
 * Metadata de bandas utilizadas
 */
export interface BandsUsedMetadata {
  byLoteria: Record<string, number[]>; // loteriaId -> [valores]
  global: number[]; // todos los valores únicos
  details: BandaUsada[]; // configuración completa
}

/**
 * Parámetros de consulta para weekly
 */
export interface CierreWeeklyQuery {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  ventanaId?: string; // UUID
  scope?: CierreScope; // 'mine' | 'all'
}

/**
 * Parámetros de consulta para by-seller
 */
export interface CierreBySellerQuery extends CierreWeeklyQuery {
  top?: number; // límite de resultados
  orderBy?: 'totalVendida' | 'ganado' | 'netoDespuesComision'; // campo de ordenamiento
}

/**
 * Parámetros de consulta para export
 */
export interface CierreExportQuery extends CierreWeeklyQuery {
  view: CierreView; // vista a exportar
  top?: number; // para view=seller
  orderBy?: 'totalVendida' | 'ganado' | 'netoDespuesComision';
}

/**
 * Datos agregados por banda, lotería y turno (query raw)
 */
export interface CierreAggregateRow {
  banda: number; // Banda dinámica (exacta) o 200 para REVENTADO
  loteriaId: string;
  loteriaNombre: string;
  turno: string; // "19:30"
  totalVendida: number;
  ganado: number;
  comisionTotal: number;
  refuerzos: number; // placeholder
  ticketsCount: number;
  jugadasCount: number;
}

/**
 * Datos agregados por vendedor (query raw)
 */
export interface VendedorAggregateRow {
  vendedorId: string;
  vendedorNombre: string;
  ventanaId: string;
  ventanaNombre: string;
  banda?: number; // Banda dinámica (exacta)
  totalVendida: number;
  ganado: number;
  comisionTotal: number;
  refuerzos: number;
  ticketsCount: number;
  jugadasCount: number;
}

/**
 * Extras de metadatos calculados por el servicio para enriquecer la respuesta
 */
export interface CierreMetaExtras {
  bandsUsed: BandsUsedMetadata;
  configHash: string; // hash de configuración utilizada
  anomalies: CierreAnomalies;
}
