export type CreateVentanaInput = {
  bancaId: string;              // uuid
  name: string;                 // 2..100
  code: string;                 // 2..10 (único)
  commissionMarginX: number;    // int, >= 0
  address?: string;
  phone?: string;
  email?: string;
  isActive?: boolean;
};

export type UpdateVentanaInput = Partial<CreateVentanaInput>;
