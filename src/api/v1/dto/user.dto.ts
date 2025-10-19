import { Role } from '@prisma/client';

export interface CreateUserDTO {
  name: string;
  email?: string | null;     // opcional
  username: string;
  password: string;          // >= 8 (valida el validator)
  role?: Role;
  ventanaId?: string | null; // requerido si role != ADMIN (lo aplica el service)
  code?: string | null;      // ✅ nuevo
  isActive?: boolean;        // ✅ nuevo
}

export interface UpdateUserDTO {
  name?: string;
  email?: string | null;
  username?: string;
  password?: string;
  role?: Role;
  ventanaId?: string | null;
  isDeleted?: boolean; // admin-only
  isActive?: boolean;  // ya estaba permitido
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  role?: Role;
  isDeleted?: boolean;
  search?: string;
}
