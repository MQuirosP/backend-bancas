/**
 * Tipos para el módulo de Cierre Operativo
 */

export type LoteriaType = 'TICA' | 'PANAMA' | 'HONDURAS' | 'PRIMERA' | 'NICA' | 'MULTI_X_NICA' | 'MONAZOS';
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
  bancaId?: string; // Para ADMIN multibanca (filtro de vista)
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
 * Métricas por turno/hora agrupadas por tipo
 * Agrupa NUMERO y REVENTADO bajo el mismo horario para facilitar visualización
 */
export interface TurnoAgrupado {
  turno: string; // "19:30"
  NUMERO?: CeldaMetrics; // Métricas de jugadas NUMERO (puede no existir)
  REVENTADO?: CeldaMetrics; // Métricas de jugadas REVENTADO (puede no existir)
  total: CeldaMetrics; // Suma de NUMERO + REVENTADO
}

/**
 * Métricas por turno individual (usado internamente en transformación)
 * @deprecated Usar TurnoAgrupado en la respuesta del API
 */
export interface TurnoMetrics extends CeldaMetrics {
  turno: string; // formato "HH:MM" o "HH:MMAM/PM"
  tipo: JugadaTipo; // NUMERO o REVENTADO
}

/**
 * Métricas por lotería (agrega todos los turnos)
 */
export interface LoteriaMetrics {
  turnos: Record<string, TurnoAgrupado>; // key: "19:30" (sin sufijo de tipo)
  subtotal: CeldaMetrics;
}

/**
 * Métricas por día (agrega todas las loterías de un día específico)
 */
export interface DiaMetrics {
  fecha: string; // YYYY-MM-DD
  loterias: Record<LoteriaType, LoteriaMetrics>; // key: "TICA", "PANAMA", etc.
  totalDia: CeldaMetrics;
}

/**
 * Métricas por banda (agrega todos los días)
 * Siempre organizado por días para consistencia,
 * incluso si es un solo día
 */
export interface BandaMetrics {
  dias: Record<string, DiaMetrics>; // key: "YYYY-MM-DD"
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
 *  NUEVA ESTRUCTURA: Agrupado por Lotería → Sorteo → Tipo → Banda
 */
export interface CierreWeeklyData {
  loterias: CierreLoteriaGroup[];
  totals: CeldaMetrics;
}

/**
 * Grupo de datos por Lotería (Nivel 1)
 */
export interface CierreLoteriaGroup {
  loteria: {
    id: string;
    name: string;
  };
  sorteos: CierreSorteoGroup[];
  subtotal: CeldaMetrics;
}

/**
 * Grupo de datos por Sorteo (Nivel 2)
 *  ACTUALIZADO: Bandas directamente (suma de NUMERO + REVENTADO)
 */
export interface CierreSorteoGroup {
  sorteo: {
    id: string;
    turno: string; // Ej: "19:30"
    scheduledAt?: string; // ISO date string (opcional)
  };
  bands: Record<string, CierreBandData>; // Claves: "80", "85", "90", "92", "200", etc. (suma de NUMERO + REVENTADO)
  subtotal: CeldaMetrics;
}

/**
 * Datos por banda (Nivel 4)
 */
export interface CierreBandData {
  band: number; // 80, 85, 90, 92, 200, etc.
  // Totales consolidados (compatibilidad hacia atrás)
  totalVendida: number;
  ganado: number;
  comisionTotal: number;
  netoDespuesComision: number;
  ticketsCount: number;
  refuerzos?: number;
  // Desglose por tipo (opcional)
  numero?: CeldaMetrics;
  reventado?: CeldaMetrics;
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
  orphanedDataCount?: number; //  NUEVO: Datos huérfanos (discrepancia entre totals y Σ(loterias[].subtotal))
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
 * Tipo de jugada
 */
export type JugadaTipo = 'NUMERO' | 'REVENTADO';

/**
 * Datos agregados por banda, lotería, sorteo, tipo (query raw)
 *  NUEVO: Incluye sorteoId y scheduledAt para agrupar por sorteo
 */
export interface CierreAggregateRow {
  banda: number; // Banda heredada (80, 85, 90, 92) - reventados heredan banda del número asociado
  tipo: JugadaTipo; // NUMERO o REVENTADO
  fecha: string; // YYYY-MM-DD
  loteriaId: string;
  loteriaNombre: string;
  sorteoId: string; //  NUEVO: ID del sorteo
  turno: string; // "19:30"
  scheduledAt: Date; //  NUEVO: Fecha/hora programada del sorteo
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
