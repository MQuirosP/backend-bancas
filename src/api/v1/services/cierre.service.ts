import { Prisma } from '@prisma/client';
import prisma from '../../../core/prismaClient';
import {
  CierreFilters,
  CierreWeeklyResponse,
  CierreBySellerResponse,
  CeldaMetrics,
  TurnoMetrics,
  LoteriaMetrics,
  BandaMetrics,
  VendedorMetrics,
  CierreAggregateRow,
  VendedorAggregateRow,
  LoteriaType,
} from '../types/cierre.types';
import {
  getBandaForJugada,
  BandaMultiplicador,
  ALL_BANDS,
} from '../config/commission-bands';

/**
 * Servicio para Cierre Operativo
 * Agrega datos de ventas por banda, lotería, turno y vendedor
 */
export class CierreService {
  private static readonly TIMEZONE = 'America/Costa_Rica';

  /**
   * Agrega datos semanales por banda, lotería y turno
   */
  static async aggregateWeekly(
    filters: CierreFilters
  ): Promise<CierreWeeklyResponse> {
    const startTime = Date.now();
    let queryCount = 0;

    // Ejecutar agregación principal
    const rawData = await this.executeWeeklyAggregation(filters);
    queryCount += 1;

    // Transformar datos en estructura jerárquica
    const { totals, bands } = this.transformWeeklyData(rawData);

    return {
      period: {
        from: this.toCostaRicaISO(filters.fromDate),
        to: this.toCostaRicaISO(filters.toDate),
      },
      meta: {
        timezone: this.TIMEZONE,
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
        scope: filters.scope,
        generatedAt: new Date().toISOString(),
      },
      totals,
      bands,
    };
  }

  /**
   * Agrega datos por vendedor
   */
  static async aggregateBySeller(
    filters: CierreFilters,
    top?: number,
    orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' = 'totalVendida'
  ): Promise<CierreBySellerResponse> {
    const startTime = Date.now();
    let queryCount = 0;

    // Ejecutar agregación por vendedor
    const rawData = await this.executeSellerAggregation(filters);
    queryCount += 1;

    // Transformar datos
    const { totals, vendedores } = this.transformSellerData(
      rawData,
      top,
      orderBy
    );

    return {
      period: {
        from: this.toCostaRicaISO(filters.fromDate),
        to: this.toCostaRicaISO(filters.toDate),
      },
      meta: {
        timezone: this.TIMEZONE,
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
        scope: filters.scope,
        generatedAt: new Date().toISOString(),
      },
      totals,
      vendedores,
    };
  }

  /**
   * Ejecuta agregación SQL para datos semanales
   */
  private static async executeWeeklyAggregation(
    filters: CierreFilters
  ): Promise<CierreAggregateRow[]> {
    const whereConditions = this.buildWhereConditions(filters);

    const query = Prisma.sql`
      SELECT
        -- Determinar banda basándose en tipo y multiplicador
        CASE
          WHEN j.type = 'REVENTADO' THEN 200
          WHEN j."finalMultiplierX" >= 1 AND j."finalMultiplierX" <= 80 THEN 80
          WHEN j."finalMultiplierX" >= 81 AND j."finalMultiplierX" <= 85 THEN 85
          WHEN j."finalMultiplierX" >= 86 AND j."finalMultiplierX" <= 90 THEN 90
          WHEN j."finalMultiplierX" >= 91 AND j."finalMultiplierX" <= 92 THEN 92
          ELSE 92 -- fallback para valores fuera de rango
        END as banda,

        l.id as "loteriaId",
        l.name as "loteriaNombre",

        -- Extraer turno (hora) del sorteo en formato "HH:MM"
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') as turno,

        -- Métricas
        COALESCE(SUM(j.amount), 0)::FLOAT as "totalVendida",
        COALESCE(SUM(j.payout), 0)::FLOAT as ganado,
        COALESCE(SUM(j."commissionAmount"), 0)::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos, -- placeholder
        COUNT(DISTINCT t.id)::INT as "ticketsCount",
        COUNT(j.id)::INT as "jugadasCount"

      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "Loteria" l ON t."loteriaId" = l.id

      WHERE
        t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${whereConditions}

      GROUP BY
        banda,
        l.id,
        l.name,
        turno

      ORDER BY
        banda ASC,
        l.name ASC,
        turno ASC
    `;

    const result = await prisma.$queryRaw<CierreAggregateRow[]>(query);

    return result.map((row: any) => ({
      ...row,
      banda: Number(row.banda) as BandaMultiplicador,
    }));
  }

