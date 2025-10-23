// contrato para servicios (sin Zod)
export type MultiplierKind = "NUMERO" | "REVENTADO";

export type CreateMultiplierInput = {
  loteriaId: string;
  name: string;
  valueX: number;
  kind: MultiplierKind;            // con default en schema
  appliesToDate?: Date | null;     // coaccionado por schema
  appliesToSorteoId?: string | null;
  isActive?: boolean;              // default en schema
};

export type UpdateMultiplierInput = Partial<Omit<CreateMultiplierInput, "loteriaId">>;

export type ListMultiplierQueryInput = {
  loteriaId?: string;
  kind?: MultiplierKind;
  isActive?: boolean;
  appliesToSorteoId?: string;
  q?: string;
  page?: number;       // default en schema
  pageSize?: number;   // default en schema
  search?: string;
};
