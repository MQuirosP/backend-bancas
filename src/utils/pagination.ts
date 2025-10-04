import { Prisma } from '@prisma/client';

/**
 * Parámetros base para cualquier paginación
 */
export interface PaginationParams {
  page?: number;
  pageSize?: number;
  maxPageSize?: number;
  cursor?: string | null; // Cursor para scroll infinito
}

/**
 * Metadatos estandarizados para respuestas paginadas
 */
export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  nextCursor?: string | null;
  prevCursor?: string | null;
}

/**
 * Asegura que los valores de paginación sean válidos y seguros
 */
const sanitizePagination = (params: PaginationParams) => {
  const safePage = Number.isFinite(params.page) && params.page! > 0 ? Math.floor(params.page!) : 1;
  const safePageSize =
    Number.isFinite(params.pageSize) && params.pageSize! > 0
      ? Math.min(Math.floor(params.pageSize!), params.maxPageSize ?? 100)
      : 10;

  return { page: safePage, pageSize: safePageSize };
};

/**
 * Construye metadatos confiables para respuesta paginada
 */
export const buildMeta = (
  total: number,
  page: number,
  pageSize: number,
  nextCursor?: string | null,
  prevCursor?: string | null
): PaginationMeta => {
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const safePage = Math.min(Math.max(page, 1), totalPages);

  return {
    total,
    page: safePage,
    pageSize,
    totalPages,
    hasNextPage: safePage < totalPages,
    hasPrevPage: safePage > 1,
    nextCursor: nextCursor ?? null,
    prevCursor: prevCursor ?? null,
  };
};

/**
 * Paginación con offset clásica (skip/take)
 */
export const paginateOffset = async <T>(
  model: {
    findMany: (args: any) => Promise<T[]>;
    count: (args?: any) => Promise<number>;
  },
  options: {
    where?: Record<string, any>;
    include?: Record<string, any>;
    select?: Record<string, any>;
    orderBy?: Record<string, any>;
    page?: number;
    pageSize?: number;
    maxPageSize?: number;
  }
): Promise<{ data: T[]; meta: PaginationMeta }> => {
  const { page, pageSize } = sanitizePagination(options);
  const skip = (page - 1) * pageSize;

  const [data, total] = await Promise.all([
    model.findMany({
      where: options.where,
      include: options.include,
      select: options.select,
      orderBy: options.orderBy ?? { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    model.count({ where: options.where }),
  ]);

  const meta = buildMeta(total, page, pageSize);
  return { data, meta };
};

/**
 * Paginación basada en cursor (ideal para grandes volúmenes)
 */
export const paginateCursor = async <T>(
  model: {
    findMany: (args: any) => Promise<T[]>;
  },
  options: {
    where?: Record<string, any>;
    include?: Record<string, any>;
    select?: Record<string, any>;
    orderBy?: Record<string, any>;
    pageSize?: number;
    maxPageSize?: number;
    cursor?: { id: string } | null;
  }
): Promise<{ data: T[]; meta: PaginationMeta }> => {
  const safePageSize = Math.min(options.pageSize ?? 10, options.maxPageSize ?? 100);

  const data = await model.findMany({
    where: options.where,
    include: options.include,
    select: options.select,
    orderBy: options.orderBy ?? { createdAt: 'desc' },
    cursor: options.cursor ?? undefined,
    skip: options.cursor ? 1 : 0, // Evita duplicar el último registro del batch anterior
    take: safePageSize + 1, // Un registro extra para saber si hay siguiente página
  });

  const hasNextPage = data.length > safePageSize;
  const dataSlice = hasNextPage ? data.slice(0, safePageSize) : data;

  const nextCursor = hasNextPage
    ? (dataSlice[dataSlice.length - 1] as any)?.id ?? null
    : null;
  const prevCursor = options.cursor ? (dataSlice[0] as any)?.id ?? null : null;

  const meta = buildMeta(0, 1, safePageSize, nextCursor, prevCursor);

  return { data: dataSlice, meta };
};
