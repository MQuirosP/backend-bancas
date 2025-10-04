export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const getSkipTake = (page = 1, pageSize = 10) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

export const buildMeta = (total: number, page = 1, pageSize = 10): PaginationMeta => ({
  total,
  page,
  pageSize,
  totalPages: Math.ceil(total / pageSize),
});
