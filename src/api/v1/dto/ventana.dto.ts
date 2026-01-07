export type CreateVentanaInput = {
  bancaId: string;              // uuid
  name: string;                 // 2..100
  code: string;                 // 2..10 (único)
  commissionMarginX: number;    // int, >= 0
  address?: string;
  phone?: string;
  email?: string;
  isActive?: boolean;
  settings?: Record<string, any> | null;
  //  NUEVOS CAMPOS requeridos para creación de usuario
  username: string;            // REQUERIDO: username del usuario VENTANA
  password: string;            // REQUERIDO: password del usuario VENTANA
};

export type UpdateVentanaInput = Partial<Omit<CreateVentanaInput, 'username' | 'password'>> & {
  //  Campos opcionales para actualizar usuario asociado
  username?: string;           // Opcional: actualizar username del usuario asociado
  password?: string;           // Opcional: actualizar password del usuario asociado
};