  /**
   * Ejecuta agregación SQL por vendedor
   */
  private static async executeSellerAggregation(
    filters: CierreFilters
  ): Promise<VendedorAggregateRow[]> {
    const whereConditions = this.buildWhereConditions(filters);

    const query = Prisma.sql`
      SELECT
        u.id as "vendedorId",
        u.name as "vendedorNombre",
        v.id as "ventanaId",
        v.name as "ventanaNombre",

        -- Banda (opcional, para desglose)
        CASE
          WHEN j.type = 'REVENTADO' THEN 200
          WHEN j."finalMultiplierX" >= 1 AND j."finalMultiplierX" <= 80 THEN 80
          WHEN j."finalMultiplierX" >= 81 AND j."finalMultiplierX" <= 85 THEN 85
          WHEN j."finalMultiplierX" >= 86 AND j."finalMultiplierX" <= 90 THEN 90
          WHEN j."finalMultiplierX" >= 91 AND j."finalMultiplierX" <= 92 THEN 92
          ELSE 92
        END as banda,

        -- Métricas
        COALESCE(SUM(j.amount), 0)::FLOAT as "totalVendida",
        COALESCE(SUM(j.payout), 0)::FLOAT as ganado,
        COALESCE(SUM(j."commissionAmount"), 0)::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        COUNT(DISTINCT t.id)::INT as "ticketsCount",
        COUNT(j.id)::INT as "jugadasCount"

      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      INNER JOIN "User" u ON t."vendedorId" = u.id
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id

      WHERE
        t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${whereConditions}

      GROUP BY
        u.id,
        u.name,
        v.id,
        v.name,
        banda

      ORDER BY
        u.name ASC,
        banda ASC
    `;

    const result = await prisma.$queryRaw<VendedorAggregateRow[]>(query);

    return result.map((row: any) => ({
      ...row,
      banda: row.banda ? (Number(row.banda) as BandaMultiplicador) : undefined,
    }));
  }

