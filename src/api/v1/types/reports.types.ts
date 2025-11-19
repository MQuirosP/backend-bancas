/**
 * Tipos comunes para el módulo de reportes
 */

export type DateToken = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'range';

export type PaymentStatus = 'all' | 'paid' | 'partial' | 'unpaid';

export type BetTypeFilter = 'NUMERO' | 'REVENTADO' | 'all';

export type SorteoStatusFilter = 'SCHEDULED' | 'OPEN' | 'EVALUATED' | 'CLOSED' | 'all';

export type SortByVentanas = 'ventas' | 'neto' | 'margin' | 'tickets';

export type SortByVendedores = 'ventas' | 'tickets' | 'commissions' | 'winRate';

export interface DateRange {
  from: Date;
  to: Date;
  fromString: string; // YYYY-MM-DD
  toString: string; // YYYY-MM-DD
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ReportMeta extends PaginationMeta {
  dateRange: {
    from: string; // YYYY-MM-DD
    to: string; // YYYY-MM-DD
  };
  comparisonEnabled?: boolean;
  sortBy?: string;
  [key: string]: any;
}

