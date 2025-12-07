import { Prisma } from "@prisma/client";
import prisma from "../../core/prismaClient";
import logger from "../../core/logger";
import { commissionSnapshotService, CommissionSnapshotFilters } from "./CommissionSnapshotService";

/**
 * Resultado de agregación por ventana
 */
export interface VentanaAggregation {
  ventanaId: string;
  ventanaName?: string;
  totalSales: number;
  totalCommission: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  ticketCount: number;
  jugadaCount: number;
}

/**
 * Resultado de agregación por vendedor
 */
export interface VendedorAggregation {
  vendedorId: string;
  vendedorName?: string;
  ventanaId: string;
  ventanaName?: string;
  totalSales: number;
  totalCommission: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  ticketCount: number;
  jugadaCount: number;
}

/**
 * Resultado de agregación por lotería
 */
export interface LoteriaAggregation {
  loteriaId: string;
  loteriaName?: string;
  totalSales: number;
  totalCommission: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  ticketCount: number;
  jugadaCount: number;
}

/**
 * Resultado de agregación por sorteo
 */
export interface SorteoAggregation {
  sorteoId: string;
  sorteoName?: string;
  totalSales: number;
  totalCommission: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  ticketCount: number;
  jugadaCount: number;
}

/**
 * Resultado de agregación total
 */
export interface TotalAggregation {
  totalSales: number;
  totalCommission: number;
  totalListeroCommission: number;
  totalVendedorCommission: number;
  ticketCount: number;
  jugadaCount: number;
}

/**
 * Servicio para agregar comisiones usando snapshots guardados en BD
 * Centraliza todas las operaciones de agregación para reportes y dashboards
 */
export class CommissionAggregationService {
  /**
   * Agrega comisiones por ventana usando snapshots
   * Optimizado con SQL directo para mejor rendimiento
   */
  async aggregateByVentana(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, VentanaAggregation>> {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."status" != 'CANCELLED'`,
    ];

    if (filters.ventanaId) {
      whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

    if (filters.vendedorId) {
      whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    if (filters.sorteoId) {
      whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}::uuid`);
    }

