import { Role } from '@prisma/client';

export interface CreateUserDTO {
  name: string;
  email?: string | null;     // opcional
  phone?: string | null;     // opcional
  username: string;
  password: string;          // >= 8 (valida el validator)
  role?: Role;
  ventanaId?: string | null; // requerido si role != ADMIN (lo aplica el service)
  code?: string | null;
  isActive?: boolean;
}

export interface UpdateUserDTO {
  name?: string;
  email?: string | null;
  phone?: string | null;
  username?: string;
  password?: string;
  role?: Role;
  ventanaId?: string | null;
  isDeleted?: boolean; // admin-only
  code?: string | null;
  isActive?: boolean;  // ya estaba permitido
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  role?: Role;
  search?: string;
}
