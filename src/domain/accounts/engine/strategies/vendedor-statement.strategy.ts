// src/domain/accounts/engine/strategies/vendedor-statement.strategy.ts

import { Role } from "../../../../generated/prisma/client";
import { IDimensionStrategy } from "./dimension-strategy.interface";
import { StatementDimension } from "../types/statement.types";

export class VendedorStatementStrategy implements IDimensionStrategy {
  readonly dimension: StatementDimension = "vendedor";

  resolveGroupKey(
    dateKey: string,
    row: {
      banca_id?: string | null;
      ventana_id?: string | null;
      vendedor_id?: string | null;
    },
    shouldGroupByDate: boolean,
    filterIds: {
      bancaId?: string;
      ventanaId?: string;
      vendedorId?: string;
    }
  ): string {
    if (shouldGroupByDate) {
      return dateKey;
    }
    return `${dateKey}_${filterIds.vendedorId || row.vendedor_id || 'null'}`;
  }

  resolveBreakdownKey(
    dateKey: string,
    row: {
      banca_id?: string | null;
      ventana_id?: string | null;
      vendedor_id?: string | null;
    }
  ): string {
    return `${dateKey}_${row.vendedor_id || 'null'}`;
  }

  resolveMovementTargetId(movement: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string | null | undefined {
    return movement.vendedorId;
  }

  isMovementFilteredOut(
    targetId: string | null | undefined,
    filterIds: {
      bancaId?: string;
      ventanaId?: string;
      vendedorId?: string;
    }
  ): boolean {
    if (filterIds.vendedorId && targetId !== filterIds.vendedorId) {
      return true;
    }
    return false;
  }

  resolveCommissionForBalance(entry: {
    commissionListero: number;
    commissionVendedor: number;
  }, _userRole?: Role): number {
    return entry.commissionVendedor;
  }

  getEntityIdForPreviousBalance(entry: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string {
    return entry.vendedorId || 'null';
  }
}
