export interface CreateLoteriaDTO {
  name: string;
  rulesJson?: Record<string, any> | null;
}

export interface UpdateLoteriaDTO {
  name?: string;
  rulesJson?: Record<string, any> | null;
}

export interface LoteriaListParams {
  page?: number;
  pageSize?: number;
  isDeleted?: boolean;
}
