export type CreateBancaInput = {
  name: string;
  code: string;
  email?: string;
  address?: string;
  phone?: string;
  isActive?: boolean;
  defaultMinBet?: number;
  globalMaxPerNumber?: number;
  salesCutoffMinutes?: number;
};

export type UpdateBancaInput = Partial<CreateBancaInput>;

// (Opcional) Back-compat aliases si en algún lado usaron otros nombres:
export type CreateBancaDTO = CreateBancaInput;
export type UpdateBancaDTO = UpdateBancaInput;
