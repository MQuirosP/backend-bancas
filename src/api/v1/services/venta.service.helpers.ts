// src/api/v1/services/venta.service.helpers.ts
import { Prisma } from "@prisma/client";

/**
 * Interfaz para filtros estándar de ventas
 */
export interface VentasFilters {
  dateFrom?: Date;
  dateTo?: Date;
  status?: string;
  winnersOnly?: boolean;
  bancaId?: string;
  ventanaId?: string;
  vendedorId?: string;
  loteriaId?: string;
  sorteoId?: string;
  search?: string;
  userId?: string; // Inyectado por scope=mine según rol
}

/**
 * Construye el WHERE de Prisma a partir de filtros normalizados
 */
export function buildWhereClause(filters: VentasFilters): Prisma.TicketWhereInput {
  const where: Prisma.TicketWhereInput = {
    isActive: true, // Solo tickets activos (no soft-deleted)
  };

  // Filtro por fechas (createdAt)
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }

  // Filtro por status
  if (filters.status) {
    where.status = filters.status as any;
  }

  // Filtro por ganadores
  if (filters.winnersOnly) {
    where.isWinner = true;
  }

  // Filtros por IDs
  if (filters.bancaId) {
    where.ventana = { bancaId: filters.bancaId };
  }
  if (filters.ventanaId) {
    where.ventanaId = filters.ventanaId;
  }
  if (filters.vendedorId) {
    where.vendedorId = filters.vendedorId;
  }
  if (filters.loteriaId) {
    where.loteriaId = filters.loteriaId;
  }
  if (filters.sorteoId) {
    where.sorteoId = filters.sorteoId;
  }

  // Búsqueda unificada (search)
  if (filters.search) {
    const searchTerm = filters.search.trim();
    const orConditions: Prisma.TicketWhereInput[] = [];

    // Búsqueda por número de ticket
    if (!isNaN(Number(searchTerm))) {
      orConditions.push({ ticketNumber: Number(searchTerm) });
    }

    // Búsqueda por nombre de vendedor, ventana, lotería, sorteo
    orConditions.push(
      { vendedor: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { ventana: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { loteria: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } },
      { sorteo: { name: { contains: searchTerm, mode: "insensitive" as Prisma.QueryMode } } }
    );

    where.OR = orConditions;
  }

  return where;
}
