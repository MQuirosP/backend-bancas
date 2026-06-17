import { Role } from '../../../generated/prisma/client';

export interface CreateUserDTO {
  name: string;
  email?: string | null;     // opcional
  phone?: string | null;     // opcional
  username: string;
  password: string;          // >= 6 (valida el validator)
  role?: Role;
  ventanaId?: string | null; // requerido si role != ADMIN (lo aplica el service)
  bancaId?: string | null;   // opcional: para ligar admin de banca a una banca primaria
  bancaIds?: string[];       // opcional: para asignar múltiples bancas a un rol BANCA
  code?: string | null;
  isActive?: boolean;
  maxSessionsPerVendedor?: number | null;
}

export interface UpdateUserDTO {
  name?: string;
  email?: string | null;
  phone?: string | null;
  username?: string;
  password?: string;
  role?: Role;
  ventanaId?: string | null;
  bancaId?: string | null;
  code?: string | null;
  isActive?: boolean;  // ya estaba permitido
  maxSessionsPerVendedor?: number | null;
  settings?: Record<string, any> | null;  // Configuraciones (print, theme, etc.)
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  role?: Role;
  search?: string;
  isActive?: boolean;
}
