export interface CreateLoteriaDTO {
  name: string;
  rulesJson?: Record<string, any> | null;
  isActive?: boolean;
}

export interface UpdateLoteriaDTO {
  name?: string;
  rulesJson?: Record<string, any> | null;
  isActive?: boolean;
}

export interface LoteriaListParams {
  page?: number;
  pageSize?: number;
  isActive?: boolean;
  search?: string; //  nuevo
}
