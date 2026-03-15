import { Prisma } from '@prisma/client';
import prisma from '../../../core/prismaClient';
import { CacheService } from '../../../core/cache.service';
import crypto from 'crypto';

const _cierreInFlight = new Map<string, Promise<any>>();

function cierreWrap<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const inFlight = _cierreInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = CacheService.wrap(key, fn, ttl, [`cierre:${key}`]);
  _cierreInFlight.set(key, promise);
  promise.finally(() => _cierreInFlight.delete(key));
  return promise;
}
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
  VendedorAggregateRowWithDate,
  CierreBySellerExportData,
  BandExportData,
  SellerLoteriaRow,
  LoteriaType,
  CierreLoteriaGroup,
  CierreSorteoGroup,
  CierreBandData,
  JugadaTipo,
} from '../types/cierre.types';
import { CierreMetaExtras, BandsUsedMetadata } from '../types/cierre.types';
import { createHash } from 'crypto';
import logger from '../../../core/logger';
import { crDateService } from '../../../utils/crDateService';
import { isExclusionListEmpty } from '../../../core/exclusionListCache';

/** Fila interna para el desglose vendedor × lotería × sorteo × tipo × banda */
interface SellerSorteoAggregateRow {
  vendedorId: string;
  vendedorNombre: string;
  ventanaId: string;
  ventanaNombre: string;
  loteriaId: string;
  loteriaNombre: string;
  sorteoId: string;
  turno: string;
  scheduledAt: Date;
  tipo: JugadaTipo;
  banda: number;
  totalVendida: number;
  ganado: number;
  comisionTotal: number;
  refuerzos: number;
  ticketsCount: number;
  jugadasCount: number;
}

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
    const cacheKey = `cierre:weekly:${crypto.createHash('md5').update(JSON.stringify({
      from: filters.fromDate.toISOString(),
      to: filters.toDate.toISOString(),
      scope: filters.scope,
      ventanaId: filters.ventanaId || null,
      bancaId: filters.bancaId || null,
      loteriaId: filters.loteriaId || null,
    })).digest('hex')}`;

    const todayCR = crDateService.dateUTCToCRString(new Date());
    const isHistorical = crDateService.dateUTCToCRString(filters.fromDate) !== todayCR && 
                        crDateService.dateUTCToCRString(filters.toDate) !== todayCR;
    const ttl = isHistorical ? 3600 : 120;

    return cierreWrap(cacheKey, ttl, async () => {
      const startTime = Date.now();
      let queryCount = 0;

      // Ejecutar agregación principal y anomalías en paralelo
      const [rawData, anomalies] = await Promise.all([
        this.executeWeeklyAggregation(filters).then(d => { queryCount += 1; return d; }),
        computeAnomalies(filters).then(a => { queryCount += 2; return a; }),
      ]);

      // Transformar datos en estructura jerárquica (Lotería → Sorteo → Tipo → Banda)
      const { loterias, totals, orphanedDataCount } = this.transformWeeklyDataByLoteriaSorteo(rawData);

      if (orphanedDataCount !== undefined && orphanedDataCount > 0) {
        anomalies.orphanedDataCount = orphanedDataCount;
      }

      const bandsUsed = computeBandsUsedFromWeekly(rawData);
      const configHash = hashConfig(bandsUsed);

      return {
        loterias,
        totals,
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
    });
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
    const todayCR = crDateService.dateUTCToCRString(new Date());
    const isHistorical = crDateService.dateUTCToCRString(filters.fromDate) !== todayCR && 
                        crDateService.dateUTCToCRString(filters.toDate) !== todayCR;
    const ttl = isHistorical ? 3600 : 120;

    const cacheKey = `cierre:by-seller:${crypto.createHash('md5').update(JSON.stringify({
      from: filters.fromDate.toISOString(),
      to: filters.toDate.toISOString(),
      scope: filters.scope,
      ventanaId: filters.ventanaId || null,
      bancaId: filters.bancaId || null,
      loteriaId: filters.loteriaId || null,
      top: top || null,
      orderBy,
    })).digest('hex')}`;

    return cierreWrap(cacheKey, ttl, async () => {
      const startTime = Date.now();
      let queryCount = 0;

      // OPTIMIZACIÓN: Se consolida executeSellerAggregation y executeSellerAggregationBySorteo
      // executeSellerAggregationBySorteo ya contiene todo el detalle necesario.
      const [sorteoData, anomalies] = await Promise.all([
        this.executeSellerAggregationBySorteo(filters).then(d => { queryCount += 1; return d; }),
        computeAnomalies(filters).then(a => { queryCount += 1; return a; }),
      ]);

      // Generar rawData (agregado general por vendedor/banda) en memoria
      const rawData = this.aggregateSorteoDataToGeneral(sorteoData);

      const sellerLoterias = this.buildSellerLoterias(sorteoData);
      const { totals, vendedores } = this.transformSellerData(rawData, top, orderBy, sellerLoterias);
      const bandsUsed = computeBandsUsedFromSeller(rawData);
      const configHash = hashConfig(bandsUsed);

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
    });
  }

  /**
   * Transforma datos de sorteos en datos generales por vendedor y banda en memoria
   */
  private static aggregateSorteoDataToGeneral(
    sorteoData: SellerSorteoAggregateRow[]
  ): VendedorAggregateRow[] {
    const map = new Map<string, VendedorAggregateRow>();

    for (const row of sorteoData) {
      const key = `${row.vendedorId}|${row.banda}`;
      if (!map.has(key)) {
        map.set(key, {
          vendedorId: row.vendedorId,
          vendedorNombre: row.vendedorNombre,
          ventanaId: row.ventanaId,
          ventanaNombre: row.ventanaNombre,
          banda: row.banda,
          totalVendida: 0,
          ganado: 0,
          comisionTotal: 0,
          refuerzos: 0,
          ticketsCount: 0,
          jugadasCount: 0,
        });
      }
      const agg = map.get(key)!;
      agg.totalVendida += row.totalVendida;
      agg.ganado += row.ganado;
      agg.comisionTotal += row.comisionTotal;
      agg.refuerzos += row.refuerzos;
      agg.ticketsCount += row.ticketsCount;
      agg.jugadasCount += row.jugadasCount;
    }

    return Array.from(map.values());
  }

  /**
   * Agrega datos por vendedor con desglose por banda y día — para export Excel
   * REVENTADO hereda la banda de su NUMERO asociado (igual que el weekly)
   */
  static async aggregateBySellerForExport(
    filters: CierreFilters
  ): Promise<CierreBySellerExportData> {
    const rawData = await this.executeSellerAggregationByDay(filters);
    return this.transformSellerDataForExport(rawData);
  }

  /**
   * Query de vendedores por día, lotería y turno con banda correcta para REVENTADO
   * Agrega por (vendedor, ventana, lotería, turno, banda, fecha)
   */
  private static async executeSellerAggregationByDay(
    filters: CierreFilters
  ): Promise<VendedorAggregateRowWithDate[]> {
    const whereConditions = await this.buildWhereConditions(filters);
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);

    const query = Prisma.sql`
      WITH
        relevant_tickets AS MATERIALIZED (
          SELECT t.id
          FROM "Ticket" t
          WHERE
            t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date
            AND t."isActive" = true
            AND t."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        lm_active AS MATERIALIZED (
          SELECT
            lm."loteriaId",
            lm."valueX",
            lm."appliesToDate",
            lm."appliesToSorteoId"
          FROM "LoteriaMultiplier" lm
          WHERE lm."kind" = 'NUMERO'
            AND lm."isActive" = true
        ),
        numero_bandas AS MATERIALIZED (
          SELECT
            j."ticketId",
            j.number,
            MIN(j."finalMultiplierX") AS banda
          FROM "Jugada" j
          INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
          WHERE j.type = 'NUMERO'
            AND j."isActive" = true
            AND j."deletedAt" IS NULL
          GROUP BY j."ticketId", j.number
        ),
        base AS (
          SELECT
            u.id          AS uid,
            u.name        AS uname,
            v.id          AS vid,
            v.name        AS vname,
            l.id          AS "loteriaId",
            l.name        AS "loteriaNombre",
            t.id          AS "ticketId",
            t."businessDate" AS "businessDate",
            TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') AS turno,
            j.type          AS tipo,
            j.amount,
            j.payout,
            j."listeroCommissionAmount",
            CASE
              WHEN j.type = 'NUMERO' AND EXISTS (
                SELECT 1 FROM lm_active lm
                WHERE lm."loteriaId" = t."loteriaId"
                  AND lm."valueX" = j."finalMultiplierX"
                  AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
                  AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
              ) THEN j."finalMultiplierX"
              WHEN j.type = 'REVENTADO' THEN nb.banda
              ELSE NULL
            END AS banda
          FROM "Jugada" j
          INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
          INNER JOIN "Ticket" t ON j."ticketId" = t.id
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "Loteria" l ON l.id = t."loteriaId"
          INNER JOIN "User" u ON t."vendedorId" = u.id
          INNER JOIN "Ventana" v ON t."ventanaId" = v.id
          LEFT JOIN numero_bandas nb ON nb."ticketId" = j."ticketId"
            AND nb.number = j.number
            AND j.type = 'REVENTADO'
          WHERE
            t."deletedAt" IS NULL
            AND j."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            AND t."isActive" = true
            AND j."isActive" = true
            AND s."status" = 'EVALUATED'
            ${whereConditions}
        )
      SELECT
        base.uid             AS "vendedorId",
        base.uname           AS "vendedorNombre",
        base.vid             AS "ventanaId",
        base.vname           AS "ventanaNombre",
        base."loteriaId",
        base."loteriaNombre",
        base.turno,
        base.tipo,
        base.banda,
        TO_CHAR(base."businessDate", 'YYYY-MM-DD')                  AS fecha,
        COALESCE(SUM(base.amount), 0)::FLOAT                        AS "totalVendida",
        COALESCE(SUM(base.payout), 0)::FLOAT                        AS ganado,
        COALESCE(SUM(base."listeroCommissionAmount"), 0)::FLOAT      AS "comisionTotal",
        0::FLOAT                                                     AS refuerzos,
        COUNT(DISTINCT base."ticketId")::INT                        AS "ticketsCount",
        COUNT(*)::INT                                               AS "jugadasCount"
      FROM base
      WHERE base.banda IS NOT NULL
      GROUP BY
        base.uid, base.uname, base.vid, base.vname,
        base."loteriaId", base."loteriaNombre",
        base.turno, base.tipo, base.banda,
        TO_CHAR(base."businessDate", 'YYYY-MM-DD')
      ORDER BY
        base.uname ASC,
        base."loteriaNombre" ASC,
        base.turno ASC,
        base.tipo ASC,
        base.banda ASC,
        TO_CHAR(base."businessDate", 'YYYY-MM-DD') ASC
    `;

    const result = await prisma.$queryRaw<VendedorAggregateRowWithDate[]>(query);

    return result.map((row: any) => ({
      ...row,
      banda: row.banda != null ? Number(row.banda) : undefined,
    }));
  }

  /**
   * Transforma filas raw (vendedor × lotería × turno × banda × día) en estructura pivot por banda
   */
  private static transformSellerDataForExport(
    rawData: VendedorAggregateRowWithDate[]
  ): CierreBySellerExportData {
    // banda → (vendedorId|loteriaId|turno) → SellerLoteriaRow
    const bandMap = new Map<number, {
      rowMap: Map<string, SellerLoteriaRow>;
      fechasSet: Set<string>;
      total: CeldaMetrics;
    }>();
    const grandTotal = this.createEmptyMetrics();

    for (const row of rawData) {
      if (row.banda == null) continue;
      const banda = Number(row.banda);

      if (!bandMap.has(banda)) {
        bandMap.set(banda, { rowMap: new Map(), fechasSet: new Set(), total: this.createEmptyMetrics() });
      }
      const bandEntry = bandMap.get(banda)!;
      bandEntry.fechasSet.add(row.fecha);

      const rowKey = `${row.vendedorId}|${row.loteriaId}|${row.turno}|${row.tipo}`;
      if (!bandEntry.rowMap.has(rowKey)) {
        bandEntry.rowMap.set(rowKey, {
          vendedorId: row.vendedorId,
          vendedorNombre: row.vendedorNombre,
          ventanaNombre: row.ventanaNombre,
          loteriaId: row.loteriaId,
          loteriaNombre: row.loteriaNombre,
          turno: row.turno,
          tipo: row.tipo,
          dias: {},
          total: this.createEmptyMetrics(),
        });
      }

      const loteriaRow = bandEntry.rowMap.get(rowKey)!;
      const metrics = this.rowToMetrics(row);

      loteriaRow.dias[row.fecha] = metrics;
      this.accumulateMetrics(loteriaRow.total, metrics);
      this.accumulateMetrics(bandEntry.total, metrics);
      this.accumulateMetrics(grandTotal, metrics);
    }

    // Construir array de bandas ordenadas
    const bands: BandExportData[] = Array.from(bandMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([band, { rowMap, fechasSet, total }]) => {
        const fechas = Array.from(fechasSet).sort();
        const rows = Array.from(rowMap.values())
          .sort((a, b) =>
            a.vendedorNombre.localeCompare(b.vendedorNombre) ||
            a.loteriaNombre.localeCompare(b.loteriaNombre) ||
            a.turno.localeCompare(b.turno) ||
            a.tipo.localeCompare(b.tipo)
          );
        return { band, fechas, rows, total };
      });

    return { bands, total: grandTotal };
  }

  /**
   * Ejecuta agregación SQL para datos semanales
   */
  private static async executeWeeklyAggregation(
    filters: CierreFilters
  ): Promise<CierreAggregateRow[]> {
    const whereConditions = await this.buildWhereConditions(filters);
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);

    // OPTIMIZACIÓN: Tres CTEs eliminan el Seq Scan completo de Jugada:
    // ① relevant_tickets: pre-filtra tickets del periodo → reduce Jugada de 867K a ~5K filas/día
    // ② lm_active: materializa LoteriaMultiplier una sola vez → hash lookup en EXISTS
    // ③ numero_bandas: JOIN contra relevant_tickets en lugar de scan global de Jugada
    const query = Prisma.sql`
      WITH
        relevant_tickets AS MATERIALIZED (
          SELECT t.id
          FROM "Ticket" t
          WHERE
            t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date
            AND t."isActive" = true
            AND t."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
        ),
        lm_active AS MATERIALIZED (
          SELECT
            lm."loteriaId",
            lm."valueX",
            lm."appliesToDate",
            lm."appliesToSorteoId"
          FROM "LoteriaMultiplier" lm
          WHERE lm."kind" = 'NUMERO'
            AND lm."isActive" = true
        ),
        numero_bandas AS MATERIALIZED (
          SELECT
            j."ticketId",
            j.number,
            MIN(j."finalMultiplierX") AS banda
          FROM "Jugada" j
          INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
          WHERE j.type = 'NUMERO'
            AND j."isActive" = true
            AND j."deletedAt" IS NULL
          GROUP BY j."ticketId", j.number
        ),
        base AS (
          SELECT
            j.id                AS "jugadaId",
            j.type              AS type,
            j."finalMultiplierX" AS "finalMultiplierX",
            j.amount            AS amount,
            j.payout            AS payout,
            j."listeroCommissionAmount" AS "listeroCommissionAmount",
            t.id                AS "ticketId",
            t."ventanaId"       AS "ventanaId",
            t."loteriaId"       AS "loteriaId",
            t."sorteoId"        AS "sorteoId",
            t."createdAt"       AS "ticketCreatedAt",
            s."scheduledAt"     AS "scheduledAt",
            CASE
              -- NUMERO: EXISTS contra CTE materializado (hash lookup, no escaneo de tabla)
              WHEN j.type = 'NUMERO' AND EXISTS (
                SELECT 1 FROM lm_active lm
                WHERE lm."loteriaId" = t."loteriaId"
                  AND lm."valueX" = j."finalMultiplierX"
                  AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
                  AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
              ) THEN j."finalMultiplierX"

              -- REVENTADO: LEFT JOIN al CTE pre-calculado (hash join, elimina scalar subquery)
              WHEN j.type = 'REVENTADO' THEN nb.banda

              ELSE NULL
            END AS banda
          FROM "Jugada" j
          INNER JOIN "Ticket" t ON j."ticketId" = t.id
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "Ventana" v ON t."ventanaId" = v.id
          LEFT JOIN numero_bandas nb ON nb."ticketId" = j."ticketId"
            AND nb.number = j.number
            AND j.type = 'REVENTADO'
          WHERE
            t."deletedAt" IS NULL
            AND j."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            AND t."isActive" = true
            AND j."isActive" = true
            AND s."status" = 'EVALUATED'
            ${whereConditions}
        )
      SELECT
        CAST(base.banda AS INT) AS banda,
        base.type AS tipo,
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD') as fecha,
        l.id as "loteriaId",
        l.name as "loteriaNombre",
        base."sorteoId" as "sorteoId",
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') as turno,
        MIN(base."scheduledAt") as "scheduledAt",
        COALESCE(SUM(base.amount), 0)::FLOAT as "totalVendida",
        COALESCE(SUM(base.payout), 0)::FLOAT as ganado,
        COALESCE(SUM(base."listeroCommissionAmount"), 0)::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        COUNT(DISTINCT base."ticketId")::INT as "ticketsCount",
        COUNT(base."jugadaId")::INT as "jugadasCount"
      FROM base
      INNER JOIN "Loteria" l ON l.id = base."loteriaId"
      WHERE base.banda IS NOT NULL
      GROUP BY
        CAST(base.banda AS INT),
        base.type,
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD'),
        l.id,
        l.name,
        base."sorteoId",
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI')
      ORDER BY
        l.name ASC,
        turno ASC,
        base.type ASC,
        CAST(base.banda AS INT) ASC
    `;

    // statement_timeout dentro de $transaction para que SET LOCAL sea efectivo con PgBouncer
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '30000'`;
      return tx.$queryRaw<CierreAggregateRow[]>(query);
    }, { timeout: 35000 });

    return result.map((row: any) => ({
      ...row,
      banda: Number(row.banda),
      scheduledAt: row.scheduledAt ? new Date(row.scheduledAt) : undefined,
    }));
  }


  /**
   * Agrega por (vendedor, ventana, lotería, sorteo, turno, tipo, banda) para construir
   * el desglose loterias[] dentro de cada VendedorMetrics.
   * Usa herencia de banda para REVENTADO (igual que weekly).
   */
  private static async executeSellerAggregationBySorteo(
    filters: CierreFilters
  ): Promise<SellerSorteoAggregateRow[]> {
    const whereConditions = await this.buildWhereConditions(filters);
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);

    const query = Prisma.sql`
      WITH
        relevant_tickets AS MATERIALIZED (
          SELECT t.id
          FROM "Ticket" t
          WHERE
            t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date
            AND t."isActive" = true
            AND t."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
        ),
        lm_active AS MATERIALIZED (
          SELECT
            lm."loteriaId",
            lm."valueX",
            lm."appliesToDate",
            lm."appliesToSorteoId"
          FROM "LoteriaMultiplier" lm
          WHERE lm."kind" = 'NUMERO'
            AND lm."isActive" = true
        ),
        numero_bandas AS MATERIALIZED (
          SELECT
            j."ticketId",
            j.number,
            MIN(j."finalMultiplierX") AS banda
          FROM "Jugada" j
          INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
          WHERE j.type = 'NUMERO'
            AND j."isActive" = true
            AND j."deletedAt" IS NULL
          GROUP BY j."ticketId", j.number
        ),
        base AS (
          SELECT
            u.id          AS uid,
            u.name        AS uname,
            v.id          AS vid,
            v.name        AS vname,
            j.id          AS "jugadaId",
            j.type        AS type,
            j.amount,
            j.payout,
            j."listeroCommissionAmount",
            t.id          AS "ticketId",
            t."loteriaId" AS "loteriaId",
            t."sorteoId"  AS "sorteoId",
            s."scheduledAt" AS "scheduledAt",
            CASE
              WHEN j.type = 'NUMERO' AND EXISTS (
                SELECT 1 FROM lm_active lm
                WHERE lm."loteriaId" = t."loteriaId"
                  AND lm."valueX" = j."finalMultiplierX"
                  AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
                  AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
              ) THEN j."finalMultiplierX"
              WHEN j.type = 'REVENTADO' THEN nb.banda
              ELSE NULL
            END AS banda
          FROM "Jugada" j
          INNER JOIN relevant_tickets rt ON rt.id = j."ticketId"
          INNER JOIN "Ticket" t ON j."ticketId" = t.id
          INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
          INNER JOIN "User" u ON t."vendedorId" = u.id
          INNER JOIN "Ventana" v ON t."ventanaId" = v.id
          LEFT JOIN numero_bandas nb ON nb."ticketId" = j."ticketId"
            AND nb.number = j.number
            AND j.type = 'REVENTADO'
          WHERE
            t."deletedAt" IS NULL
            AND j."deletedAt" IS NULL
            AND t."status" != 'CANCELLED'
            AND t."isActive" = true
            AND j."isActive" = true
            AND s."status" = 'EVALUATED'
            ${whereConditions}
        )
      SELECT
        base.uid          AS "vendedorId",
        base.uname        AS "vendedorNombre",
        base.vid          AS "ventanaId",
        base.vname        AS "ventanaNombre",
        CAST(base.banda AS INT) AS banda,
        base.type AS tipo,
        l.id AS "loteriaId",
        l.name AS "loteriaNombre",
        base."sorteoId" AS "sorteoId",
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') AS turno,
        MIN(base."scheduledAt") AS "scheduledAt",
        COALESCE(SUM(base.amount), 0)::FLOAT AS "totalVendida",
        COALESCE(SUM(base.payout), 0)::FLOAT AS ganado,
        COALESCE(SUM(base."listeroCommissionAmount"), 0)::FLOAT AS "comisionTotal",
        0::FLOAT AS refuerzos,
        COUNT(DISTINCT base."ticketId")::INT AS "ticketsCount",
        COUNT(base."jugadaId")::INT AS "jugadasCount"
      FROM base
      INNER JOIN "Loteria" l ON l.id = base."loteriaId"
      WHERE base.banda IS NOT NULL
      GROUP BY
        base.uid, base.uname, base.vid, base.vname,
        CAST(base.banda AS INT),
        base.type,
        l.id, l.name,
        base."sorteoId",
        TO_CHAR(base."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI')
      ORDER BY
        base.uname ASC,
        l.name ASC,
        turno ASC,
        base.type ASC,
        CAST(base.banda AS INT) ASC
    `;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '30000'`;
      return tx.$queryRaw<SellerSorteoAggregateRow[]>(query);
    }, { timeout: 35000 });

    return result.map((row: any) => ({
      ...row,
      banda: Number(row.banda),
      scheduledAt: row.scheduledAt ? new Date(row.scheduledAt) : undefined,
    }));
  }

  /**
   * Agrupa filas de vendedor×sorteo en Map<vendedorId, CierreLoteriaGroup[]>
   * con la misma estructura jerárquica que el endpoint /weekly.
   */
  private static buildSellerLoterias(
    rawData: SellerSorteoAggregateRow[]
  ): Map<string, CierreLoteriaGroup[]> {
    // vendedorId → loteriaId → sorteoKey → { loteria, sorteo, bands, subtotals }
    const vendedorMap = new Map<string, Map<string, {
      loteria: { id: string; name: string };
      sorteos: Map<string, {
        sorteo: { id: string; turno: string; scheduledAt?: string };
        bands: Map<string, CierreBandData>;
        subtotal: CeldaMetrics;
      }>;
      subtotal: CeldaMetrics;
    }>>();

    for (const row of rawData) {
      const { vendedorId, loteriaId, sorteoId, tipo } = row;
      const sorteoKey = `${sorteoId}|${tipo}`;
      const bandaKey = String(row.banda);

      if (!vendedorMap.has(vendedorId)) {
        vendedorMap.set(vendedorId, new Map());
      }
      const loteriaMap = vendedorMap.get(vendedorId)!;

      if (!loteriaMap.has(loteriaId)) {
        loteriaMap.set(loteriaId, {
          loteria: { id: loteriaId, name: row.loteriaNombre },
          sorteos: new Map(),
          subtotal: this.createEmptyMetrics(),
        });
      }
      const loteriaGroup = loteriaMap.get(loteriaId)!;

      if (!loteriaGroup.sorteos.has(sorteoKey)) {
        loteriaGroup.sorteos.set(sorteoKey, {
          sorteo: {
            id: sorteoId,
            turno: `${row.turno} ${tipo === 'NUMERO' ? 'Numero' : 'Reventado'}`,
            scheduledAt: row.scheduledAt?.toISOString(),
          },
          bands: new Map(),
          subtotal: this.createEmptyMetrics(),
        });
      }
      const sorteoGroup = loteriaGroup.sorteos.get(sorteoKey)!;

      const metrics = this.rowToMetrics(row);

      if (!sorteoGroup.bands.has(bandaKey)) {
        sorteoGroup.bands.set(bandaKey, {
          band: row.banda,
          totalVendida: 0,
          ganado: 0,
          comisionTotal: 0,
          netoDespuesComision: 0,
          ticketsCount: 0,
          refuerzos: 0,
          numero: undefined,
          reventado: undefined,
        });
      }
      const bandRef = sorteoGroup.bands.get(bandaKey)!;
      bandRef.totalVendida += metrics.totalVendida;
      bandRef.ganado += metrics.ganado;
      bandRef.comisionTotal += metrics.comisionTotal;
      bandRef.netoDespuesComision += metrics.netoDespuesComision;
      bandRef.ticketsCount += metrics.ticketsCount;
      bandRef.refuerzos = (bandRef.refuerzos || 0) + (metrics.refuerzos || 0);
      if (tipo === 'NUMERO') {
        if (!bandRef.numero) bandRef.numero = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.numero, metrics);
      } else if (tipo === 'REVENTADO') {
        if (!bandRef.reventado) bandRef.reventado = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.reventado, metrics);
      }

      this.accumulateMetrics(sorteoGroup.subtotal, metrics);
      this.accumulateMetrics(loteriaGroup.subtotal, metrics);
    }

    // Serializar a CierreLoteriaGroup[] por vendedor
    const result = new Map<string, CierreLoteriaGroup[]>();

    for (const [vendedorId, loteriaMap] of Array.from(vendedorMap.entries())) {
      const loterias: CierreLoteriaGroup[] = [];

      for (const [, loteriaGroup] of Array.from(loteriaMap.entries())) {
        const sorteos: CierreSorteoGroup[] = [];

        for (const [, sorteoGroup] of Array.from(loteriaGroup.sorteos.entries())) {
          const bands: Record<string, CierreBandData> = {};
          for (const [bandaKey, bandData] of Array.from(sorteoGroup.bands.entries())) {
            bands[bandaKey] = bandData;
          }
          sorteos.push({ sorteo: sorteoGroup.sorteo, bands, subtotal: sorteoGroup.subtotal });
        }

        sorteos.sort((a, b) => {
          if (a.sorteo.scheduledAt && b.sorteo.scheduledAt) {
            const diff = new Date(a.sorteo.scheduledAt).getTime() - new Date(b.sorteo.scheduledAt).getTime();
            if (diff !== 0) return diff;
          }
          return a.sorteo.turno.localeCompare(b.sorteo.turno);
        });

        loterias.push({ loteria: loteriaGroup.loteria, sorteos, subtotal: loteriaGroup.subtotal });
      }

      loterias.sort((a, b) => a.loteria.name.localeCompare(b.loteria.name));
      result.set(vendedorId, loterias);
    }

    return result;
  }

  /**
   * Construye condiciones WHERE dinámicas
   */
  private static async buildWhereConditions(filters: CierreFilters): Promise<Prisma.Sql> {
    const conditions: Prisma.Sql[] = [];

    // Rango de fechas (obligatorio) usando businessDate directamente (siempre poblado)
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    conditions.push(Prisma.sql`t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date`);

    // Filtro de ventana
    // Filtrar por banca activa (para ADMIN multibanca)
    if (filters.bancaId) {
      conditions.push(Prisma.sql`v."bancaId" = CAST(${filters.bancaId} AS uuid)`);
    }

    if (filters.ventanaId) {
      conditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
    }

    // Filtro de lotería (opcional)
    if (filters.loteriaId) {
      conditions.push(Prisma.sql`t."loteriaId" = CAST(${filters.loteriaId} AS uuid)`);
    }

    // Filtro de vendedor (opcional)
    if (filters.vendedorId) {
      conditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
    }

    //  NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
    if (!await isExclusionListEmpty()) {
      conditions.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM "sorteo_lista_exclusion" sle
        WHERE sle.sorteo_id = t."sorteoId"
        AND sle.ventana_id = t."ventanaId"
        AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
      )`);
    }

    // Combinar condiciones con AND
    if (conditions.length === 0) {
      return Prisma.empty;
    }

    return Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}`;
  }

  /**
   *  NUEVA: Transforma datos raw en estructura jerárquica weekly
   * Organiza por: Lotería → Sorteo → Tipo → Banda
   * Estructura solicitada por el frontend
   */
  private static transformWeeklyDataByLoteriaSorteo(rawData: CierreAggregateRow[]): {
    loterias: CierreLoteriaGroup[];
    totals: CeldaMetrics;
    orphanedDataCount?: number;
  } {
    //  NUEVA ESTRUCTURA: Mapas para agrupar datos (sin separar por tipo)
    const loteriaMap = new Map<string, {
      loteria: { id: string; name: string };
      sorteos: Map<string, {
        sorteo: { id: string; turno: string; scheduledAt?: string };
        bands: Map<string, CierreBandData>; //  Bands directamente (suma de NUMERO + REVENTADO)
        subtotal: CeldaMetrics;
      }>;
      subtotal: CeldaMetrics;
    }>();

    const totals = this.createEmptyMetrics();

    // Procesar cada fila (NUMERO y REVENTADO se suman en la misma banda)
    for (const row of rawData) {
      const loteriaId = row.loteriaId;
      const sorteoId = row.sorteoId;
      const tipo = row.tipo;
      const sorteoKey = `${sorteoId}|${tipo}`;
      const bandaKey = String(row.banda);

      // Obtener o crear lotería
      if (!loteriaMap.has(loteriaId)) {
        loteriaMap.set(loteriaId, {
          loteria: {
            id: loteriaId,
            name: row.loteriaNombre,
          },
          sorteos: new Map(),
          subtotal: this.createEmptyMetrics(),
        });
      }

      const loteriaGroup = loteriaMap.get(loteriaId)!;

      // Obtener o crear sorteo
      if (!loteriaGroup.sorteos.has(sorteoKey)) {
        loteriaGroup.sorteos.set(sorteoKey, {
          sorteo: {
            id: sorteoId,
            turno: `${row.turno} ${tipo === 'NUMERO' ? 'Numero' : 'Reventado'}`,
            scheduledAt: row.scheduledAt?.toISOString(),
          },
          bands: new Map(),
          subtotal: this.createEmptyMetrics(),
        });
      }

      const sorteoGroup = loteriaGroup.sorteos.get(sorteoKey)!;
      const sorteoBands = sorteoGroup.bands;

      // ��� SUMAR NUMERO + REVENTADO (conservando consolidado) y acumular desglose por tipo
      const metrics = this.rowToMetrics(row);
      if (!sorteoBands.has(bandaKey)) {
        sorteoBands.set(bandaKey, {
          band: row.banda,
          totalVendida: 0,
          ganado: 0,
          comisionTotal: 0,
          netoDespuesComision: 0,
          ticketsCount: 0,
          refuerzos: 0,
          numero: undefined,
          reventado: undefined,
        });
      }
      const bandRef = sorteoBands.get(bandaKey)!;

      // Acumular consolidado
      bandRef.totalVendida += metrics.totalVendida;
      bandRef.ganado += metrics.ganado;
      bandRef.comisionTotal += metrics.comisionTotal;
      bandRef.netoDespuesComision += metrics.netoDespuesComision;
      bandRef.ticketsCount += metrics.ticketsCount;
      bandRef.refuerzos = (bandRef.refuerzos || 0) + (metrics.refuerzos || 0);

      // Acumular desglose por tipo
      if (row.tipo === 'NUMERO') {
        if (!bandRef.numero) bandRef.numero = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.numero, metrics);
      } else if (row.tipo === 'REVENTADO') {
        if (!bandRef.reventado) bandRef.reventado = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.reventado, metrics);
      }

      // Acumular en subtotal de sorteo
      this.accumulateMetrics(sorteoGroup.subtotal, metrics);

      // Acumular en subtotal de lotería
      this.accumulateMetrics(loteriaGroup.subtotal, metrics);

      // Acumular en totales globales
      this.accumulateMetrics(totals, metrics);
    }

    // Convertir Maps a arrays
    const loterias: CierreLoteriaGroup[] = [];

    //  Usar Array.from() para evitar errores de iteración en TypeScript
    for (const [loteriaId, loteriaGroup] of Array.from(loteriaMap.entries())) {
      const sorteos: CierreSorteoGroup[] = [];

      for (const [sorteoId, sorteoGroup] of Array.from(loteriaGroup.sorteos.entries())) {
        //  Convertir Map de bandas a Record (ya sumadas NUMERO + REVENTADO)
        const bands: Record<string, CierreBandData> = {};
        for (const [bandaKey, bandData] of Array.from(sorteoGroup.bands.entries())) {
          bands[bandaKey] = bandData;
        }

        sorteos.push({
          sorteo: sorteoGroup.sorteo,
          bands, //  Bands directamente (sin tipos)
          subtotal: sorteoGroup.subtotal,
        });
      }

      //  NUEVO: Ordenar sorteos por fecha (si está disponible) y luego por hora
      sorteos.sort((a, b) => {
        // Si ambos tienen scheduledAt, ordenar por fecha primero
        if (a.sorteo.scheduledAt && b.sorteo.scheduledAt) {
          const dateA = new Date(a.sorteo.scheduledAt).getTime();
          const dateB = new Date(b.sorteo.scheduledAt).getTime();
          if (dateA !== dateB) {
            return dateA - dateB; // Ordenar por fecha ascendente
          }
        }
        // Si las fechas son iguales o no están disponibles, ordenar por hora
        const timeA = a.sorteo.turno;
        const timeB = b.sorteo.turno;
        return timeA.localeCompare(timeB);
      });

      loterias.push({
        loteria: loteriaGroup.loteria,
        sorteos,
        subtotal: loteriaGroup.subtotal,
      });
    }

    // Ordenar loterías alfabéticamente
    loterias.sort((a, b) => a.loteria.name.localeCompare(b.loteria.name));

    //  VALIDACIÓN CRÍTICA: Verificar que totals = Σ(loterias[].subtotal)
    const sumLoterias = loterias.reduce((acc, l) => {
      acc.totalVendida += l.subtotal.totalVendida;
      acc.ganado += l.subtotal.ganado;
      acc.comisionTotal += l.subtotal.comisionTotal;
      acc.netoDespuesComision += l.subtotal.netoDespuesComision;
      acc.ticketsCount += l.subtotal.ticketsCount;
      acc.refuerzos = (acc.refuerzos || 0) + (l.subtotal.refuerzos || 0);
      return acc;
    }, this.createEmptyMetrics());

    const tolerance = 0.01; // Tolerancia para comparaciones de punto flotante
    const hasDiscrepancy = 
      Math.abs(totals.totalVendida - sumLoterias.totalVendida) > tolerance ||
      Math.abs(totals.ganado - sumLoterias.ganado) > tolerance ||
      Math.abs(totals.comisionTotal - sumLoterias.comisionTotal) > tolerance ||
      Math.abs(totals.netoDespuesComision - sumLoterias.netoDespuesComision) > tolerance ||
      totals.ticketsCount !== sumLoterias.ticketsCount;

    let orphanedDataCount: number | undefined = undefined;
    if (hasDiscrepancy) {
      orphanedDataCount = Math.abs(totals.ticketsCount - sumLoterias.ticketsCount);
      logger.warn({
        layer: 'service',
        action: 'CIERRE_TOTALS_DISCREPANCY',
        payload: {
          totals,
          sumLoterias,
          orphanedDataCount,
          discrepancy: {
            totalVendida: totals.totalVendida - sumLoterias.totalVendida,
            ganado: totals.ganado - sumLoterias.ganado,
            comisionTotal: totals.comisionTotal - sumLoterias.comisionTotal,
            netoDespuesComision: totals.netoDespuesComision - sumLoterias.netoDespuesComision,
            ticketsCount: totals.ticketsCount - sumLoterias.ticketsCount,
          },
        },
      });
    }

    return { loterias, totals, orphanedDataCount };
  }

  /**
   * @deprecated Usar transformWeeklyDataByLoteriaSorteo
   * Transforma datos raw en estructura jerárquica weekly
   * Organiza por: Banda → Día → Lotería → Turno
   */
  private static transformWeeklyData(rawData: CierreAggregateRow[]): {
    totals: CeldaMetrics;
    bands: Record<string, BandaMetrics>;
  } {
    const bands: Record<string, BandaMetrics> = {};
    const totals = this.createEmptyMetrics();

    for (const row of rawData) {
      const bandaKey = String(Number(row.banda));
      const fechaKey = row.fecha; // YYYY-MM-DD
      const loteriaNombre = this.normalizeLoteriaName(row.loteriaNombre);

      // Crear banda si no existe
      if (!bands[bandaKey]) {
        bands[bandaKey] = {
          dias: {},
          total: this.createEmptyMetrics(),
        };
      }

      // Crear día si no existe
      if (!bands[bandaKey].dias[fechaKey]) {
        bands[bandaKey].dias[fechaKey] = {
          fecha: fechaKey,
          loterias: {} as any,
          totalDia: this.createEmptyMetrics(),
        };
      }

      // Crear lotería si no existe
      if (!bands[bandaKey].dias[fechaKey].loterias[loteriaNombre]) {
        bands[bandaKey].dias[fechaKey].loterias[loteriaNombre] = {
          turnos: {},
          subtotal: this.createEmptyMetrics(),
        };
      }

      // Crear o actualizar turno agrupado
      const turnoKey = row.turno; // Solo el horario, sin tipo
      if (!bands[bandaKey].dias[fechaKey].loterias[loteriaNombre].turnos[turnoKey]) {
        bands[bandaKey].dias[fechaKey].loterias[loteriaNombre].turnos[turnoKey] = {
          turno: row.turno,
          total: this.createEmptyMetrics(),
        };
      }

      const turnoAgrupado = bands[bandaKey].dias[fechaKey].loterias[loteriaNombre].turnos[turnoKey];
      const metrics = this.rowToMetrics(row);

      // Asignar métricas según el tipo
      if (row.tipo === 'NUMERO') {
        turnoAgrupado.NUMERO = metrics;
      } else if (row.tipo === 'REVENTADO') {
        turnoAgrupado.REVENTADO = metrics;
      }

      // Acumular en total del turno
      this.accumulateMetrics(turnoAgrupado.total, metrics);

      // Acumular métricas en subtotal de lotería
      this.accumulateMetrics(
        bands[bandaKey].dias[fechaKey].loterias[loteriaNombre].subtotal,
        metrics
      );

      // Acumular métricas en total del día
      this.accumulateMetrics(bands[bandaKey].dias[fechaKey].totalDia, metrics);

      // Acumular métricas en total de banda
      this.accumulateMetrics(bands[bandaKey].total, metrics);

      // Acumular métricas en totales globales
      this.accumulateMetrics(totals, metrics);
    }

    return { totals, bands };
  }

  /**
   * Transforma datos raw de vendedores
   */
  private static transformSellerData(
    rawData: VendedorAggregateRow[],
    top?: number,
    orderBy: 'totalVendida' | 'ganado' | 'netoDespuesComision' = 'totalVendida',
    sellerLoterias?: Map<string, CierreLoteriaGroup[]>
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

    // Convertir a array e inyectar loterias[] si están disponibles
    let vendedores = Array.from(vendedorMap.values());
    if (sellerLoterias) {
      for (const vendedor of vendedores) {
        const loterias = sellerLoterias.get(vendedor.vendedorId);
        if (loterias) vendedor.loterias = loterias;
      }
    }

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
    if (normalized.includes('MULTI') && normalized.includes('NICA'))
      return 'MULTI_X_NICA';
    if (normalized === 'NICA') return 'NICA';
    if (normalized.includes('MONAZOS')) return 'MONAZOS';

    // Fallback: retornar como-is (asumiendo que coincide)
    return normalized as LoteriaType;
  }

  /**
   * Convierte una fila raw a métricas
   */
  private static rowToMetrics(
    row: CierreAggregateRow | VendedorAggregateRow
  ): CeldaMetrics {
    // Neto después de comisión = Ventas - Premios - Comisiones
    const netoDespuesComision = row.totalVendida - row.ganado - row.comisionTotal;

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
  orphanedDataCount?: number; //  Datos huérfanos (discrepancia entre totals y Σ(loterias[].subtotal))
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
  const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
  conditions.push(Prisma.sql`t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date`);
  // Filtrar por banca activa (para ADMIN multibanca)
  if (filters.bancaId) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "Ventana" v
      WHERE v.id = t."ventanaId"
      AND v."bancaId" = CAST(${filters.bancaId} AS uuid)
    )`);
  }
  if (filters.ventanaId) conditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
  if (filters.loteriaId) conditions.push(Prisma.sql`t."loteriaId" = CAST(${filters.loteriaId} AS uuid)`);
  if (filters.vendedorId) conditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);
  const whereConditions = conditions.length ? Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  // OPTIMIZACIÓN: CTE materializado compartido entre count y sample queries
  const lmActiveCte = Prisma.sql`
    lm_active AS MATERIALIZED (
      SELECT
        lm."loteriaId",
        lm."valueX",
        lm."appliesToDate",
        lm."appliesToSorteoId"
      FROM "LoteriaMultiplier" lm
      WHERE lm."kind" = 'NUMERO'
        AND lm."isActive" = true
    )
  `;

  const countQuery = Prisma.sql`
    WITH 
      ${lmActiveCte},
      relevant_tickets AS MATERIALIZED (
        SELECT t.id, t."loteriaId", t."sorteoId", t."createdAt"
        FROM "Ticket" t
        WHERE t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date
          AND t."isActive" = true
          AND t."status" != 'CANCELLED'
          AND t."deletedAt" IS NULL
          ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
          ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
          ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
      )
    SELECT COUNT(*)::INT as cnt
    FROM "Jugada" j
    INNER JOIN relevant_tickets rt ON j."ticketId" = rt.id
    INNER JOIN "Sorteo" s ON rt."sorteoId" = s.id
    WHERE
      j."deletedAt" IS NULL
      AND j."isActive" = true
      AND s."status" = 'EVALUATED'
      AND j.type = 'NUMERO'
      AND NOT EXISTS (
        SELECT 1 FROM lm_active lm
        WHERE lm."loteriaId" = rt."loteriaId"
          AND lm."valueX" = j."finalMultiplierX"
          AND (lm."appliesToDate" IS NULL OR rt."createdAt" >= lm."appliesToDate")
          AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = rt."sorteoId")
      )
  `;

  const [{ cnt }] = await prisma.$queryRaw<{ cnt: number }[]>(countQuery);

  let examples: AnomaliesResult['examples'] = [];
  if (cnt > 0) {
    const sampleQuery = Prisma.sql`
      WITH 
        ${lmActiveCte},
        relevant_tickets AS MATERIALIZED (
          SELECT t.id, t."loteriaId", t."sorteoId", t."createdAt"
          FROM "Ticket" t
          WHERE t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date
            AND t."isActive" = true
            AND t."status" != 'CANCELLED'
            AND t."deletedAt" IS NULL
            ${filters.vendedorId ? Prisma.sql`AND t."vendedorId" = CAST(${filters.vendedorId} AS uuid)` : Prisma.empty}
            ${filters.loteriaId ? Prisma.sql`AND t."loteriaId" = CAST(${filters.loteriaId} AS uuid)` : Prisma.empty}
            ${filters.ventanaId ? Prisma.sql`AND t."ventanaId" = CAST(${filters.ventanaId} AS uuid)` : Prisma.empty}
        )
      SELECT
        j.id as "jugadaId",
        rt.id as "ticketId",
        rt."loteriaId" as "loteriaId",
        l.name as "loteriaNombre",
        j."finalMultiplierX" as "finalMultiplierX",
        j."createdAt" as "createdAt",
        j.amount as amount
      FROM "Jugada" j
      INNER JOIN relevant_tickets rt ON j."ticketId" = rt.id
      INNER JOIN "Sorteo" s ON rt."sorteoId" = s.id
      INNER JOIN "Loteria" l ON rt."loteriaId" = l.id
      WHERE
        j."deletedAt" IS NULL
        AND j."isActive" = true
        AND s."status" = 'EVALUATED'
        AND j.type = 'NUMERO'
        AND NOT EXISTS (
          SELECT 1 FROM lm_active lm
          WHERE lm."loteriaId" = rt."loteriaId"
            AND lm."valueX" = j."finalMultiplierX"
            AND (lm."appliesToDate" IS NULL OR rt."createdAt" >= lm."appliesToDate")
            AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = rt."sorteoId")
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
    } catch { }
  }

  return { outOfBandCount: cnt, examples };
}
