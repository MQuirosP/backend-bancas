export type CreateVendedorInput = {
  ventanaId: string;     // UUID
  name: string;          // min 2
  username: string;      // min 3, max 12
  email?: string;        // email válido
  password: string;      // min 8
  code: string;
};

export type UpdateVendedorInput = Partial<CreateVendedorInput> & {
  isActive?: boolean;
};
