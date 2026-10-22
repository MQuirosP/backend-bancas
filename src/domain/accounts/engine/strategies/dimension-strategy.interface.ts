// src/domain/accounts/engine/strategies/dimension-strategy.interface.ts

import { Role } from "../../../../generated/prisma/client";
import { AggregatedDimensionEntry, StatementDimension } from "../types/statement.types";

export interface IDimensionStrategy {
  readonly dimension: StatementDimension;

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
  ): string;

  resolveBreakdownKey(
    dateKey: string,
    row: {
      banca_id?: string | null;
      ventana_id?: string | null;
      vendedor_id?: string | null;
    }
  ): string;

  resolveMovementTargetId(movement: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string | null | undefined;

  isMovementFilteredOut(
    targetId: string | null | undefined,
    filterIds: {
      bancaId?: string;
      ventanaId?: string;
      vendedorId?: string;
    }
  ): boolean;

  resolveCommissionForBalance(entry: {
    commissionListero: number;
    commissionVendedor: number;
  }, userRole?: Role): number;

  getEntityIdForPreviousBalance(entry: {
    bancaId?: string | null;
    ventanaId?: string | null;
    vendedorId?: string | null;
  }): string;
}
