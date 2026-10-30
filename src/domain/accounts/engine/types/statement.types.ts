// src/domain/accounts/engine/types/statement.types.ts

import { Role } from "../../../../generated/prisma/client";
import {
  AccountsFilters,
  DayStatement,
  StatementTotals,
  StatementResponse,
  ACCOUNT_PREVIOUS_MONTH_METHOD,
  ACCOUNT_CARRY_OVER_NOTES,
  SorteoBreakdownItem,
  BancaBreakdown,
  VentanaBreakdown,
  VendedorBreakdown,
} from "../../accounts.types";

export type {
  AccountsFilters,
  DayStatement,
  StatementTotals,
  StatementResponse,
  SorteoBreakdownItem,
  BancaBreakdown,
  VentanaBreakdown,
  VendedorBreakdown,
};

export {
  ACCOUNT_PREVIOUS_MONTH_METHOD,
  ACCOUNT_CARRY_OVER_NOTES,
};

export type StatementDimension = "banca" | "ventana" | "vendedor";

export interface StatementEngineParams {
  filters: AccountsFilters;
  startDate: Date;
  endDate: Date;
  daysInMonth: number;
  effectiveMonth: string;
  dimension: StatementDimension;
  ventanaId?: string;
  vendedorId?: string;
  bancaId?: string;
  userRole?: Role;
  sort?: "asc" | "desc";
}

export interface ResolvedEntityNames {
  resolvedBancaName: string | null;
  resolvedBancaCode: string | null;
  resolvedVentanaName: string | null;
  resolvedVentanaCode: string | null;
  resolvedVendedorName: string | null;
  resolvedVendedorCode: string | null;
}

export interface AggregatedDimensionEntry {
  bancaId: string | null;
  bancaName: string | null;
  bancaCode: string | null;
  ventanaId: string | null;
  ventanaName: string | null;
  ventanaCode: string | null;
  vendedorId: string | null;
  vendedorName: string | null;
  vendedorCode: string | null;
  totalSales: number;
  totalPayouts: number;
  totalTicketsCount: number;
  commissionListero: number;
  commissionVendedor: number;
  payoutTicketsCount: number;
}
