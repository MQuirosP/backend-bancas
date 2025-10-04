import { Role } from '@prisma/client';

export interface CreateUserDTO {
  name: string;
  email: string;
  password: string;
  role?: Role;
  ventanaId?: string | null;
}

export interface UpdateUserDTO {
  name?: string;
  email?: string;
  password?: string;
  role?: Role;
  ventanaId?: string | null;
  isDeleted?: boolean; // no se expone en ruta pública; se usa en delete/restore
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  role?: Role;
  isDeleted?: boolean;
}
