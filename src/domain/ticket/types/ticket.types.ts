import { Role } from "../../../generated/prisma/client";
export * from "../pipeline/ticket.types";

export interface RegisterPaymentInput {
  amountPaid: number;
  method?: string;
  notes?: string;
  isFinal?: boolean;
  idempotencyKey?: string;
}

export interface PaymentHistoryEntry {
  id: string;
  amountPaid: number;
  paidAt: string;
  paidById: string;
  paidByName: string;
  method: string;
  notes?: string;
  isFinal: boolean;
  isReversed: boolean;
  reversedAt?: string;
  reversedBy?: string;
}

export interface NumbersSummaryParams {
  date?: string;
  fromDate?: string;
  toDate?: string;
  scope?: string;
  dimension?: string;
  ventanaId?: string | null;
  vendedorId?: string | null;
  loteriaId?: string;
  sorteoId?: string;
  multiplierId?: string;
  status?: string;
  sorteoStatus?: string;
  page?: number;
  pageSize?: number;
  bancaId?: string;
  isExcluded?: boolean | string;
}

export interface FilterOptionsParams {
  scope?: string;
  vendedorId?: string;
  ventanaId?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
  loteriaId?: string;
  sorteoId?: string;
  multiplierId?: string;
}

export interface FilterOptionsContext {
  userId: string;
  role: Role;
  ventanaId?: string | null;
  bancaId?: string | null;
}

export interface NumbersSummaryFilterOptionsParams {
  date?: string;
  fromDate?: string;
  toDate?: string;
  scope?: string;
  dimension?: string;
  ventanaId?: string | null;
  vendedorId?: string | null;
  loteriaId?: string;
  sorteoId?: string;
  multiplierId?: string;
  status?: string;
  sorteoStatus?: string;
  bancaId?: string;
}
