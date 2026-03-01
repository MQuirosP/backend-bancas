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
  CierreLoteriaGroup,
  CierreSorteoGroup,
  CierreBandData,
} from '../types/cierre.types';
import { CierreMetaExtras, BandsUsedMetadata } from '../types/cierre.types';
import { createHash } from 'crypto';
import logger from '../../../core/logger';
import { crDateService } from '../../../utils/crDateService';

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

    // Transformar datos en estructura jerárquica (Lotería → Sorteo → Tipo → Banda)
    const { loterias, totals, orphanedDataCount } = this.transformWeeklyDataByLoteriaSorteo(rawData);

    // Calcular anomalías (jugadas fuera de banda)
    const anomalies = await computeAnomalies(filters);
    queryCount += 2; // count + sample

    // Agregar orphanedDataCount a las anomalías si existe
    if (orphanedDataCount !== undefined && orphanedDataCount > 0) {
      anomalies.orphanedDataCount = orphanedDataCount;
    }

    // Calcular bandsUsed y configHash
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

    // OPTIMIZACIÓN: Dos CTEs eliminan los subqueries correlacionados O(n×m):
    // ① lm_active: materializa LoteriaMultiplier una sola vez → hash lookup en EXISTS
    // ② numero_bandas: pre-calcula bandas NUMERO por (ticketId, number) → LEFT JOIN para REVENTADO
    const query = Prisma.sql`
      WITH
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
    });

    return result.map((row: any) => ({
      ...row,
      banda: Number(row.banda),
      scheduledAt: row.scheduledAt ? new Date(row.scheduledAt) : undefined,
    }));
  }

  /**
   * Ejecuta agregación SQL por vendedor
   */
  private static async executeSellerAggregation(
    filters: CierreFilters
  ): Promise<VendedorAggregateRow[]> {
    const whereConditions = this.buildWhereConditions(filters);

    // OPTIMIZACIÓN: CTE materializado elimina el EXISTS que se evaluaba 3 veces por fila
    // (en SELECT, WHERE y GROUP BY). Ahora PostgreSQL construye el hash table una sola vez.
    const query = Prisma.sql`
      WITH lm_active AS MATERIALIZED (
        SELECT
          lm."loteriaId",
          lm."valueX",
          lm."appliesToDate",
          lm."appliesToSorteoId"
        FROM "LoteriaMultiplier" lm
        WHERE lm."kind" = 'NUMERO'
          AND lm."isActive" = true
      )
      SELECT
        u.id as "vendedorId",
        u.name as "vendedorNombre",
        v.id as "ventanaId",
        v.name as "ventanaNombre",

        CASE
          WHEN j.type = 'REVENTADO' THEN 200
          WHEN EXISTS (
            SELECT 1 FROM lm_active lm
            WHERE lm."loteriaId" = t."loteriaId"
              AND lm."valueX" = j."finalMultiplierX"
              AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
              AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
          ) THEN j."finalMultiplierX"
          ELSE NULL
        END as banda,

        COALESCE(SUM(j.amount), 0)::FLOAT as "totalVendida",
        COALESCE(SUM(j.payout), 0)::FLOAT as ganado,
        COALESCE(SUM(j."listeroCommissionAmount"), 0)::FLOAT as "comisionTotal",
        0::FLOAT as refuerzos,
        COUNT(DISTINCT t.id)::INT as "ticketsCount",
        COUNT(j.id)::INT as "jugadasCount"

      FROM "Jugada" j
      INNER JOIN "Ticket" t ON j."ticketId" = t.id
      INNER JOIN "Sorteo" s ON t."sorteoId" = s.id
      INNER JOIN "User" u ON t."vendedorId" = u.id
      INNER JOIN "Ventana" v ON t."ventanaId" = v.id

      WHERE
        t."deletedAt" IS NULL
        AND j."deletedAt" IS NULL
        AND t."status" != 'CANCELLED'
        AND t."isActive" = true
        AND j."isActive" = true
        AND s."status" = 'EVALUATED'
        ${whereConditions}
        AND (
          j.type = 'REVENTADO' OR (
            j.type = 'NUMERO' AND EXISTS (
              SELECT 1 FROM lm_active lm
              WHERE lm."loteriaId" = t."loteriaId"
                AND lm."valueX" = j."finalMultiplierX"
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
            SELECT 1 FROM lm_active lm
            WHERE lm."loteriaId" = t."loteriaId"
              AND lm."valueX" = j."finalMultiplierX"
              AND (lm."appliesToDate" IS NULL OR t."createdAt" >= lm."appliesToDate")
              AND (lm."appliesToSorteoId" IS NULL OR lm."appliesToSorteoId" = t."sorteoId")
          ) THEN j."finalMultiplierX"
          ELSE NULL
        END

      ORDER BY
        u.name ASC,
        banda ASC
    `;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '30000'`;
      return tx.$queryRaw<VendedorAggregateRow[]>(query);
    });

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

    // Rango de fechas (obligatorio) usando businessDate directamente (siempre poblado)
    const { startDateCRStr, endDateCRStr } = crDateService.dateRangeUTCToCRStrings(filters.fromDate, filters.toDate);
    conditions.push(Prisma.sql`t."businessDate" BETWEEN ${startDateCRStr}::date AND ${endDateCRStr}::date`);

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

    //  NUEVO: Excluir tickets de listas bloqueadas (Lista Exclusion)
    conditions.push(Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "sorteo_lista_exclusion" sle
      WHERE sle.sorteo_id = t."sorteoId"
      AND sle.ventana_id = t."ventanaId"
      AND (sle.vendedor_id IS NULL OR sle.vendedor_id = t."vendedorId")
    )`);

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
      AND v."bancaId" = ${filters.bancaId}::uuid
    )`);
  }
  if (filters.ventanaId) conditions.push(Prisma.sql`t."ventanaId" = ${filters.ventanaId}::uuid`);
  if (filters.loteriaId) conditions.push(Prisma.sql`t."loteriaId" = ${filters.loteriaId}::uuid`);
  if (filters.vendedorId) conditions.push(Prisma.sql`t."vendedorId" = ${filters.vendedorId}::uuid`);
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