    if (filters.loteriaId) {
      whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateParts: Prisma.Sql[] = [];
      if (filters.dateFrom) {
        dateParts.push(Prisma.sql`t."businessDate" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        dateParts.push(Prisma.sql`t."businessDate" <= ${filters.dateTo}`);
      }
      if (dateParts.length > 0) {
        whereConditions.push(Prisma.sql`(${Prisma.sql.join(dateParts, Prisma.sql` AND `)})`);
      }
    }

    const whereSql = Prisma.sql.join(whereConditions, Prisma.sql` AND `);

    const result = await prisma.$queryRaw<Array<{
      ventana_id: string;
      ventana_name: string;
      total_sales: number;
      total_commission: number;
      total_listero_commission: number;
      total_vendedor_commission: number;
      ticket_count: number;
      jugada_count: number;
    }>>(
      Prisma.sql`
        SELECT
          t."ventanaId" as ventana_id,
          v.name as ventana_name,
          COALESCE(SUM(j.amount), 0)::numeric as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0)::numeric as total_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0)::numeric as total_listero_commission,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0)::numeric as total_vendedor_commission,
          COUNT(DISTINCT t.id)::int as ticket_count,
          COUNT(j.id)::int as jugada_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${whereSql}
        GROUP BY t."ventanaId", v.name
      `
    );

    const aggregationMap = new Map<string, VentanaAggregation>();
    for (const row of result) {
      aggregationMap.set(row.ventana_id, {
        ventanaId: row.ventana_id,
        ventanaName: row.ventana_name,
        totalSales: Number(row.total_sales),
        totalCommission: Number(row.total_commission),
        totalListeroCommission: Number(row.total_listero_commission),
        totalVendedorCommission: Number(row.total_vendedor_commission),
        ticketCount: row.ticket_count,
        jugadaCount: row.jugada_count,
      });
    }

    return aggregationMap;
  }

  /**
   * Agrega comisiones por vendedor usando snapshots
   */
  async aggregateByVendedor(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, VendedorAggregation>> {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."status" != 'CANCELLED'`,
      Prisma.sql`t."vendedorId" IS NOT NULL`,
    ];

    if (filters.ventanaId) {
      whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

    if (filters.vendedorId) {
      whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    if (filters.sorteoId) {
      whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}::uuid`);
    }

    if (filters.loteriaId) {
      whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateParts: Prisma.Sql[] = [];
      if (filters.dateFrom) {
        dateParts.push(Prisma.sql`t."businessDate" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        dateParts.push(Prisma.sql`t."businessDate" <= ${filters.dateTo}`);
      }
      if (dateParts.length > 0) {
        whereConditions.push(Prisma.sql`(${Prisma.sql.join(dateParts, Prisma.sql` AND `)})`);
      }
    }

    const whereSql = Prisma.sql.join(whereConditions, Prisma.sql` AND `);

    const result = await prisma.$queryRaw<Array<{
      vendedor_id: string;
      vendedor_name: string;
      ventana_id: string;
      ventana_name: string;
      total_sales: number;
      total_commission: number;
      total_listero_commission: number;
      total_vendedor_commission: number;
      ticket_count: number;
      jugada_count: number;
    }>>(
      Prisma.sql`
        SELECT
          t."vendedorId" as vendedor_id,
          u.name as vendedor_name,
          t."ventanaId" as ventana_id,
          v.name as ventana_name,
          COALESCE(SUM(j.amount), 0)::numeric as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0)::numeric as total_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0)::numeric as total_listero_commission,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0)::numeric as total_vendedor_commission,
          COUNT(DISTINCT t.id)::int as ticket_count,
          COUNT(j.id)::int as jugada_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "User" u ON t."vendedorId" = u.id
        LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${whereSql}
        GROUP BY t."vendedorId", u.name, t."ventanaId", v.name
      `
    );

    const aggregationMap = new Map<string, VendedorAggregation>();
    for (const row of result) {
      aggregationMap.set(row.vendedor_id, {
        vendedorId: row.vendedor_id,
        vendedorName: row.vendedor_name,
        ventanaId: row.ventana_id,
        ventanaName: row.ventana_name,
        totalSales: Number(row.total_sales),
        totalCommission: Number(row.total_commission),
        totalListeroCommission: Number(row.total_listero_commission),
        totalVendedorCommission: Number(row.total_vendedor_commission),
        ticketCount: row.ticket_count,
        jugadaCount: row.jugada_count,
      });
    }

    return aggregationMap;
  }

  /**
   * Agrega comisiones por lotería usando snapshots
   */
  async aggregateByLoteria(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, LoteriaAggregation>> {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."status" != 'CANCELLED'`,
    ];

    if (filters.ventanaId) {
      whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

    if (filters.vendedorId) {
      whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    if (filters.sorteoId) {
      whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}::uuid`);
    }

    if (filters.loteriaId) {
      whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateParts: Prisma.Sql[] = [];
      if (filters.dateFrom) {
        dateParts.push(Prisma.sql`t."businessDate" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        dateParts.push(Prisma.sql`t."businessDate" <= ${filters.dateTo}`);
      }
      if (dateParts.length > 0) {
        whereConditions.push(Prisma.sql`(${Prisma.sql.join(dateParts, Prisma.sql` AND `)})`);
      }
    }

    const whereSql = Prisma.sql.join(whereConditions, Prisma.sql` AND `);

    const result = await prisma.$queryRaw<Array<{
      loteria_id: string;
      loteria_name: string;
      total_sales: number;
      total_commission: number;
      total_listero_commission: number;
      total_vendedor_commission: number;
      ticket_count: number;
      jugada_count: number;
    }>>(
      Prisma.sql`
        SELECT
          t."loteriaId" as loteria_id,
          l.name as loteria_name,
          COALESCE(SUM(j.amount), 0)::numeric as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0)::numeric as total_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0)::numeric as total_listero_commission,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0)::numeric as total_vendedor_commission,
          COUNT(DISTINCT t.id)::int as ticket_count,
          COUNT(j.id)::int as jugada_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Loteria" l ON t."loteriaId" = l.id
        LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${whereSql}
        GROUP BY t."loteriaId", l.name
      `
    );

    const aggregationMap = new Map<string, LoteriaAggregation>();
    for (const row of result) {
      aggregationMap.set(row.loteria_id, {
        loteriaId: row.loteria_id,
        loteriaName: row.loteria_name,
        totalSales: Number(row.total_sales),
        totalCommission: Number(row.total_commission),
        totalListeroCommission: Number(row.total_listero_commission),
        totalVendedorCommission: Number(row.total_vendedor_commission),
        ticketCount: row.ticket_count,
        jugadaCount: row.jugada_count,
      });
    }

    return aggregationMap;
  }

  /**
   * Agrega comisiones por sorteo usando snapshots
   */
  async aggregateBySorteo(
    filters: CommissionSnapshotFilters
  ): Promise<Map<string, SorteoAggregation>> {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."status" != 'CANCELLED'`,
    ];

    if (filters.ventanaId) {
      whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

    if (filters.vendedorId) {
      whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    if (filters.sorteoId) {
      whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}::uuid`);
    }

    if (filters.loteriaId) {
      whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateParts: Prisma.Sql[] = [];
      if (filters.dateFrom) {
        dateParts.push(Prisma.sql`t."businessDate" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        dateParts.push(Prisma.sql`t."businessDate" <= ${filters.dateTo}`);
      }
      if (dateParts.length > 0) {
        whereConditions.push(Prisma.sql`(${Prisma.sql.join(dateParts, Prisma.sql` AND `)})`);
      }
    }

    const whereSql = Prisma.sql.join(whereConditions, Prisma.sql` AND `);

    const result = await prisma.$queryRaw<Array<{
      sorteo_id: string;
      sorteo_name: string;
      total_sales: number;
      total_commission: number;
      total_listero_commission: number;
      total_vendedor_commission: number;
      ticket_count: number;
      jugada_count: number;
    }>>(
      Prisma.sql`
        SELECT
          t."sorteoId" as sorteo_id,
          s.name as sorteo_name,
          COALESCE(SUM(j.amount), 0)::numeric as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0)::numeric as total_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0)::numeric as total_listero_commission,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0)::numeric as total_vendedor_commission,
          COUNT(DISTINCT t.id)::int as ticket_count,
          COUNT(j.id)::int as jugada_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${whereSql}
        GROUP BY t."sorteoId", s.name
      `
    );

    const aggregationMap = new Map<string, SorteoAggregation>();
    for (const row of result) {
      aggregationMap.set(row.sorteo_id, {
        sorteoId: row.sorteo_id,
        sorteoName: row.sorteo_name,
        totalSales: Number(row.total_sales),
        totalCommission: Number(row.total_commission),
        totalListeroCommission: Number(row.total_listero_commission),
        totalVendedorCommission: Number(row.total_vendedor_commission),
        ticketCount: row.ticket_count,
        jugadaCount: row.jugada_count,
      });
    }

    return aggregationMap;
  }

  /**
   * Calcula totales agregados usando snapshots
   */
  async aggregateTotal(
    filters: CommissionSnapshotFilters
  ): Promise<TotalAggregation> {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`j."deletedAt" IS NULL`,
      Prisma.sql`t."deletedAt" IS NULL`,
      Prisma.sql`t."status" != 'CANCELLED'`,
    ];

    if (filters.ventanaId) {
      whereConditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    if (filters.bancaId) {
      whereConditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

    if (filters.vendedorId) {
      whereConditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    if (filters.sorteoId) {
      whereConditions.push(Prisma.sql`t."sorteoId" = ${filters.sorteoId}::uuid`);
    }

    if (filters.loteriaId) {
      whereConditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    if (filters.dateFrom || filters.dateTo) {
      const dateParts: Prisma.Sql[] = [];
      if (filters.dateFrom) {
        dateParts.push(Prisma.sql`t."businessDate" >= ${filters.dateFrom}`);
      }
      if (filters.dateTo) {
        dateParts.push(Prisma.sql`t."businessDate" <= ${filters.dateTo}`);
      }
      if (dateParts.length > 0) {
        whereConditions.push(Prisma.sql`(${Prisma.sql.join(dateParts, Prisma.sql` AND `)})`);
      }
    }

    const whereSql = Prisma.sql.join(whereConditions, Prisma.sql` AND `);

    const result = await prisma.$queryRaw<Array<{
      total_sales: number;
      total_commission: number;
      total_listero_commission: number;
      total_vendedor_commission: number;
      ticket_count: number;
      jugada_count: number;
    }>>(
      Prisma.sql`
        SELECT
          COALESCE(SUM(j.amount), 0)::numeric as total_sales,
          COALESCE(SUM(j."commissionAmount"), 0)::numeric as total_commission,
          COALESCE(SUM(j."listeroCommissionAmount"), 0)::numeric as total_listero_commission,
          COALESCE(SUM(CASE WHEN j."commissionOrigin" = 'USER' THEN j."commissionAmount" ELSE 0 END), 0)::numeric as total_vendedor_commission,
          COUNT(DISTINCT t.id)::int as ticket_count,
          COUNT(j.id)::int as jugada_count
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        LEFT JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE ${whereSql}
      `
    );

    if (result.length === 0) {
      return {
        totalSales: 0,
        totalCommission: 0,
        totalListeroCommission: 0,
        totalVendedorCommission: 0,
        ticketCount: 0,
        jugadaCount: 0,
      };
    }

    const row = result[0];
    return {
      totalSales: Number(row.total_sales),
      totalCommission: Number(row.total_commission),
      totalListeroCommission: Number(row.total_listero_commission),
      totalVendedorCommission: Number(row.total_vendedor_commission),
      ticketCount: row.ticket_count,
      jugadaCount: row.jugada_count,
    };
  }
}

// Instancia singleton para uso directo
export const commissionAggregationService = new CommissionAggregationService();

