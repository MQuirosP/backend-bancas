export interface CreateSorteoDTO {
  name: string;
  loteriaId: string;
  scheduledAt: Date | string; // aceptamos ISO string; el validator la convierte a Date
}

export type SorteoStatusDTO = "SCHEDULED" | "OPEN" | "EVALUATED" | "CLOSED";

export interface UpdateSorteoDTO {
  scheduledAt?: Date | string;
  status?: SorteoStatusDTO;
  winningNumber?: string;
  extraMultiplierId?: string;
}

export interface EvaluateSorteoDTO {
  winningNumber: string;
  extraOutcomeCode?: string | null;
  extraMultiplierId?: string | null
}
