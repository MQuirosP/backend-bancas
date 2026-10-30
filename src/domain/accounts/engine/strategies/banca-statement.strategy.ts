// src/domain/accounts/engine/strategies/banca-statement.strategy.ts

import { Role } from "../../../../generated/prisma/client";
import { IDimensionStrategy } from "./dimension-strategy.interface";
import { StatementDimension } from "../types/statement.types";

export class BancaStatementStrategy implements IDimensionStrategy {
  readonly dimension: StatementDimension = "banca";

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
    return `${dateKey}_${filterIds.bancaId || row.banca_id || 'null'}`;
  }

  resolveBreakdownKey(
    dateKey: string,
    row: {
      banca_id?: string | null;
      ventana_id?: string | null;
      vendedor_id?: string | null;
    }
  ): string {
    return `${dateKey}_${row.banca_id || 'null'}`;
  }

  resolveMovementTargetId(movement: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string | null | undefined {
    return movement.bancaId;
  }

  isMovementFilteredOut(
    targetId: string | null | undefined,
    filterIds: {
      bancaId?: string;
      ventanaId?: string;
      vendedorId?: string;
    }
  ): boolean {
    if (filterIds.bancaId && targetId !== filterIds.bancaId) {
      return true;
    }
    return false;
  }

  resolveCommissionForBalance(entry: {
    commissionListero: number;
    commissionVendedor: number;
  }, _userRole?: Role): number {
    return entry.commissionListero;
  }

  getEntityIdForPreviousBalance(entry: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string {
    return entry.bancaId || 'null';
  }
}
