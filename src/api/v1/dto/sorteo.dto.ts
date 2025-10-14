import { SorteoStatus } from "@prisma/client";

export interface CreateSorteoDTO {
  name: string;
  loteriaId: string;
  scheduledAt: Date | string;
}

export interface UpdateSorteoDTO {
  scheduledAt?: Date | string;
  status?: SorteoStatus;
  winningNumber?: string;
  extraOutcomeCode?: string | null;
  extraMultiplierId?: string | null;
}

export interface EvaluateSorteoDTO {
  winningNumber: string;
  extraOutcomeCode?: string | null;
  extraMultiplierId?: string | null;
}
