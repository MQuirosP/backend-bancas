import { Prisma, BetType, TicketStatus, SorteoStatus } from '../../../generated/prisma/client';
import prisma from '../../../core/prismaClient';
import { CacheService } from '../../../core/cache.service';
import crypto from 'crypto';

const _cierreInFlight = new Map<string, Promise<any>>();

function cierreWrap<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const inFlight = _cierreInFlight.get(key);
  if (inFlight) return inFlight;
  //  USO DE TAG GLOBAL: 'cierre' permite invalidar todo el reporte closure de una vez
  const promise = CacheService.wrap(key, fn, ttl, ['cierre']);
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
    const cacheKey = `cierre_v2:weekly:${crypto.createHash('md5').update(JSON.stringify({
      from: filters.fromDate.toISOString(),
      to: filters.toDate.toISOString(),
      scope: filters.scope,
      ventanaId: filters.ventanaId || null,
      bancaId: filters.bancaId || null,
      loteriaId: filters.loteriaId || null,
    })).digest('hex')}`;

    return cierreWrap(cacheKey, 60, async () => {
      const startTime = Date.now();
      let queryCount = 0;
      const labelPrefix = `CW-${Math.random().toString(36).substring(7)}`;

      console.time(`${labelPrefix}.executeWeeklyAggregation`);
      // Ejecutar agregación principal y anomalías en paralelo
      const [rawData, anomalies] = await Promise.all([
        this.executeWeeklyAggregation(filters).then(d => { 
          console.timeEnd(`${labelPrefix}.executeWeeklyAggregation`);
          queryCount += 1; 
          return d; 
        }),
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
    const cacheKey = `cierre_v2:by-seller:${crypto.createHash('md5').update(JSON.stringify({
      from: filters.fromDate.toISOString(),
      to: filters.toDate.toISOString(),
      scope: filters.scope,
      ventanaId: filters.ventanaId || null,
      bancaId: filters.bancaId || null,
      loteriaId: filters.loteriaId || null,
      top: top || null,
      orderBy,
      depth: filters.depth || 'full',
    })).digest('hex')}`;

    return cierreWrap(cacheKey, 60, async () => {
      const startTime = Date.now();
      let queryCount = 0;
      const labelPrefix = `CS-${Math.random().toString(36).substring(7)}`;

      console.time(`${labelPrefix}.executeSellerAggregation`);
      
      const isSummary = filters.depth === 'summary';
      
      // En modo summary solo se ejecuta una consulta optimizada
      // En modo full se ejecutan todas en paralelo como antes
      const queries: Promise<any>[] = [
        this.executeSellerAggregation(filters).then(d => { 
          console.timeEnd(`${labelPrefix}.executeSellerAggregation`);
          queryCount += 1; 
          return d; 
        }),
      ];

      if (!isSummary) {
        queries.push(this.executeSellerAggregationBySorteo(filters).then(d => { queryCount += 1; return d; }));
        queries.push(computeAnomalies(filters)
          .then(a => { queryCount += 2; return a; })
          .catch(err => {
            logger.error({
              layer: 'service',
              action: 'COMPUTE_ANOMALIES_FAILURE',
              meta: { error: err instanceof Error ? err.message : String(err) }
            });
            return { outOfBandCount: 0, examples: [] };
          }));
      }

      const [rawData, sorteoData, anomalies] = await Promise.all(queries);

      const sellerLoterias = !isSummary && sorteoData ? this.buildSellerLoterias(sorteoData) : undefined;
      const { totals, vendedores } = this.transformSellerData(rawData, top, orderBy, sellerLoterias);
      const bandsUsed = !isSummary ? computeBandsUsedFromSeller(rawData) : { global: [], byLoteria: {}, details: [] };
      const configHash = !isSummary ? hashConfig(bandsUsed) : 'summary-only';

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
          anomalies: anomalies || { outOfBandCount: 0, examples: [] },
        },
      };
    });
  }

  /**
   * Obtiene el detalle completo para un solo vendedor
   * Optimizado para responder en < 200ms filtrando por vendedorId desde el inicio.
   */
  static async getSellerDetail(
    filters: CierreFilters,
    vendedorId: string
  ): Promise<any> {
    const detailFilters: CierreFilters = { ...filters, vendedorId, depth: 'full' };
    
    const labelPrefix = `SD-${Math.random().toString(36).substring(7)}`;
    console.time(`${labelPrefix}.getSellerDetail`);

    // 1. Obtener datos detallados (loterías, sorteos, bandas) para ESTE vendedor
    const [rawData, sorteoData] = await Promise.all([
      this.executeSellerAggregation(detailFilters),
      this.executeSellerAggregationBySorteo(detailFilters)
    ]);

    console.timeEnd(`${labelPrefix}.getSellerDetail`);

    if (rawData.length === 0) {
      return null;
    }

    // 2. Transformar bandas (agrupado por banda)
    const bands: Record<string, any> = {};
    for (const row of rawData) {
      if (row.banda) {
        bands[row.banda] = this.rowToMetrics(row);
      }
    }

    // 3. Transformar loterías (jerárquico)
    const sellerLoteriasMap = this.buildSellerLoterias(sorteoData);
    const loterias = sellerLoteriasMap.get(vendedorId) || [];

    // 4. Calcular subtotal general
    const subtotal = this.createEmptyMetrics();
    for (const b of Object.values(bands)) {
      this.accumulateMetrics(subtotal, b as CeldaMetrics);
    }

    return {
      vendedor: {
        id: vendedorId,
        name: rawData[0].vendedorNombre
      },
      bands,
      loterias,
      subtotal
    };
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
    const todayStr = crDateService.getTodayCRString();
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    const endDateCap = endDateCRStr > todayStr ? todayStr : endDateCRStr;
    const whereConditions = this.buildMVWhereConditions(filters, startDateCRStr, endDateCap);

    // ⚡ OPTIMIZACIÓN EXTREMA: Lectura directa desde ResumenCierreDiario precalculado (<250ms)
    const query = Prisma.sql`
      SELECT
        u.id AS "vendedorId",
        u.name AS "vendedorNombre",
        v.id AS "ventanaId",
        v.name AS "ventanaNombre",
        CAST(mv.banda AS INT) AS banda,
        mv.tipo,
        l.id AS "loteriaId",
        l.name AS "loteriaNombre",
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') AS turno,
        s."scheduledAt" AS "scheduledAt",
        TO_CHAR(mv."businessDate", 'YYYY-MM-DD') AS fecha,
        SUM(mv."totalVendida")::FLOAT AS "totalVendida",
        SUM(mv.ganado)::FLOAT AS ganado,
        SUM(mv."comisionTotal")::FLOAT AS "comisionTotal",
        0::FLOAT AS refuerzos,
        SUM(mv."ticketsCount")::INT AS "ticketsCount",
        SUM(mv."jugadasCount")::INT AS "jugadasCount"
      FROM "ResumenCierreDiario" mv
      INNER JOIN "User" u ON u.id = mv."vendedorId"
      INNER JOIN "Ventana" v ON v.id = mv."ventanaId"
      INNER JOIN "Loteria" l ON l.id = mv."loteriaId"
      INNER JOIN "Sorteo" s ON s.id = mv."sorteoId"
      WHERE ${whereConditions}
      GROUP BY
        u.id, u.name, v.id, v.name,
        CAST(mv.banda AS INT), mv.tipo,
        l.id, l.name, s.id,
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI'),
        s."scheduledAt", TO_CHAR(mv."businessDate", 'YYYY-MM-DD')
      ORDER BY
        u.name ASC,
        l.name ASC,
        turno ASC,
        mv.tipo ASC,
        CAST(mv.banda AS INT) ASC,
        fecha ASC;
    `;

    const startTime = Date.now();
    const result = await prisma.$queryRaw<any[]>(query);
    console.log(`executeSellerAggregationByDay: ${Date.now() - startTime}ms`);

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
   * Ejecuta agregación híbrida para datos semanales (MV + Live)
   */
  private static async executeWeeklyAggregation(
    filters: CierreFilters
  ): Promise<CierreAggregateRow[]> {
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    const todayStr = crDateService.getTodayCRString();
    const endDateCap = endDateCRStr > todayStr ? todayStr : endDateCRStr;
    return this.executeWeeklyAggregationFromMV(filters, startDateCRStr, endDateCap);
  }

  /**
   * Consulta la Vista Materializada para reportes semanales
   */
  private static async executeWeeklyAggregationFromMV(
    filters: CierreFilters,
    startStr: string,
    endStr: string
  ): Promise<CierreAggregateRow[]> {
    const whereConditions = this.buildMVWhereConditions(filters, startStr, endStr);
    
    const query = Prisma.sql`
      SELECT
        banda,
        tipo,
        TO_CHAR("businessDate", 'YYYY-MM-DD') as fecha,
        l.id as "loteriaId",
        l.name as "loteriaNombre",
        mv."sorteoId" as "sorteoId",
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') as turno,
        s."scheduledAt" as "scheduledAt",
        "totalVendida",
        ganado,
        "comisionTotal",
        0::FLOAT as refuerzos,
        "ticketsCount",
        "jugadasCount"
      FROM "ResumenCierreDiario" mv
      INNER JOIN "Loteria" l ON l.id = mv."loteriaId"
      INNER JOIN "Sorteo" s ON s.id = mv."sorteoId"
      WHERE ${whereConditions}
    `;

    return prisma.$queryRaw<any[]>(query).then(res => res.map(row => ({
      ...row,
      banda: Number(row.banda),
      scheduledAt: row.scheduledAt ? new Date(row.scheduledAt) : undefined,
    })));
  }



  /**
   * Ejecuta agregación SQL por vendedor
   * OPTIMIZACIÓN: Early Filtering (Gatekeeper) + Pre-Aggregated Jugadas (vía idx_jugada_report_totals).
   */
  private static async executeSellerAggregation(
    filters: CierreFilters
  ): Promise<VendedorAggregateRow[]> {
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    const todayStr = crDateService.getTodayCRString();
    const endDateCap = endDateCRStr > todayStr ? todayStr : endDateCRStr;
    return this.executeSellerAggregationFromMV(filters, startDateCRStr, endDateCap);
  }

  private static async executeSellerAggregationFromMV(
    filters: CierreFilters,
    startStr: string,
    endStr: string
  ): Promise<VendedorAggregateRow[]> {
    const whereConditions = this.buildMVWhereConditions(filters, startStr, endStr);
    const isSummary = filters.depth === 'summary';

    const query = Prisma.sql`
      SELECT
        u.id as "vendedorId",
        u.name as "vendedorNombre",
        v.id as "ventanaId",
        v.name as "ventanaNombre",
        ${isSummary ? Prisma.empty : Prisma.sql`mv.banda,`}
        SUM("totalVendida")::FLOAT as "totalVendida",
        SUM(ganado)::FLOAT as ganado,
        SUM("comisionTotal")::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        SUM("ticketsCount")::INT as "ticketsCount",
        SUM("jugadasCount")::INT as "jugadasCount"
      FROM "ResumenCierreDiario" mv
      INNER JOIN "User" u ON u.id = mv."vendedorId"
      INNER JOIN "Ventana" v ON v.id = mv."ventanaId"
      WHERE ${whereConditions}
      GROUP BY 1, 2, 3, 4 ${isSummary ? Prisma.empty : Prisma.sql`, 5`}
    `;

    return prisma.$queryRaw<any[]>(query).then(res => res.map(row => ({
      ...row,
      banda: row.banda != null ? Number(row.banda) : undefined,
    })));
  }



  /**
   * Agrega por (vendedor, ventana, lotería, sorteo, turno, tipo, banda) para construir
   * el desglose loterias[] dentro de cada VendedorMetrics.
   * Usa herencia de banda para REVENTADO (igual que weekly).
   */
  private static async executeSellerAggregationBySorteo(
    filters: CierreFilters
  ): Promise<SellerSorteoAggregateRow[]> {
    const todayStr = crDateService.getTodayCRString();
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    const endDateCap = endDateCRStr > todayStr ? todayStr : endDateCRStr;
    const whereConditions = this.buildMVWhereConditions(filters, startDateCRStr, endDateCap);

    // ⚡ OPTIMIZACIÓN EXTREMA: Lectura directa desde ResumenCierreDiario precalculado (<2ms)
    // Elimina escaneo masivo de 78k jugadas y previene 502 por timeout en Render
    const query = Prisma.sql`
      SELECT
        u.id as "vendedorId",
        u.name as "vendedorNombre",
        v.id as "ventanaId",
        v.name as "ventanaNombre",
        CAST(mv.banda AS INT) as banda,
        mv.tipo,
        l.id as "loteriaId",
        l.name as "loteriaNombre",
        s.id as "sorteoId",
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI') AS turno,
        s."scheduledAt" as "scheduledAt",
        SUM(mv."totalVendida")::FLOAT as "totalVendida",
        SUM(mv.ganado)::FLOAT as ganado,
        SUM(mv."comisionTotal")::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        SUM(mv."ticketsCount")::INT as "ticketsCount",
        SUM(mv."jugadasCount")::INT as "jugadasCount"
      FROM "ResumenCierreDiario" mv
      INNER JOIN "User" u ON u.id = mv."vendedorId"
      INNER JOIN "Ventana" v ON v.id = mv."ventanaId"
      INNER JOIN "Loteria" l ON l.id = mv."loteriaId"
      INNER JOIN "Sorteo" s ON s.id = mv."sorteoId"
      WHERE ${whereConditions}
      GROUP BY
        u.id, u.name, v.id, v.name,
        CAST(mv.banda AS INT),
        mv.tipo,
        l.id, l.name,
        s.id,
        TO_CHAR(s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica', 'HH24:MI'),
        s."scheduledAt"
      ORDER BY
        u.name ASC,
        l.name ASC,
        turno ASC,
        mv.tipo ASC,
        CAST(mv.banda AS INT) ASC
    `;

    const startTime = Date.now();
    const result = await prisma.$queryRaw<SellerSorteoAggregateRow[]>(query);
    console.log(`executeSellerAggregationBySorteo: ${Date.now() - startTime}ms`);

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
      const { vendedorId, loteriaId, tipo } = row;
      // Consolidar por turno (hora) para el reporte de vendedor, 
      // de lo contrario un mes muestra 90 filas separadas de "11:00 Numero" (una por sorteo_id).
      const sorteoKey = `${row.turno}|${tipo}`;
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
            id: `summary-${row.turno}-${tipo}`,
            turno: `${row.turno} ${tipo === BetType.NUMERO ? 'Numero' : 'Reventado'}`,
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
      if (tipo === BetType.NUMERO) {
        if (!bandRef.numero) bandRef.numero = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.numero, metrics);
      } else if (tipo === BetType.REVENTADO) {
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
    return this.buildWhereConditionsWithRange(filters, startDateCRStr, endDateCRStr);
  }

  private static async buildWhereConditionsWithRange(
    filters: CierreFilters, 
    startStr: string, 
    endStr: string
  ): Promise<Prisma.Sql> {
    const conditions: Prisma.Sql[] = [];
    conditions.push(Prisma.sql`t."businessDate" BETWEEN ${startStr}::date AND ${endStr}::date`);

    if (filters.bancaId) conditions.push(Prisma.sql`v."bancaId" = CAST(${filters.bancaId} AS uuid)`);
    if (filters.ventanaId) conditions.push(Prisma.sql`t."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
    if (filters.loteriaId) conditions.push(Prisma.sql`t."loteriaId" = CAST(${filters.loteriaId} AS uuid)`);
    if (filters.vendedorId) conditions.push(Prisma.sql`t."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);

    // El filtrado de exclusiones se maneja individualmente en cada Jugada (j."isExcluded" = false)

    return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.empty;
  }

  /**
   * Construye condiciones WHERE para la Vista Materializada
   */
  private static buildMVWhereConditions(
    filters: CierreFilters,
    startStr: string,
    endStr: string
  ): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];
    conditions.push(Prisma.sql`mv."businessDate" BETWEEN ${startStr}::date AND ${endStr}::date`);

    if (filters.bancaId) conditions.push(Prisma.sql`mv."bancaId" = CAST(${filters.bancaId} AS uuid)`);
    if (filters.ventanaId) conditions.push(Prisma.sql`mv."ventanaId" = CAST(${filters.ventanaId} AS uuid)`);
    if (filters.loteriaId) conditions.push(Prisma.sql`mv."loteriaId" = CAST(${filters.loteriaId} AS uuid)`);
    if (filters.vendedorId) conditions.push(Prisma.sql`mv."vendedorId" = CAST(${filters.vendedorId} AS uuid)`);

    return conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.empty;
  }

  /**
   * Consolida filas de vendedores que pueden venir duplicadas entre MV y Live
   */
  private static consolidateSellerRows(rows: VendedorAggregateRow[], isSummary: boolean): VendedorAggregateRow[] {
    const map = new Map<string, VendedorAggregateRow>();

    for (const row of rows) {
      const key = isSummary ? row.vendedorId : `${row.vendedorId}|${row.banda}`;
      if (!map.has(key)) {
        map.set(key, { ...row });
      } else {
        const existing = map.get(key)!;
        existing.totalVendida += row.totalVendida;
        existing.ganado += row.ganado;
        existing.comisionTotal += row.comisionTotal;
        existing.ticketsCount += row.ticketsCount;
        existing.jugadasCount += row.jugadasCount;
      }
    }

    return Array.from(map.values()).sort((a, b) => a.vendedorNombre.localeCompare(b.vendedorNombre));
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
            turno: `${row.turno} ${tipo === BetType.NUMERO ? 'Numero' : 'Reventado'}`,
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
      if (row.tipo === BetType.NUMERO) {
        if (!bandRef.numero) bandRef.numero = this.createEmptyMetrics();
        this.accumulateMetrics(bandRef.numero, metrics);
      } else if (row.tipo === BetType.REVENTADO) {
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
      if (row.tipo === BetType.NUMERO) {
        turnoAgrupado.NUMERO = metrics;
      } else if (row.tipo === BetType.REVENTADO) {
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

// Anomalías: jugadas NUMERO sin configuración vigente (solo se audita el día de hoy en vivo)
async function computeAnomalies(filters: CierreFilters): Promise<AnomaliesResult> {
  const timeLabel = `CA-${Math.random().toString(36).substring(7)}`;
  console.time(timeLabel);

  const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
  const todayStr = crDateService.getTodayCRString();

  // Si el rango no incluye el día de hoy, evitamos consultar tablas vivas históricas
  const rangeIncludesToday = startDateCRStr <= todayStr && endDateCRStr >= todayStr;
  if (!rangeIncludesToday) {
    console.timeEnd(timeLabel);
    return { outOfBandCount: 0, examples: [] };
  }

  // Construir condiciones WHERE (repetimos lógica para uso fuera de la clase)
  const conditions: Prisma.Sql[] = [];
  conditions.push(Prisma.sql`t."businessDate" = ${todayStr}::date`);
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

  // OPTIMIZACIÓN: CTE compartido entre count y sample queries (sin MATERIALIZED para permitir push-down de filtros e Index Scan)
  const lmActiveCte = Prisma.sql`
    lm_active AS (
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
    WITH ${lmActiveCte}
    SELECT COUNT(*)::INT as cnt
    FROM "Jugada" j
    INNER JOIN "Ticket" t ON j."ticketId" = t.id
    INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
    WHERE
      t."deletedAt" IS NULL
      AND j."deletedAt" IS NULL
      AND t."status" != 'CANCELLED'
      AND t."isActive" = true
      AND j."isActive" = true
      AND s."status" = 'EVALUATED'
      ${whereConditions}
      AND j.type = 'NUMERO'
      AND NOT EXISTS (
        SELECT 1 FROM lm_active lm
        WHERE lm."loteriaId" = t."loteriaId"
          AND lm."valueX" = j."finalMultiplierX"
          AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
          AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
      )
  `;

  const [{ cnt }] = await prisma.$queryRaw<{ cnt: number }[]>(countQuery);

  let examples: AnomaliesResult['examples'] = [];
  if (cnt > 0) {
    const sampleQuery = Prisma.sql`
      WITH ${lmActiveCte}
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
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "Loteria" l ON t."loteriaId" = l.id
      WHERE
        t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND t."status" != 'CANCELLED'
        AND t."isActive" = true
        AND j."isActive" = true
        AND s."status" = 'EVALUATED'
        ${whereConditions}
        AND j.type = 'NUMERO'
        AND NOT EXISTS (
          SELECT 1 FROM lm_active lm
          WHERE lm."loteriaId" = t."loteriaId"
            AND lm."valueX" = j."finalMultiplierX"
            AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
            AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
        )
      ORDER BY j."createdAt" ASC
      LIMIT 10
    `;

    const rawExamples = await prisma.$queryRaw<any[]>(sampleQuery);

    examples = rawExamples.map((r: any) => ({
      jugadaId: r.jugadaId,
      ticketId: r.ticketId,
      loteriaId: r.loteriaId,
      loteriaNombre: r.loteriaNombre,
      finalMultiplierX: Number(r.finalMultiplierX),
      createdAt: new Date(r.createdAt).toISOString(),
      amount: Number(r.amount),
    }));
  }
  console.timeEnd(timeLabel);

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
