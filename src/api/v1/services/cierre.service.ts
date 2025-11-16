import { Prisma } from '@prisma/client';
import prisma from '../../../core/prismaClient';
import {
  CierreFilters,
  CierreWeeklyData,
  CierreBySellerData,
  CierrePerformance,
  CeldaMetrics,
  TurnoMetrics,
  LoteriaMetrics,
  BandaMetrics,
  VendedorMetrics,
  CierreAggregateRow,
  VendedorAggregateRow,
  LoteriaType,
} from '../types/cierre.types';
import { CierreMetaExtras, BandsUsedMetadata } from '../types/cierre.types';
import { createHash } from 'crypto';
import logger from '../../../core/logger';

/**
 * Servicio para Cierre Operativo
 * Agrega datos de ventas por banda, lotería, turno y vendedor
 */
export class CierreService {
  private static readonly TIMEZONE = 'America/Costa_Rica';

  /**
   * Agrega datos semanales por banda, lotería y turno
   * Retorna solo datos + performance metrics (controlador agrega meta)
   */
  static async aggregateWeekly(
    filters: CierreFilters
  ): Promise<CierreWeeklyData & { _performance: CierrePerformance; _metaExtras: CierreMetaExtras }> {
    const startTime = Date.now();
    let queryCount = 0;

    // Ejecutar agregación principal
    const rawData = await this.executeWeeklyAggregation(filters);
    queryCount += 1;

    // Transformar datos en estructura jerárquica
    const { totals, bands } = this.transformWeeklyData(rawData);

    // Calcular anomalías (jugadas fuera de banda)
    const anomalies = await computeAnomalies(filters);
    queryCount += 2; // count + sample

    // Calcular bandsUsed y configHash
    const bandsUsed = computeBandsUsedFromWeekly(rawData);
    const configHash = hashConfig(bandsUsed);

    return {
      totals,
      bands,
      _performance: {
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
      },
      _metaExtras: {
        bandsUsed,
        configHash,
        anomalies,
      },
    };
  }