  /**
   * Construye condiciones WHERE dinámicas
   */
  private static buildWhereConditions(filters: CierreFilters): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];

    // Rango de fechas (obligatorio)
    conditions.push(Prisma.sql`t."createdAt" >= ${filters.fromDate}`);
    conditions.push(Prisma.sql`t."createdAt" <= ${filters.toDate}`);

    // Filtro de ventana
    if (filters.ventanaId) {
      conditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
    }

    // Filtro de lotería (opcional)
    if (filters.loteriaId) {
      conditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
    }

    // Filtro de vendedor (opcional)
    if (filters.vendedorId) {
      conditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
    }

    // Combinar condiciones con AND
    if (conditions.length === 0) {
      return Prisma.empty;
    }

    return Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}`;
  }

  /**
   * Transforma datos raw en estructura jerárquica weekly
   */
  private static transformWeeklyData(rawData: CierreAggregateRow[]): {
    totals: CeldaMetrics;
    bands: Record<BandaMultiplicador, BandaMetrics>;
  } {
    // Inicializar estructura
    const bands: Record<BandaMultiplicador, BandaMetrics> = {} as any;

    for (const banda of ALL_BANDS) {
      bands[banda] = {
        loterias: {} as any,
        total: this.createEmptyMetrics(),
      };
    }

    const totals = this.createEmptyMetrics();

    // Procesar cada fila
    for (const row of rawData) {
      const banda = row.banda;
      const loteriaNombre = this.normalizeLoteriaName(row.loteriaNombre);

      // Inicializar lotería si no existe
      if (!bands[banda].loterias[loteriaNombre]) {
        bands[banda].loterias[loteriaNombre] = {
          turnos: {},
          subtotal: this.createEmptyMetrics(),
        };
      }

      // Crear métricas del turno
      const turnoMetrics: TurnoMetrics = {
        turno: row.turno,
        ...this.rowToMetrics(row),
      };

      // Asignar al turno
      bands[banda].loterias[loteriaNombre].turnos[row.turno] = turnoMetrics;

      // Acumular en subtotal de lotería
      this.accumulateMetrics(
        bands[banda].loterias[loteriaNombre].subtotal,
        turnoMetrics
      );

      // Acumular en total de banda
      this.accumulateMetrics(bands[banda].total, turnoMetrics);

      // Acumular en totales globales
      this.accumulateMetrics(totals, turnoMetrics);
    }

    return { totals, bands };
  }

  /**
   * Transforma datos raw de vendedores
   */
  private static transformSellerData(
    rawData: VendedorAggregateRow[],
    top?: number,
    orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' = 'totalVendida'
  ): {
    totals: CeldaMetrics;
    vendedores: VendedorMetrics[];
  } {
    // Agrupar por vendedor
    const vendedorMap = new Map<string, VendedorMetrics>();

    for (const row of rawData) {
      if (!vendedorMap.has(row.vendedorId)) {
        vendedorMap.set(row.vendedorId, {
          vendedorId: row.vendedorId,
          vendedorNombre: row.vendedorNombre,
          ventanaId: row.ventanaId,
          ventanaNombre: row.ventanaNombre,
          ...this.createEmptyMetrics(),
          bands: {} as any,
        });
      }

      const vendedor = vendedorMap.get(row.vendedorId)!;
      const rowMetrics = this.rowToMetrics(row);

      // Acumular en total del vendedor
      this.accumulateMetrics(vendedor, rowMetrics);

      // Acumular en banda específica (si aplica)
      if (row.banda) {
        if (!vendedor.bands![row.banda]) {
          vendedor.bands![row.banda] = this.createEmptyMetrics();
        }
        this.accumulateMetrics(vendedor.bands![row.banda], rowMetrics);
      }
    }

    // Convertir a array
    let vendedores = Array.from(vendedorMap.values());

    // Ordenar
    vendedores.sort((a, b) => {
      const aVal = a[orderBy];
      const bVal = b[orderBy];
      return bVal - aVal; // descendente
    });

    // Limitar resultados
    if (top && top > 0) {
      vendedores = vendedores.slice(0, top);
    }

    // Calcular totales globales
    const totals = this.createEmptyMetrics();
    for (const vendedor of vendedores) {
      this.accumulateMetrics(totals, vendedor);
    }

    return { totals, vendedores };
  }

  /**
   * Normaliza nombre de lotería a tipo estándar
   */
  private static normalizeLoteriaName(name: string): LoteriaType {
    const normalized = name.toUpperCase().trim();

    if (normalized.includes('TICA')) return 'TICA';
    if (normalized.includes('PANAMA') || normalized.includes('PANAMÁ'))
      return 'PANAMA';
    if (normalized.includes('HONDURAS')) return 'HONDURAS';
    if (normalized.includes('PRIMERA')) return 'PRIMERA';

    // Fallback: retornar como-is (asumiendo que coincide)
    return normalized as LoteriaType;
  }

  /**
   * Convierte una fila raw a métricas
   */
  private static rowToMetrics(
    row: CierreAggregateRow | VendedorAggregateRow
  ): CeldaMetrics {
    const netoDespuesComision = row.totalVendida - row.comisionTotal;

    return {
      totalVendida: row.totalVendida,
      ganado: row.ganado,
      comisionTotal: row.comisionTotal,
      netoDespuesComision,
      refuerzos: row.refuerzos,
      ticketsCount: row.ticketsCount,
      jugadasCount: row.jugadasCount,
    };
  }

  /**
   * Crea métricas vacías
   */
  private static createEmptyMetrics(): CeldaMetrics {
    return {
      totalVendida: 0,
      ganado: 0,
      comisionTotal: 0,
      netoDespuesComision: 0,
      refuerzos: 0,
      ticketsCount: 0,
      jugadasCount: 0,
    };
  }

  /**
   * Acumula métricas de origen en destino
   */
  private static accumulateMetrics(
    target: CeldaMetrics,
    source: CeldaMetrics
  ): void {
    target.totalVendida += source.totalVendida;
    target.ganado += source.ganado;
    target.comisionTotal += source.comisionTotal;
    target.netoDespuesComision += source.netoDespuesComision;
    target.refuerzos += source.refuerzos;
    target.ticketsCount += source.ticketsCount;
    target.jugadasCount += source.jugadasCount;
  }

  /**
   * Convierte Date a ISO con zona horaria Costa Rica
   */
  private static toCostaRicaISO(date: Date): string {
    // Formatear con offset -06:00
    const isoString = date.toISOString();
    // Reemplazar Z con -06:00 (simplificación; en producción usar librería de TZ)
    return isoString.replace('Z', '-06:00');
  }
}
