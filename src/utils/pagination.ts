// src/utils/pagination.ts
import { withConnectionRetry } from '../core/withConnectionRetry';

/**
 * Parámetros de entrada para paginación
 */
export interface PaginationParams {
  page?: number;       // página 1..N
  pageSize?: number;   // tamaño de página solicitado
  maxPageSize?: number; // límite duro de seguridad (default 100)
}

/**
 * Metadatos estándar de respuesta paginada
 */
export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

/**
 * Resultado paginado genérico
 */
export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

/**
 * Sanea y normaliza parámetros de paginación con límites de seguridad.
 * Evita DoS por pageSize enorme, páginas negativas, NaN, etc.
 */
const sanitizePagination = (params?: PaginationParams) => {
  const pageRaw = params?.page;
  const pageSizeRaw = params?.pageSize;
  const maxPageSize = params?.maxPageSize ?? 100;

  const safePage =
    typeof pageRaw === 'number' && isFinite(pageRaw) && pageRaw > 0
      ? Math.floor(pageRaw)
      : 1;

  const safePageSizeBase =
    typeof pageSizeRaw === 'number' && isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.floor(pageSizeRaw)
      : 10;

  const safePageSize = Math.min(safePageSizeBase, maxPageSize);

  return { page: safePage, pageSize: safePageSize, maxPageSize };
};

/**
 * Devuelve skip/take calculados a partir de la paginación saneada.
 * La dejamos pública por si algún servicio la requiere directamente.
 */
export const getSkipTake = (page = 1, pageSize = 10) => {
  const p = Math.max(1, Math.floor(page));
  const s = Math.max(1, Math.floor(pageSize));
  return { skip: (p - 1) * s, take: s };
};

/**
 * Construye metadatos consistentes y completos.
 */
export const buildMeta = (
  total: number,
  page = 1,
  pageSize = 10
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
  };
};

/**
 * Paginación por OFFSET (skip/take) — la más común en paneles y CRUD.
 * Genérica y segura, acepta cualquier modelo Prisma-like con findMany/count.
 */
export async function paginateOffset<T>(
  model: {
    findMany: (args: any) => Promise<T[]>;
    count: (args?: any) => Promise<number>;
  },
  options?: {
    where?: Record<string, any>;
    include?: Record<string, any>;
    select?: Record<string, any>;
    orderBy?: Record<string, any>;
    pagination?: PaginationParams;
  }
): Promise<PaginatedResult<T>> {
  const { page, pageSize } = sanitizePagination(options?.pagination);
  const { skip, take } = getSkipTake(page, pageSize);

  const [data, total] = await withConnectionRetry(
    () => Promise.all([
      model.findMany({
        where: options?.where,
        include: options?.include,
        select: options?.select,
        orderBy: options?.orderBy ?? { createdAt: 'desc' }, // todos tus modelos tienen createdAt
        skip,
        take,
      }),
      model.count({ where: options?.where }),
    ]),
    { context: 'pagination.paginateOffset' }
  );

  return { data, meta: buildMeta(total, page, pageSize) };
}

/**
 * Paginación por CURSOR — ideal para listas muy largas (infinite scroll).
 * Requiere un campo cursor estable (por defecto 'id').
 */
export async function paginateCursor<T extends Record<string, any>>(
  model: {
    findMany: (args: Record<string, any>) => Promise<T[]>;
  },
  options?: {
    where?: Record<string, any>;
    include?: Record<string, any>;
    select?: Record<string, any>;
    orderBy?: Record<string, any>;
    cursor?: { field?: string; value?: string } | null; // { field: 'id', value: 'uuid' }
    pageSize?: number;
    maxPageSize?: number;
  }
): Promise<{ data: T[]; meta: PaginationMeta & { nextCursor: string | null } }> {
  const maxPage = options?.maxPageSize ?? 100;
  const sizeRaw = options?.pageSize ?? 10;
  const pageSize = Math.min(Math.max(Math.floor(sizeRaw), 1), maxPage);

  const cursorField = options?.cursor?.field ?? 'id';
  const cursorValue = options?.cursor?.value;

  const query: Record<string, any> = {
    where: options?.where,
    include: options?.include,
    select: options?.select,
    orderBy: options?.orderBy ?? { createdAt: 'desc' },
    take: pageSize + 1, // +1 para detectar si hay siguiente página
  };

  if (cursorValue) {
    query.cursor = { [cursorField]: cursorValue };
    query.skip = 1; // evita incluir el registro del cursor en el siguiente batch
  }

  const rows = await withConnectionRetry(
    () => model.findMany(query),
    { context: 'pagination.paginateCursor' }
  );

  const hasNextPage = rows.length > pageSize;
  const data = hasNextPage ? rows.slice(0, pageSize) : rows;

  const nextCursor = hasNextPage ? (data[data.length - 1]?.[cursorField] as string) ?? null : null;

  // En cursor-based no calculamos total (costoso). Meta parcial pero útil.
  const meta = {
    ...buildMeta(0, 1, pageSize),
    hasNextPage,
    hasPrevPage: Boolean(cursorValue), // si hay cursor, asumimos que venías de una página previa
  };

  return { data, meta: { ...meta, nextCursor } };
}