  /**
   * Agrega datos por vendedor
   * Retorna solo datos + performance metrics (controlador agrega meta)
   */
  static async aggregateBySeller(
    filters: CierreFilters,
    top?: number,
    orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' = 'totalVendida'
  ): Promise<CierreBySellerData & { _performance: CierrePerformance; _metaExtras: CierreMetaExtras }> {
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

    // bandsUsed desde datos de vendedor
    const bandsUsed = computeBandsUsedFromSeller(rawData);
    const configHash = hashConfig(bandsUsed);

    // Anomalías comunes al periodo
    const anomalies = await computeAnomalies(filters);
    queryCount += 2;

    return {
      totals,
      vendedores,
      _performance: {
        queryExecutionTime: Date.now() - startTime,
        totalQueries: queryCount,
      },
      _metaExtras: {
        bandsUsed,
        configHash,
        anomalies,
      },
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
      WITH base AS (
        SELECT
          j.id                AS "jugadaId",
          j.type              AS type,
          j."finalMultiplierX" AS "finalMultiplierX",
          j.amount            AS amount,
          j.payout            AS payout,
          j."commissionAmount" AS "commissionAmount",
          t.id                AS "ticketId",
          t."ventanaId"       AS "ventanaId",
          t."loteriaId"       AS "loteriaId",
          t."sorteoId"        AS "sorteoId",
          t."createdAt"       AS "ticketCreatedAt",
          s."scheduledAt"     AS "scheduledAt",
          CASE
            WHEN j.type = 'REVENTADO' THEN 200
            WHEN j.type = 'NUMERO' AND EXISTS (
              SELECT 1 FROM "LoteriaMultiplier" lm
              WHERE lm."loteriaId" = t."loteriaId"
                AND lm."kind" = 'NUMERO'
                AND lm."valueX" = j."finalMultiplierX"
                AND lm."isActive" = true
                AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
                AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
            ) THEN j."finalMultiplierX"
            ELSE NULL
          END AS banda
        FROM "Jugada" j
        INNER JOIN "Ticket" t ON j."ticketId" = t.id
        INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
        INNER JOIN "Ventana" v ON t."ventanaId" = v.id
        WHERE
          t."deletedAt" IS NULL
          AND j."deletedAt" IS NULL
          ${whereConditions}
      )
      SELECT
        CAST(base.banda AS INT) AS banda,
        l.id as "loteriaId",
        l.name as "loteriaNombre",
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') as turno,
        COALESCE(SUM(base.amount), 0)::FLOAT as "totalVendida",
        COALESCE(SUM(base.payout), 0)::FLOAT as ganado,
        COALESCE(SUM(base."commissionAmount"), 0)::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        COUNT(DISTINCT base."ticketId")::INT as "ticketsCount",
        COUNT(base."jugadaId")::INT as "jugadasCount"
      FROM base
      INNER JOIN "Loteria" l ON l.id = base."loteriaId"
      WHERE base.banda IS NOT NULL
      GROUP BY
        CAST(base.banda AS INT),
        l.id,
        l.name,
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI')
      ORDER BY
        CAST(base.banda AS INT) ASC,
        l.name ASC,
        turno ASC
    `;

    const result = await prisma.$queryRaw<CierreAggregateRow[]>(query);

    return result.map((row: any) => ({
      ...row,
      banda: Number(row.banda),
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
          WHEN EXISTS (
            SELECT 1 FROM "LoteriaMultiplier" lm
            WHERE lm."loteriaId" = t."loteriaId"
              AND lm."kind" = 'NUMERO'
              AND lm."valueX" = j."finalMultiplierX"
              AND lm."isActive" = true
              AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
              AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
          ) THEN j."finalMultiplierX"
          ELSE NULL
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
        AND (
          j.type = 'REVENTADO' OR (
            j.type = 'NUMERO' AND EXISTS (
              SELECT 1 FROM "LoteriaMultiplier" lm
              WHERE lm."loteriaId" = t."loteriaId"
                AND lm."kind" = 'NUMERO'
                AND lm."valueX" = j."finalMultiplierX"
                AND lm."isActive" = true
                AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
                AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
            )
          )
        )

      GROUP BY
        u.id,
        u.name,
        v.id,
        v.name,
        CASE
          WHEN j.type = 'REVENTADO' THEN 200
          WHEN EXISTS (
            SELECT 1 FROM "LoteriaMultiplier" lm
            WHERE lm."loteriaId" = t."loteriaId"
              AND lm."kind" = 'NUMERO'
              AND lm."valueX" = j."finalMultiplierX"
              AND lm."isActive" = true
              AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
              AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
          ) THEN j."finalMultiplierX"
          ELSE NULL
        END

      ORDER BY
        u.name ASC,
        banda ASC
    `;

    const result = await prisma.$queryRaw<VendedorAggregateRow[]>(query);

    return result.map((row: any) => ({
      ...row,
      banda: row.banda != null ? Number(row.banda) : undefined,
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
    // Filtrar por banca activa (para ADMIN multibanca)
    if (filters.bancaId) {
      conditions.push(Prisma.sql`v."bancaId" = ${filters.bancaId}::uuid`);
    }

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
    bands: Record<string, BandaMetrics>;
  } {
    const bands: Record<string, BandaMetrics> = {};
    const totals = this.createEmptyMetrics();

    for (const row of rawData) {
      const bandaKey = String(Number(row.banda));
      const loteriaNombre = this.normalizeLoteriaName(row.loteriaNombre);

      if (!bands[bandaKey]) {
        bands[bandaKey] = {
          loterias: {} as any,
          total: this.createEmptyMetrics(),
        };
      }

      if (!bands[bandaKey].loterias[loteriaNombre]) {
        bands[bandaKey].loterias[loteriaNombre] = {
          turnos: {},
          subtotal: this.createEmptyMetrics(),
        };
      }

      const turnoMetrics: TurnoMetrics = {
        turno: row.turno,
        ...this.rowToMetrics(row),
      };

      bands[bandaKey].loterias[loteriaNombre].turnos[row.turno] = turnoMetrics;

      this.accumulateMetrics(
        bands[bandaKey].loterias[loteriaNombre].subtotal,
        turnoMetrics
      );

      this.accumulateMetrics(bands[bandaKey].total, turnoMetrics);

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

}

// ========================= Helpers Meta =========================
// ========================= Meta builders =========================

export interface AnomalyRow {
  jugadaId: string;
  ticketId: string;
  loteriaId: string;
  loteriaNombre: string;
  finalMultiplierX: number;
  createdAt: Date;
  amount: number;
}

export interface AnomaliesResult {
  outOfBandCount: number;
  examples: {
    jugadaId: string;
    ticketId: string;
    loteriaId: string;
    loteriaNombre: string;
    finalMultiplierX: number;
    createdAt: string;
    amount: number;
  }[];
}

// Construye bandsUsed a partir de la estructura resultado
function computeBandsUsedFromWeekly(rawData: CierreAggregateRow[]): BandsUsedMetadata {
  const byLoteriaSet: Record<string, Set<number>> = {};
  const globalSet: Set<number> = new Set();
  const dedupDetail = new Set<string>();
  const details: BandsUsedMetadata['details'] = [];

  for (const row of rawData) {
    const loteriaNombre = row.loteriaNombre.toUpperCase().trim();
    const banda = Number(row.banda);
    globalSet.add(banda);
    if (!byLoteriaSet[loteriaNombre]) byLoteriaSet[loteriaNombre] = new Set<number>();
    byLoteriaSet[loteriaNombre].add(banda);

    const key = `${row.loteriaId}:${banda}`;
    if (!dedupDetail.has(key)) {
      dedupDetail.add(key);
      details.push({
        loteriaId: row.loteriaId,
        loteriaNombre: loteriaNombre,
        value: banda,
        effectiveFrom: null,
        effectiveTo: null,
      });
    }
  }

  const byLoteria: Record<string, number[]> = {};
  for (const [name, set] of Object.entries(byLoteriaSet)) {
    byLoteria[name] = Array.from(set).sort((a, b) => a - b);
  }

  return {
    byLoteria,
    global: Array.from(globalSet).sort((a, b) => a - b),
    details,
  };
}

// Variante para datos por vendedor
function computeBandsUsedFromSeller(rows: VendedorAggregateRow[]): BandsUsedMetadata {
  const globalSet: Set<number> = new Set();
  for (const r of rows) {
    if (r.banda != null) globalSet.add(Number(r.banda));
  }
  return { byLoteria: {}, global: Array.from(globalSet).sort((a, b) => a - b), details: [] };
}

// Hash estable de configuración usada (a partir de bandsUsed)
function hashConfig(bandsUsed: BandsUsedMetadata): string {
  const normalized = {
    byLoteria: Object.keys(bandsUsed.byLoteria)
      .sort()
      .reduce((acc, k) => {
        acc[k] = [...bandsUsed.byLoteria[k]].sort((a, b) => a - b);
        return acc;
      }, {} as Record<string, number[]>),
    global: [...bandsUsed.global].sort((a, b) => a - b),
  };

  const h = createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
  return h;
}

// Anomalías: jugadas NUMERO sin configuración vigente
async function computeAnomalies(filters: CierreFilters): Promise<AnomaliesResult> {
  // Construir condiciones WHERE (repetimos lógica para uso fuera de la clase)
  const conditions: Prisma.Sql[] = [];
  conditions.push(Prisma.sql`t."createdAt" >= ${filters.fromDate}`);
  conditions.push(Prisma.sql`t."createdAt" <= ${filters.toDate}`);
  // Filtrar por banca activa (para ADMIN multibanca)
  if (filters.bancaId) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v 
      WHERE v.id = t."ventanaId" 
      AND v."bancaId" = ${filters.bancaId}::uuid
    )`);
  }
  if (filters.ventanaId) conditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
  if (filters.loteriaId) conditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
  if (filters.vendedorId) conditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
  const whereConditions = conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const countQuery = Prisma.sql`
    SELECT COUNT(*)::INT as cnt
    FROM "Jugada" j
    INNER JOIN "Ticket" t ON j."ticketId" = t.id
    WHERE
      t."deletedAt" IS NULL
      AND j."deletedAt" IS NULL
      ${whereConditions}
      AND j.type = 'NUMERO'
      AND NOT EXISTS (
        SELECT 1 FROM "LoteriaMultiplier" lm
        WHERE lm."loteriaId" = t."loteriaId"
          AND lm."kind" = 'NUMERO'
          AND lm."valueX" = j."finalMultiplierX"
          AND lm."isActive" = true
          AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
          AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
      )
  `;

  const [{ cnt }] = await prisma.$queryRaw<{ cnt: number }[]>(countQuery);

  let examples: AnomaliesResult['examples'] = [];
  if (cnt > 0) {
    const sampleQuery = Prisma.sql`
      SELECT
        j.id as "jugadaId",
        t.id as "ticketId",
        t."loteriaId" as "loteriaId",
        l.name as "loteriaNombre",
        j."finalMultiplierX" as "finalMultiplierX",
        j."createdAt" as "createdAt",
        j.amount as amount
      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      INNER JOIN "Loteria" l ON t."loteriaId" = l.id
      WHERE
        t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        ${whereConditions}
        AND j.type = 'NUMERO'
        AND NOT EXISTS (
          SELECT 1 FROM "LoteriaMultiplier" lm
          WHERE lm."loteriaId" = t."loteriaId"
            AND lm."kind" = 'NUMERO'
            AND lm."valueX" = j."finalMultiplierX"
            AND lm."isActive" = true
            AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
            AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
        )
      ORDER BY j."createdAt" ASC
      LIMIT 5
    `;

    const sampleRows = await prisma.$queryRaw<AnomalyRow[]>(sampleQuery);
    examples = sampleRows.map((r) => ({
      jugadaId: r.jugadaId,
      ticketId: r.ticketId,
      loteriaId: r.loteriaId,
      loteriaNombre: r.loteriaNombre,
      finalMultiplierX: Number(r.finalMultiplierX),
      createdAt: new Date(r.createdAt).toISOString(),
      amount: Number(r.amount),
    }));
  }

  if (cnt > 0) {
    try {
      logger.info({
        layer: 'service',
        action: 'CIERRE_ANOMALIES_DETECTED',
        payload: {
          periodFrom: filters.fromDate.toISOString(),
          periodTo: filters.toDate.toISOString(),
          outOfBandCount: cnt,
        },
      });
    } catch {}
  }

  return { outOfBandCount: cnt, examples };
}
