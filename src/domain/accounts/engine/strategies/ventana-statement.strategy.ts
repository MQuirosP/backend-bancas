// src/domain/accounts/engine/strategies/ventana-statement.strategy.ts

import { Role } from "../../../../generated/prisma/client";
import { IDimensionStrategy } from "./dimension-strategy.interface";
import { StatementDimension } from "../types/statement.types";

export class VentanaStatementStrategy implements IDimensionStrategy {
  readonly dimension: StatementDimension = "ventana";

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
    return `${dateKey}_${filterIds.ventanaId || row.ventana_id}`;
  }

  resolveBreakdownKey(
    dateKey: string,
    row: {
      banca_id?: string | null;
      ventana_id?: string | null;
      vendedor_id?: string | null;
    }
  ): string {
    return `${dateKey}_${row.ventana_id}`;
  }

  resolveMovementTargetId(movement: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string | null | undefined {
    return movement.ventanaId;
  }

  isMovementFilteredOut(
    targetId: string | null | undefined,
    filterIds: {
      bancaId?: string;
      ventanaId?: string;
      vendedorId?: string;
    }
  ): boolean {
    if (filterIds.ventanaId && targetId !== filterIds.ventanaId) {
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
    return entry.ventanaId || 'null';
  }
}
