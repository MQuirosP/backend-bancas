import { SorteoStatus } from "@prisma/client";

export interface CreateSorteoDTO {
  name: string;
  loteriaId: string;
  scheduledAt: Date | string;
  isActive?: boolean;
  digits?: number;
}

export interface UpdateSorteoDTO {
  loteriaId?: string;
  scheduledAt?: Date | string;
  name?: string;
  digits?: number;
  status?: SorteoStatus;
  isActive?: boolean;
  winningNumber?: string;
  extraOutcomeCode?: string | null;
  extraMultiplierId?: string | null;
}

export interface EvaluateSorteoDTO {
  winningNumber: string;
  extraOutcomeCode?: string | null;
  extraMultiplierId?: string | null;
}
