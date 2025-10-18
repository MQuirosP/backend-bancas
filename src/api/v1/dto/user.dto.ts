import { Role } from '@prisma/client';

export interface CreateUserDTO {
  name: string;
  email?: string | null;
  username: string;
  password: string;
  role?: Role;
  ventanaId?: string | null; // <- opcional aquí; el service aplica la regla según role
}

export interface UpdateUserDTO {
  name?: string;
  email?: string | null;
  username?: string;
  password?: string;
  role?: Role;
  ventanaId?: string | null;
  isDeleted?: boolean; // admin-only
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  role?: Role;
  isDeleted?: boolean;
  search?: string;
}
