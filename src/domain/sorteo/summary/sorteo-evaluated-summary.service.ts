import { Prisma, Role, SorteoStatus, BetType } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { CacheService } from "../../../core/cache.service";
import { getRedisClient } from "../../../core/redisClient";
import { crDateService } from "../../../utils/crDateService";
import { formatIsoLocal } from "../../../utils/datetime";
import { getCRLocalComponents } from "../../../utils/businessDate";
import { resolveDateRange } from "../../../utils/dateRange";
import { AccountPaymentRepository } from "../../../repositories/accountPayment.repository";
import { getPreviousMonthFinalBalance, getPreviousMonthFinalBalancesBatch } from "../../accounts/accounts.balances";
import { ACCOUNT_CARRY_OVER_NOTES, ACCOUNT_PREVIOUS_MONTH_METHOD } from "../../accounts/accounts.types";
import { getMonthlyRemainingBalance, getMonthlyRemainingBalancesBatch } from "../../accounts/accounts.service";
import { getExcludedTicketIds } from "../sorteo-listas.helpers";
import { SingleFlight } from "../../../utils/concurrency";
import { buildSummaryCacheKey, formatDateOnly, formatTime12h } from "../types/sorteo.types";

export class SorteoEvaluatedSummaryService {
  /**
   * Fast-Path de alto rendimiento para GET /evaluated-summary con summaryOnly=true.
   * Consulta directamente AccountStatement (O(1) B-Tree) y AccountPayment sin escanear Ticket ni Jugada.
   * Resuelve lecturas en frío (Cold/DB) en < 5 ms.
   */
  static async evaluatedSummaryFastPath(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      loteriaId?: string;
      status?: string;
      isActive?: boolean;
      summaryOnly?: boolean;
      ventanaId?: string;
      bancaId?: string;
      sorteoId?: string;
      userRole?: string;
      ignoreReset?: boolean;
      forceRefresh?: boolean;
    },
    vendedorId: string,
    dateRange: { fromAt: Date; toAt: Date },
    rangeEffectiveMonth: string
  ) {
    const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
    const toAtComponents = getCRLocalComponents(dateRange.toAt);
    const startDateStr = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
    const endDateStr = `${toAtComponents.year}-${String(toAtComponents.month).padStart(2, '0')}-${String(toAtComponents.day).padStart(2, '0')}`;

    const [sy, sm, sd] = startDateStr.split('-').map(Number);
    const startDateUTC = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0));
    const [ey, em, ed] = endDateStr.split('-').map(Number);
    const endDateUTC = new Date(Date.UTC(ey, em - 1, ed, 0, 0, 0, 0));

    const monthlyRange = resolveDateRange("month");
    const monthlyStartDate = monthlyRange.fromAt;
    const monthlyEndDate = monthlyRange.toAt;
    const monthlyStartDateStr = crDateService.dateUTCToCRString(monthlyStartDate);
    const monthlyEndDateStr = crDateService.dateUTCToCRString(monthlyEndDate);
    const monthlyStartComponents = getCRLocalComponents(monthlyStartDate);
    const effectiveMonth = `${monthlyStartComponents.year}-${String(monthlyStartComponents.month).padStart(2, '0')}`;

    const isMonthRange =
      params.date === 'month' ||
      (startDateStr === monthlyStartDateStr && endDateStr === monthlyEndDateStr);

    // 1. Ejecutar en paralelo lecturas indexadas (sin tocar Ticket ni Jugada)
    const [
      statements,
      movementsByDate,
      rangePreviousMonthBalance,
      realMonthlyRemainingBalance,
      rcdCommissionsRows,
      rcdMonthRowsRaw,
      monthlyMovementsByDateRaw,
      userSettingsRow,
      // totalSorteosCount,
    ] = await Promise.all([
      // A. AccountStatement: lectura directa por índice de vendedorId y rango de fechas
      prisma.accountStatement.findMany({
        where: {
          vendedorId,
          date: {
            gte: startDateUTC,
            lte: endDateUTC,
          },
        },
        select: {
          date: true,
          totalSales: true,
          totalPayouts: true,
          vendedorCommission: true,
          listeroCommission: true,
          ticketCount: true,
          totalPaid: true,
          totalCollected: true,
          balance: true,
          remainingBalance: true,
          accumulatedBalance: true,
        },
        orderBy: { date: 'desc' },
      }),

      // B. Movimientos en AccountPayment del rango
      AccountPaymentRepository.findMovementsByDateRange(
        dateRange.fromAt,
        dateRange.toAt,
        "vendedor",
        undefined,
        vendedorId
      ),

      // C. Balance previo del mes
      getPreviousMonthFinalBalance(
        effectiveMonth,
        "vendedor",
        undefined,
        vendedorId,
        undefined
      ),

      // D. Saldo mensual remanente real
      getMonthlyRemainingBalance(
        effectiveMonth,
        "vendedor",
        undefined,
        vendedorId
      ),

      // E. Desglose de comisiones por tipo (NUMERO vs REVENTADO) desde ResumenCierreDiario
      prisma.$queryRaw<
        Array<{
          businessDate: Date;
          commission_by_number: number;
          commission_by_reventado: number;
          total_tickets: bigint | number;
          total_sorteos: bigint | number;
        }>
      >(Prisma.sql`
        SELECT 
          rcd."businessDate",
          COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
          COALESCE(SUM(rcd."ticketsCount"), 0)::integer as total_tickets,
          COUNT(DISTINCT rcd."sorteoId") as total_sorteos
        FROM "ResumenCierreDiario" rcd
        WHERE rcd."businessDate" >= ${startDateStr}::date
          AND rcd."businessDate" <= ${endDateStr}::date
          AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)
          ${params.loteriaId ? Prisma.sql`AND rcd."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
        GROUP BY rcd."businessDate"
      `),

      // F. Totales mensuales desde ResumenCierreDiario para monthlyAccumulated
      prisma.$queryRaw<
        Array<{
          total_sales: number;
          total_commission: number;
          commission_by_number: number;
          commission_by_reventado: number;
          total_prizes: number;
          total_tickets: bigint | number;
        }>
      >(Prisma.sql`
        SELECT 
          COALESCE(SUM(rcd."totalVendida"), 0) as total_sales,
          COALESCE(SUM(rcd."comisionVendedor"), 0) as total_commission,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'NUMERO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_number,
          COALESCE(SUM(CASE WHEN rcd.tipo = 'REVENTADO' THEN rcd."comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
          COALESCE(SUM(rcd.ganado), 0) as total_prizes,
          COALESCE(SUM(rcd."ticketsCount"), 0) as total_tickets
        FROM "ResumenCierreDiario" rcd
        WHERE rcd."businessDate" >= ${monthlyStartDateStr}::date
          AND rcd."businessDate" <= ${monthlyEndDateStr}::date
          AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)
          ${params.loteriaId ? Prisma.sql`AND rcd."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
      `),

      // G. Pagos y cobros mensuales
      AccountPaymentRepository.findMovementsByDateRange(
        monthlyStartDate,
        monthlyEndDate,
        "vendedor",
        undefined,
        vendedorId
      ),

      // H. balanceResetAt del vendedor
      prisma.user.findUnique({
        where: { id: vendedorId },
        select: { settings: true },
      }),

      // I. Total de sorteos evaluados en el rango
      prisma.sorteo.count({
        where: {
          status: SorteoStatus.EVALUATED,
          scheduledAt: {
            gte: dateRange.fromAt,
            lte: dateRange.toAt,
          },
          ...(params.bancaId ? { bancaId: params.bancaId } : {}),
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
        },
      }),
    ]);

    // Reutilizar o calcular en memoria si es el rango del mes
    const monthlyMovementsByDate = isMonthRange ? movementsByDate : monthlyMovementsByDateRaw;

    let rcdMonthRows = rcdMonthRowsRaw;
    if (isMonthRange) {
      const totalSales = statements.reduce((sum, s) => sum + Number(s.totalSales || 0), 0);
      const totalPrizes = statements.reduce((sum, s) => sum + Number(s.totalPayouts || 0), 0);
      const totalCommission = statements.reduce((sum, s) => sum + Number(s.vendedorCommission || 0), 0);
      const commissionByNumber = rcdCommissionsRows.reduce((sum, r) => sum + Number(r.commission_by_number || 0), 0);
      const commissionByReventado = rcdCommissionsRows.reduce((sum, r) => sum + Number(r.commission_by_reventado || 0), 0);
      const totalTickets = statements.reduce((sum, s) => sum + Number(s.ticketCount || 0), 0);

      rcdMonthRows = [{
        total_sales: totalSales,
        total_commission: totalCommission,
        commission_by_number: commissionByNumber,
        commission_by_reventado: commissionByReventado,
        total_prizes: totalPrizes,
        total_tickets: totalTickets,
      }];
    }

    // Calcular sorteos en memoria sin query adicional a BD
    const totalSorteosCount = rcdCommissionsRows.reduce(
      (sum, row: any) => sum + Number(row.total_sorteos || 0),
      0
    );

    // Mapear statements por fecha string (YYYY-MM-DD)
    const statementByDate = new Map<string, (typeof statements)[0]>();
    for (const s of statements) {
      const dStr = crDateService.postgresDateToCRString(s.date);
      statementByDate.set(dStr, s);
    }

    // Mapear comisiones por fecha
    const rcdByDate = new Map<string, (typeof rcdCommissionsRows)[0]>();
    for (const r of rcdCommissionsRows) {
      const dStr = crDateService.postgresDateToCRString(r.businessDate);
      rcdByDate.set(dStr, r);
    }

    // Unir todas las fechas con actividad o statement
    const allDatesSet = new Set<string>();
    for (const dStr of statementByDate.keys()) allDatesSet.add(dStr);
    for (const dStr of movementsByDate.keys()) allDatesSet.add(dStr);

    const sortedDates = Array.from(allDatesSet).sort((a, b) => b.localeCompare(a));
    const daysArray = sortedDates.map((dateStr) => {
      const stmt = statementByDate.get(dateStr);
      const rcd = rcdByDate.get(dateStr);
      const moves = movementsByDate.get(dateStr) || [];

      const totalSales = stmt ? stmt.totalSales : 0;
      const totalCommission = stmt ? stmt.vendedorCommission : 0;
      const commissionByNumber = Number(rcd?.commission_by_number || 0);
      const commissionByReventado = Number(rcd?.commission_by_reventado || 0);
      const totalPrizes = stmt ? stmt.totalPayouts : 0;
      const totalTickets = (rcd && Number(rcd.total_tickets) > 0) ? Number(rcd.total_tickets) : (stmt ? stmt.ticketCount : 0);

      const totalPaid = moves
        .filter((m: any) => m.type === "payment" && !m.id?.includes('previous-month-balance'))
        .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
      const totalCollected = moves
        .filter((m: any) => m.type === "collection" && !m.id?.includes('previous-month-balance'))
        .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);

      // Si existe stmt, stmt.balance es el balance operativo neto del día (ventas - premios - comisión + pagado - cobrado).
      // Si no existe, se calcula con la misma fórmula contable.
      const dayBalance = stmt ? Number(stmt.balance) : totalSales - totalPrizes - totalCommission + totalPaid - totalCollected;
      const totalBalance = dayBalance;
      const totalRemainingBalance = dayBalance;
      const totalSubtotal = dayBalance;
      const accumulated = stmt ? Number(stmt.remainingBalance) || Number(stmt.accumulatedBalance) || 0 : 0;

      return {
        date: dateStr,
        sorteos: [], // summaryOnly: true -> siempre vacío
        dayTotals: {
          totalSales,
          totalCommission,
          commissionByNumber,
          commissionByReventado,
          totalPrizes,
          totalTickets,
          totalPaid,
          totalCollected,
          totalBalance,
          totalRemainingBalance,
          totalSubtotal,
          accumulated,
        },
      };
    });

    // Fallback: si no hay actividad en el rango pero hay saldo acumulado previo
    if (daysArray.length === 0) {
      const lastStmt = await prisma.accountStatement.findFirst({
        where: {
          vendedorId,
          date: { lt: startDateUTC },
        },
        orderBy: { date: 'desc' },
        select: { accumulatedBalance: true, remainingBalance: true },
      });
      const fallbackAccumulated = lastStmt
        ? Number(lastStmt.remainingBalance) || Number(lastStmt.accumulatedBalance) || 0
        : Number(rangePreviousMonthBalance) || 0;

      if (fallbackAccumulated !== 0) {
        daysArray.push({
          date: startDateStr,
          sorteos: [],
          dayTotals: {
            totalSales: 0,
            totalCommission: 0,
            commissionByNumber: 0,
            commissionByReventado: 0,
            totalPrizes: 0,
            totalTickets: 0,
            totalPaid: 0,
            totalCollected: 0,
            totalBalance: 0,
            totalRemainingBalance: 0,
            totalSubtotal: 0,
            accumulated: fallbackAccumulated,
          },
        });
      }
    }

    // Respetar balanceResetAt si aplica al vendedor
    let balanceResetAt: Date | null = null;
    if (userSettingsRow?.settings && (userSettingsRow.settings as Record<string, any>).balanceResetAt) {
      balanceResetAt = new Date((userSettingsRow.settings as Record<string, any>).balanceResetAt);
    }

    let finalDaysArray = daysArray;
    if (balanceResetAt && params.userRole === Role.VENDEDOR && !params.ignoreReset) {
      const resetAtDayStr = crDateService.dateUTCToCRString(balanceResetAt);
      finalDaysArray = daysArray.filter((day) => day.date >= resetAtDayStr);
    }

    // Totales del período: suma simple de los balances operativos de los días del rango
    const periodBalance = finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0);

    const totals = {
      totalSales: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
      totalCommission: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
      commissionByNumber: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
      commissionByReventado: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
      totalPrizes: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
      totalTickets: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
      totalPaid: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
      totalCollected: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
      totalBalance: periodBalance,
      totalRemainingBalance: periodBalance,
      totalSubtotal: periodBalance,
    };

    // Totales del mes completo (monthlyAccumulated)
    const monthlyTotals = rcdMonthRows[0] || {
      total_sales: 0,
      total_commission: 0,
      commission_by_number: 0,
      commission_by_reventado: 0,
      total_prizes: 0,
      total_tickets: 0,
    };

    const mTotalSales = Number(monthlyTotals.total_sales) || 0;
    const mTotalCommission = Number(monthlyTotals.total_commission) || 0;
    const mCommissionByNumber = Number(monthlyTotals.commission_by_number) || 0;
    const mCommissionByReventado = Number(monthlyTotals.commission_by_reventado) || 0;
    const mTotalPrizes = Number(monthlyTotals.total_prizes) || 0;
    const mTotalTickets = Number(monthlyTotals.total_tickets) || 0;

    let mTotalPaid = 0;
    let mTotalCollected = 0;
    for (const moves of monthlyMovementsByDate.values()) {
      mTotalPaid += moves
        .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
        .reduce((sum: number, m: any) => sum + m.amount, 0);
      mTotalCollected += moves
        .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
        .reduce((sum: number, m: any) => sum + m.amount, 0);
    }

    const prevBalance = Number(rangePreviousMonthBalance) || 0;
    const mTotalBalance = mTotalSales - mTotalPrizes - mTotalCommission;
    const mTotalRemainingBalance = mTotalBalance - mTotalCollected + mTotalPaid;
    const finalMonthlyRemainingBalance = realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : prevBalance + mTotalRemainingBalance;

    const monthlyAccumulated = {
      totalSales: mTotalSales,
      totalCommission: mTotalCommission,
      commissionByNumber: mCommissionByNumber,
      commissionByReventado: mCommissionByReventado,
      totalPrizes: mTotalPrizes,
      totalTickets: mTotalTickets,
      totalPaid: mTotalPaid,
      totalCollected: mTotalCollected,
      totalBalance: prevBalance + mTotalBalance,
      totalRemainingBalance: finalMonthlyRemainingBalance,
      totalSubtotal: finalMonthlyRemainingBalance,
    };

    return {
      data: finalDaysArray,
      meta: {
        totals,
        monthlyAccumulated,
        dateFilter: params.date || "today",
        ...(params.fromDate ? { fromDate: params.fromDate } : {}),
        ...(params.toDate ? { toDate: params.toDate } : {}),
        totalSorteos: totalSorteosCount,
        totalDays: finalDaysArray.length,
      },
    };
  }


  /**
   * Obtiene resumen de sorteos evaluados y/o abiertos con datos financieros agregados
   * GET /api/v1/sorteos/evaluated-summary
   * Por defecto filtra por EVALUATED y OPEN, pero puede especificarse con el parámetro status
   */
  static async evaluatedSummary(
    params: {
      date?: string;
      fromDate?: string;
      toDate?: string;
      scope?: string;
      loteriaId?: string;
      status?: string;
      isActive?: boolean;
      summaryOnly?: boolean;
      ventanaId?: string;
      bancaId?: string;
      sorteoId?: string;
      userRole?: string;
      ignoreReset?: boolean;
      forceRefresh?: boolean;
    },
    vendedorId?: string
  ): Promise<any> {
    // FASE BE-2: Implementación de Cache-Aside con Coalescing y Normalización
    // 1. Obtener fecha local de Costa Rica (YYYY-MM-DD)
    const currentDayStr = crDateService.dateUTCToCRString(new Date());

    // 2. Normalizar: Si el cliente pidió date=range que empieza y termina hoy, ES "today"
    let effectiveDate = params.date || "today";
    let effectiveFromDate = params.fromDate || null;
    let effectiveToDate = params.toDate || null;

    if (
      effectiveDate === "range" &&
      effectiveFromDate === currentDayStr &&
      effectiveToDate === currentDayStr
    ) {
      effectiveDate = "today";
      effectiveFromDate = null;
      effectiveToDate = null;
      params.date = "today";
      params.fromDate = undefined;
      params.toDate = undefined;
    }

    const isMineScope = (params.scope || 'mine') === 'mine';
    const isToday = effectiveDate === 'today';

    // 3. Clave normalizada consistente con el Batch Warmup
    const normalizedKeyData = {
      bancaId: isMineScope ? 'all' : (params.bancaId ?? 'all'),
      ventanaId: isMineScope ? 'all' : (params.ventanaId ?? 'all'),
      vendedorId: vendedorId || null,
      summaryOnly: Boolean(params.summaryOnly),
      date: effectiveDate,
      fromDate: isToday ? undefined : (effectiveFromDate ?? undefined),
      toDate: isToday ? undefined : (effectiveToDate ?? undefined),
      loteriaId: params.loteriaId ?? undefined,
      isActive: params.isActive !== false && params.isActive !== undefined,
      scope: 'mine',
      ignoreReset: Boolean(params.ignoreReset),
    };

    const cacheKey = buildSummaryCacheKey(normalizedKeyData);

    // Días cerrados/históricos (ayer o rangos pasados) no cambian: TTL largo (24h L2)
    // El día de hoy tiene TTL de 1200s (20 minutos) en Redis L2 para absorber navegación recurrente
    const isHistoricalPast =
      effectiveDate === "yesterday" ||
      (effectiveDate === "range" && effectiveToDate !== null && effectiveToDate < currentDayStr);

    const cacheTtlSeconds = isHistoricalPast ? 86400 : 1200;
    const cacheL1TtlMs = isHistoricalPast ? 120_000 : 90_000;

    const tags = ['report:summary'];
    if (vendedorId) tags.push(`vendedor:${vendedorId}`);
    if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
    if (params.bancaId) tags.push(`banca:${params.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    const isForceRefresh = Boolean(params.forceRefresh);

    const MAX_EVALUATED_SUMMARY_MS = 3500;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err: any = new Error("Database timeout exceeded in evaluatedSummary (3500ms)");
        err.code = "TIMEOUT_EXCEEDED";
        reject(err);
      }, MAX_EVALUATED_SUMMARY_MS);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    });

    try {
      return await SingleFlight.do(cacheKey, async () => {
        return Promise.race([
          CacheService.wrap(
            cacheKey,
            async () => {
          // Mutex distribuido ligero: si múltiples réplicas en Render reciben miss simultáneo,
          // una sola calcula en DB y las demás esperan el resultado en caché L1/L2.
          const redis = getRedisClient();
          const inflightLockKey = `lock:calc:summary:${cacheKey}`;
          let acquiredDistLock = false;

          if (redis) {
            try {
              if (isForceRefresh) {
                // Durante warmup/forceRefresh, adquirimos el lock distribuido para que si una petición
                // de terminal entra concurrentemente, espere activamente el resultado en caché L1/L2
                // en lugar de saturar PostgreSQL con un cálculo frío paralelo.
                const lockRes = await (redis as any).set(inflightLockKey, "1", "PX", 8000);
                if (lockRes === "OK") {
                  acquiredDistLock = true;
                }
              } else {
                const lockRes = await (redis as any).set(inflightLockKey, "1", "PX", 2000, "NX");
                if (lockRes !== "OK") {
                  // Esperar hasta 1500ms sondeando la caché en Redis L2 (useL1:false — summaries no ocupan slots L1)
                  const waitStart = Date.now();
                  while (Date.now() - waitStart < 1500) {
                    await new Promise((r) => setTimeout(r, 50));
                    const cached = await CacheService.get<any>(cacheKey, false, cacheL1TtlMs);
                    if (cached !== null) {
                      logger.info({
                        layer: "service",
                        action: "DISTRIBUTED_SINGLE_FLIGHT_CACHE_HIT",
                        payload: { cacheKey, waitMs: Date.now() - waitStart },
                      });
                      return cached;
                    }
                  }
                } else {
                  acquiredDistLock = true;
                }
              }
            } catch (distLockErr: any) {
              logger.warn({
                layer: "service",
                action: "DISTRIBUTED_LOCK_WARN",
                payload: { cacheKey, error: distLockErr?.message },
              });
            }
          }

          try {
            const isMultiDayEndingToday =
              (effectiveDate === "range" || !params.date) &&
              effectiveFromDate !== null &&
              effectiveFromDate < currentDayStr &&
              (!effectiveToDate || effectiveToDate >= currentDayStr);

            if (isMultiDayEndingToday && vendedorId) {
              const todayResult: any = await this.evaluatedSummary(
                {
                  ...params,
                  date: "today",
                  fromDate: undefined,
                  toDate: undefined,
                },
                vendedorId
              );

              const yesterdayDate = new Date();
              yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
              const yesterdayStr = crDateService.dateUTCToCRString(yesterdayDate);

              const pastResult: any = await this.evaluatedSummary(
                {
                  ...params,
                  date: "range",
                  fromDate: effectiveFromDate ?? undefined,
                  toDate: yesterdayStr,
                  forceRefresh: false,
                },
                vendedorId
              );

              const combinedDays = [...(todayResult.data || []), ...(pastResult.data || [])].sort((a: any, b: any) =>
                b.date.localeCompare(a.date)
              );

              const combinedTotals = {
                totalSales: (todayResult.meta?.totals?.totalSales || 0) + (pastResult.meta?.totals?.totalSales || 0),
                totalCommission: (todayResult.meta?.totals?.totalCommission || 0) + (pastResult.meta?.totals?.totalCommission || 0),
                commissionByNumber: (todayResult.meta?.totals?.commissionByNumber || 0) + (pastResult.meta?.totals?.commissionByNumber || 0),
                commissionByReventado: (todayResult.meta?.totals?.commissionByReventado || 0) + (pastResult.meta?.totals?.commissionByReventado || 0),
                totalPrizes: (todayResult.meta?.totals?.totalPrizes || 0) + (pastResult.meta?.totals?.totalPrizes || 0),
                totalTickets: (todayResult.meta?.totals?.totalTickets || 0) + (pastResult.meta?.totals?.totalTickets || 0),
                totalPaid: (todayResult.meta?.totals?.totalPaid || 0) + (pastResult.meta?.totals?.totalPaid || 0),
                totalCollected: (todayResult.meta?.totals?.totalCollected || 0) + (pastResult.meta?.totals?.totalCollected || 0),
                totalBalance: (todayResult.meta?.totals?.totalBalance || 0) + (pastResult.meta?.totals?.totalBalance || 0),
                totalRemainingBalance: todayResult.meta?.totals?.totalRemainingBalance ?? 0,
                totalSubtotal: todayResult.meta?.totals?.totalRemainingBalance ?? 0,
              };

              return {
                data: combinedDays,
                meta: {
                  totals: combinedTotals,
                  monthlyAccumulated: todayResult.meta?.monthlyAccumulated,
                  dateFilter: "range",
                  fromDate: effectiveFromDate,
                  toDate: effectiveToDate || currentDayStr,
                  totalSorteos: (todayResult.meta?.totalSorteos || 0) + (pastResult.meta?.totalSorteos || 0),
                  totalDays: combinedDays.length,
                },
              };
            }

            // Resolver rango de fechas
            const dateRange = resolveDateRange(
              params.date || "today",
              params.fromDate,
              params.toDate
            );

            //  FAST-PATH: summaryOnly=true con vendedorId
            // Resuelve desde AccountStatement en < 5 ms evitando escanear Ticket/Jugada
            if (params.summaryOnly && vendedorId) {
              const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
              const rangeEffectiveMonth = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}`;
              return await this.evaluatedSummaryFastPath(params, vendedorId, dateRange, rangeEffectiveMonth);
            }

            // ⚡ FAST-PATH O(1) VIA POSTGRESQL FUNCTION: isToday === true con summaryOnly === false
            // Resuelve el reporte detallado ejecutando directamente la función compilada de base de datos
            // fn_get_evaluated_summaries_batch en < 20 ms, eliminando 7 a 9 consultas Prisma dispersas.
            if (isToday && !params.summaryOnly && vendedorId) {
              let targetSorteoId = params.sorteoId;
              let targetBancaId = params.bancaId;

              if (!targetSorteoId) {
                // Si el usuario es vendedor y no viene bancaId, resolver su bancaId para no cruzar sorteos de otra banca
                if (!targetBancaId && vendedorId) {
                  const vendorUser = await prisma.user.findUnique({
                    where: { id: vendedorId },
                    select: { bancaId: true },
                  });
                  if (vendorUser?.bancaId) {
                    targetBancaId = vendorUser.bancaId;
                  }
                }

                const todayAnchor = await prisma.sorteo.findFirst({
                  where: {
                    scheduledAt: {
                      gte: dateRange.fromAt,
                      lte: dateRange.toAt,
                    },
                    ...(targetBancaId ? { bancaId: targetBancaId } : {}),
                    ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
                  },
                  orderBy: [
                    { status: 'desc' }, // EVALUATED > OPEN > SCHEDULED
                    { scheduledAt: 'desc' },
                  ],
                  select: { id: true, bancaId: true },
                });
                if (todayAnchor) {
                  targetSorteoId = todayAnchor.id;
                  if (!targetBancaId && todayAnchor.bancaId) {
                    targetBancaId = todayAnchor.bancaId;
                  }
                }
              }

              if (targetSorteoId) {
                const batchRows = await prisma.$queryRaw<Array<{
                  full_payload: any;
                  initial_accumulated: string | number;
                }>>(Prisma.sql`
                  SELECT full_payload, initial_accumulated 
                  FROM fn_get_evaluated_summaries_batch(
                    ${targetSorteoId}::uuid, 
                    ${targetBancaId ?? null}::uuid
                  ) 
                  WHERE user_id = ${vendedorId}::uuid
                `);

                if (batchRows && batchRows.length > 0) {
                  const row = batchRows[0];
                  let fullPayload = row.full_payload as any;
                  const initialAccumulated = Number(row.initial_accumulated) || 0;

                  let resetAt: Date | null = null;
                  if (!params.ignoreReset) {
                    const user = await prisma.user.findUnique({
                      where: { id: vendedorId },
                      select: { settings: true },
                    });
                    if (user?.settings && (user.settings as Record<string, any>).balanceResetAt) {
                      resetAt = new Date((user.settings as Record<string, any>).balanceResetAt);
                    }
                  }

                  const dayData = fullPayload?.data?.[0];

                  if (dayData?.sorteos && Array.isArray(dayData.sorteos) && dayData.sorteos.length > 0) {
                    const rawEvents: any[] = dayData.sorteos;
                    const totalChronological = rawEvents.length;
                    let evAccumulated = initialAccumulated;
                    let rApplied = false;

                    const decoratedEvents = rawEvents.map((event: any) => {
                      let eventTime = new Date(event.scheduledAt).getTime();
                      const isMov = typeof event.sorteoId === 'string' && event.sorteoId.startsWith('mov-');

                      if (isMov && event.date && event.time && /^\d{1,2}:\d{2}/.test(event.time.trim())) {
                        const [hh, mm] = event.time.trim().split(':').map(Number);
                        if (!isNaN(hh) && !isNaN(mm) && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
                          const [y, m, d] = event.date.split('-').map(Number);
                          const utcDate = new Date(Date.UTC(y, m - 1, d, hh + 6, mm, 0, 0));
                          event.scheduledAt = utcDate.toISOString();
                          eventTime = utcDate.getTime();
                        }
                      }

                      return {
                        event,
                        time: eventTime,
                        isMov,
                      };
                    });

                    // 1. ORDENAR CRONOLÓGICAMENTE ASCENDENTE ANTES DE ACUMULAR
                    decoratedEvents.sort((a, b) => {
                      if (a.time !== b.time) return a.time - b.time;
                      if (a.isMov !== b.isMov) return a.isMov ? -1 : 1;
                      const aSorteoId = a.event.sorteoId || '';
                      const bSorteoId = b.event.sorteoId || '';
                      return aSorteoId.localeCompare(bSorteoId);
                    });

                    // 2. CALCULAR EL ACUMULADO Y CHRONOLOGICAL INDEX EN ORDEN REAL
                    for (let j = 0; j < decoratedEvents.length; j++) {
                      const item = decoratedEvents[j];

                      if (resetAt && !rApplied && resetAt.getTime() >= dateRange.fromAt.getTime()) {
                        if (item.time >= resetAt.getTime()) {
                          evAccumulated = 0;
                          rApplied = true;
                        }
                      }

                      evAccumulated += Number(item.event.subtotal) || 0;
                      item.event = {
                        ...item.event,
                        accumulated: evAccumulated,
                        chronologicalIndex: j + 1,
                        totalChronological,
                      };
                    }

                    // 3. REORDENAR DESCENDENTE PARA LA VISTA DE LA APK (MÁS RECIENTE ARRIBA)
                    decoratedEvents.sort((a, b) => {
                      const idxA = a.event.chronologicalIndex || 0;
                      const idxB = b.event.chronologicalIndex || 0;
                      if (idxA !== idxB) return idxB - idxA;
                      if (a.time !== b.time) return b.time - a.time;
                      if (a.isMov !== b.isMov) return a.isMov ? 1 : -1;
                      return 0;
                    });

                    dayData.sorteos = decoratedEvents.map((item) => item.event);

                    // ── REGLA 4 AGENTS.md: AccountStatement es la fuente de verdad contable ──
                    // El campo dayData.dayTotals.accumulated ya fue extraído directamente de AccountStatement por
                    // la función SQL compilada (fn_get_evaluated_summaries_batch).
                    // Para evitar discrepancias entre la vista colapsada (summaryOnly=true) y la expandida (false):
                    // 1. Si no hay reset administrativo y la DB tiene saldo, se respeta inmutablemente AccountStatement.
                    // 2. Si hay resetAt activo, se toma el saldo post-reset del closingEvent (mayor chronologicalIndex).
                    // 3. Si AccountStatement viene en 0 o vacío (día activo sin evaluar), fallback al closingEvent.
                    const dbAccumulated = Number(dayData.dayTotals.accumulated) || 0;
                    const closingEvent = decoratedEvents.reduce((max, item) =>
                      ((item.event.chronologicalIndex || 0) > (max.event.chronologicalIndex || 0) ? item : max),
                      decoratedEvents[0]
                    );

                    if (resetAt) {
                      dayData.dayTotals.accumulated = closingEvent.event.accumulated;
                    } else if (dbAccumulated !== 0) {
                      dayData.dayTotals.accumulated = dbAccumulated;
                    } else {
                      dayData.dayTotals.accumulated = closingEvent.event.accumulated;
                    }
                    fullPayload = { ...fullPayload, data: [dayData] };
                  } else if (initialAccumulated !== 0) {
                    // Si no hay sorteos hoy pero hay saldo acumulado previo, reflejarlo
                    if (dayData) {
                      dayData.dayTotals.accumulated = initialAccumulated;
                    } else {
                      const todayDateStr = crDateService.dateUTCToCRString(new Date());
                      fullPayload.data = [{
                        date: todayDateStr,
                        sorteos: [],
                        dayTotals: {
                          totalSales: 0,
                          totalCommission: 0,
                          commissionByNumber: 0,
                          commissionByReventado: 0,
                          totalPrizes: 0,
                          totalTickets: 0,
                          totalPaid: 0,
                          totalCollected: 0,
                          totalBalance: 0,
                          totalRemainingBalance: 0,
                          totalSubtotal: 0,
                          accumulated: initialAccumulated,
                        },
                      }];
                      if (fullPayload.meta) {
                        fullPayload.meta.totalDays = 1;
                      }
                    }
                  }

                  if (resetAt && Array.isArray(fullPayload?.data)) {
                    const resetAtDayStr = crDateService.dateUTCToCRString(resetAt);
                    const filteredData = fullPayload.data.filter((d: any) => d.date >= resetAtDayStr);
                    fullPayload = {
                      ...fullPayload,
                      data: filteredData,
                      meta: { ...fullPayload.meta, totalDays: filteredData.length },
                    };
                  }

                  logger.info({
                    layer: 'service',
                    action: 'SORTEO_EVALUATED_SUMMARY_BATCH_FN_FAST_PATH_HIT',
                    payload: {
                      vendedorId,
                      targetSorteoId,
                      totalEvents: dayData?.sorteos?.length || 0,
                    },
                  });

                  return fullPayload;
                }
              }
            }

            //  CAMBIO: Forzar status EVALUATED (Global Filter)
            // Ya no permitimos que el cliente solicite otros estados para este reporte
            const allowedStatuses: SorteoStatus[] = [SorteoStatus.EVALUATED];

            // Ignorar params.status para garantizar integridad financiera
            if (params.status) {
              logger.warn({
                layer: "service",
                action: "SORTEO_EVALUATED_SUMMARY_FILTER_IGNORED",
                payload: {
                  message: "Client requested specific status but was ignored due to Global Evaluated Rule",
                  requestedStatus: params.status
                }
              });
            }

            // Construir filtro de status de tickets
            // Filtro de isActive: si no se proporciona, se asume true (solo tickets activos)
            const ticketIsActive = params.isActive !== false && params.isActive !== undefined;


            //  C3.4 OPTIMIZACIÓN: Resolver rango mensual una sola vez (se usa en monthlyAccumulated)
            const monthlyRange = resolveDateRange("month");
            const monthlyStartDate = monthlyRange.fromAt;
            const monthlyEndDate = monthlyRange.toAt;

            const fromAtComponents = getCRLocalComponents(dateRange.fromAt);
            const rangeEffectiveMonth = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}`;

            // Tareas de ejecución paralela para métricas principales
            const [sorteoMetricsRaw, movementsByDate, rangePreviousMonthBalance] = await Promise.all([
              prisma.$queryRaw<any[]>(Prisma.sql`
          SELECT 
            s.id as "sorteoId", s."scheduledAt", s."loteriaId", s.name as "sorteoName", s."extraMultiplierId", s."extraMultiplierX", s."winningNumber",
            l.name as "loteriaName",
            SUM(rcd."totalVendida") as "totalSales",
            SUM(rcd."comisionTotal") as "totalCommission",
            SUM(rcd."ganado") as "totalPrizes",
            SUM(rcd."ticketsCount")::integer as "ticketCount"
          FROM "ResumenCierreDiario" rcd
          JOIN "Sorteo" s ON rcd."sorteoId" = s.id
          JOIN "Loteria" l ON s."loteriaId" = l.id
          WHERE s.status::text = ${SorteoStatus.EVALUATED}
            AND s."scheduledAt" >= CAST(${dateRange.fromAt} AS timestamp)
            AND s."scheduledAt" <= CAST(${dateRange.toAt} AS timestamp)
            ${vendedorId ? Prisma.sql`AND rcd."vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
            ${params.ventanaId ? Prisma.sql`AND rcd."ventanaId" = CAST(${params.ventanaId} AS uuid)` : Prisma.empty}
            ${params.bancaId ? Prisma.sql`AND rcd."bancaId" = CAST(${params.bancaId} AS uuid)` : Prisma.empty}
            ${params.loteriaId ? Prisma.sql`AND s."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
          GROUP BY s.id, s."scheduledAt", s."loteriaId", s.name, s."extraMultiplierId", s."extraMultiplierX", s."winningNumber", l.name
          ORDER BY s."scheduledAt" ASC, s."loteriaId" ASC, s.id ASC
        `),
              AccountPaymentRepository.findMovementsByDateRange(
                dateRange.fromAt,
                dateRange.toAt,
                "vendedor",
                undefined,
                vendedorId
              ),
              getPreviousMonthFinalBalance(
                rangeEffectiveMonth,
                "vendedor",
                undefined,
                vendedorId,
                undefined
              )
            ]);

            const sorteoIds = sorteoMetricsRaw.map((sm) => sm.sorteoId);

            // ⚡ FAST-PATH FALLBACK: Si no hay sorteos evaluados con ventas para este vendedor en el rango
            // y tampoco hay movimientos en el día, delegamos inmediatamente a evaluatedSummaryFastPath.
            // Esto evita escanear Ticket/Jugada y ejecutar 5 queries secuenciales contra PostgreSQL,
            // resolviendo cualquier miss Cold/DB en < 5 ms en lugar de saturar la base de datos.
            if (sorteoIds.length === 0 && movementsByDate.size === 0 && vendedorId) {
              return await this.evaluatedSummaryFastPath(params, vendedorId, dateRange, rangeEffectiveMonth);
            }

            let ticketMetrics: any[] = [];
            let multiplierMetricsRaw: any[] = [];
            let loteriaMultipliers: any[] = [];

            if (sorteoIds.length > 0 && !params.summaryOnly) {
              // 🚀 O(1) LOOKUP: Reemplaza los escaneos de Ticket y Jugada por la tabla consolidada
              const [rsmRows, lotMultipliers] = await Promise.all([
                prisma.resumenSorteoMultiplicador.findMany({
                  where: {
                    sorteoId: { in: sorteoIds },
                    ...(vendedorId ? { vendedorId } : {}),
                    ...(params.bancaId ? { bancaId: params.bancaId } : {}),
                  },
                }),
                CacheService.wrap(
                  "catalog:loteria:multipliers:all",
                  () => prisma.loteriaMultiplier.findMany({
                    select: { id: true, name: true, valueX: true, loteriaId: true, kind: true, isActive: true }
                  }),
                  3600,
                  ['multipliers', 'loterias'],
                  false // Zero-L1: solo Redis L2
                ),
              ]);

              loteriaMultipliers = lotMultipliers;

              // Agregación en memoria para multiplierMetricsRaw y ticketMetrics
              const ticketAggMap = new Map<string, {
                sorteoId: string;
                winningTicketsCount: number;
                paidTicketsCount: number;
                vendedorCommissionSum: number;
              }>();

              for (const row of rsmRows) {
                // 1. Mapeo para multiplierMetricsRaw (mantiene el contrato con by_multiplier)
                multiplierMetricsRaw.push({
                  sorteoId: row.sorteoId,
                  multiplierId: row.multiplierId,
                  mSales: row.totalSales,
                  mCommission: row.totalCommission,
                  mCommNum: row.commissionByNumber,
                  mCommRev: row.commissionByReventado,
                  mPrizes: row.totalPrizes,
                  mTickets: row.ticketCount,
                  mWinningTickets: row.winningTicketsCount,
                  mPaidTickets: row.paidTicketsCount,
                });

                // 2. Acumulador para ticketMetrics por sorteoId
                let tEntry = ticketAggMap.get(row.sorteoId);
                if (!tEntry) {
                  tEntry = {
                    sorteoId: row.sorteoId,
                    winningTicketsCount: 0,
                    paidTicketsCount: 0,
                    vendedorCommissionSum: 0,
                  };
                  ticketAggMap.set(row.sorteoId, tEntry);
                }
                tEntry.winningTicketsCount += row.winningTicketsCount;
                tEntry.paidTicketsCount += row.paidTicketsCount;
                tEntry.vendedorCommissionSum += row.totalCommission;
              }

              ticketMetrics = Array.from(ticketAggMap.values());
            }

            const sorteoMetrics = sorteoMetricsRaw.map((sm: any) => {
              const tm = ticketMetrics.find((t) => t.sorteoId === sm.sorteoId);
              return {
                ...sm,
                totalCommission: Number(tm?.vendedorCommissionSum || 0),
                winningTicketsCount: Number(tm?.winningTicketsCount || 0),
                paidTicketsCount: Number(tm?.paidTicketsCount || 0)
              };
            });

            const consolidatedMetrics = sorteoMetrics.map((sm: any) => {
              let by_multiplier: any[] = [];

              if (!params.summaryOnly) {
                const baseMultipliers = loteriaMultipliers.filter((m: any) =>
                  m.loteriaId === sm.loteriaId && (m.isActive || multiplierMetricsRaw.some((mm: any) => mm.sorteoId === sm.sorteoId && mm.multiplierId === m.id))
                );

                by_multiplier = baseMultipliers.map((bm: any) => {
                  const mm = multiplierMetricsRaw.find((m: any) => m.sorteoId === sm.sorteoId && m.multiplierId === bm.id);

                  return {
                    multiplierId: bm.id,
                    multiplierName: bm.name,
                    multiplierValue: Number(bm.valueX),
                    totalSales: Number(mm?.mSales || 0),
                    totalCommission: Number(mm?.mCommission || 0),
                    commissionByNumber: Number(mm?.mCommNum || 0),
                    commissionByReventado: Number(mm?.mCommRev || 0),
                    totalPrizes: Number(mm?.mPrizes || 0),
                    ticketCount: Number(mm?.mTickets || 0),
                    winningTicketsCount: Number(mm?.mWinningTickets || 0),
                    paidTicketsCount: Number(mm?.mPaidTickets || 0),
                    unpaidTicketsCount: Number(mm?.mWinningTickets || 0) - Number(mm?.mPaidTickets || 0)
                  };
                }).sort((a: any, b: any) => a.multiplierValue - b.multiplierValue);

                // Manejar jugadas con multiplierId = null.
                // Causa conocida: fn_evaluate_sorteo solo asigna extraMultiplierId a jugadas REVENTADO ganadoras,
                // los perdedores quedan con multiplierId = null. Si el sorteo tiene extraMultiplierId, fusionar
                // esas jugadas en el bucket correcto en lugar de mostrarlas como "Desconocido / Eliminado".
                const nullMetrics = multiplierMetricsRaw.find((m: any) => m.sorteoId === sm.sorteoId && m.multiplierId === null);
                if (nullMetrics) {
                  const reventadoBucket = sm.extraMultiplierId
                    ? by_multiplier.find((b: any) => b.multiplierId === sm.extraMultiplierId)
                    : null;

                  if (reventadoBucket) {
                    // Fusionar en el bucket del multiplicador REVENTADO del sorteo
                    reventadoBucket.totalSales += Number(nullMetrics.mSales || 0);
                    reventadoBucket.totalCommission += Number(nullMetrics.mCommission || 0);
                    reventadoBucket.commissionByNumber += Number(nullMetrics.mCommNum || 0);
                    reventadoBucket.commissionByReventado += Number(nullMetrics.mCommRev || 0);
                    reventadoBucket.totalPrizes += Number(nullMetrics.mPrizes || 0);
                    reventadoBucket.ticketCount += Number(nullMetrics.mTickets || 0);
                    reventadoBucket.winningTicketsCount += Number(nullMetrics.mWinningTickets || 0);
                    reventadoBucket.paidTicketsCount += Number(nullMetrics.mPaidTickets || 0);
                    reventadoBucket.unpaidTicketsCount = reventadoBucket.winningTicketsCount - reventadoBucket.paidTicketsCount;
                  } else if (sm.extraMultiplierId) {
                    // El bucket REVENTADO no existe aún (multiplicador inactivo y sin jugadas ganadoras).
                    // Crearlo usando los datos del multiplicador.
                    const reventadoMul = loteriaMultipliers.find((m: any) => m.id === sm.extraMultiplierId);
                    by_multiplier.push({
                      multiplierId: sm.extraMultiplierId,
                      multiplierName: reventadoMul?.name ?? 'REVENTADO',
                      multiplierValue: Number(reventadoMul?.valueX ?? 0),
                      totalSales: Number(nullMetrics.mSales || 0),
                      totalCommission: Number(nullMetrics.mCommission || 0),
                      commissionByNumber: Number(nullMetrics.mCommNum || 0),
                      commissionByReventado: Number(nullMetrics.mCommRev || 0),
                      totalPrizes: Number(nullMetrics.mPrizes || 0),
                      ticketCount: Number(nullMetrics.mTickets || 0),
                      winningTicketsCount: Number(nullMetrics.mWinningTickets || 0),
                      paidTicketsCount: Number(nullMetrics.mPaidTickets || 0),
                      unpaidTicketsCount: Number(nullMetrics.mWinningTickets || 0) - Number(nullMetrics.mPaidTickets || 0)
                    });
                  } else {
                    // No hay extraMultiplierId: multiplicador realmente desconocido/eliminado (fallback)
                    by_multiplier.push({
                      multiplierId: null,
                      multiplierName: 'Desconocido / Eliminado',
                      multiplierValue: 0,
                      totalSales: Number(nullMetrics.mSales || 0),
                      totalCommission: Number(nullMetrics.mCommission || 0),
                      commissionByNumber: Number(nullMetrics.mCommNum || 0),
                      commissionByReventado: Number(nullMetrics.mCommRev || 0),
                      totalPrizes: Number(nullMetrics.mPrizes || 0),
                      ticketCount: Number(nullMetrics.mTickets || 0),
                      winningTicketsCount: Number(nullMetrics.mWinningTickets || 0),
                      paidTicketsCount: Number(nullMetrics.mPaidTickets || 0),
                      unpaidTicketsCount: Number(nullMetrics.mWinningTickets || 0) - Number(nullMetrics.mPaidTickets || 0)
                    });
                  }
                }
              }

              return { ...sm, by_multiplier };
            });

            //  PASO 2: Construir datos de sorteos SIN calcular accumulated aún
            const sorteoData = consolidatedMetrics.map((row: any) => {
              // Calcular isReventado
              const isReventado =
                (row.extraMultiplierId !== null &&
                  row.extraMultiplierId !== undefined) ||
                (row.extraMultiplierX !== null &&
                  row.extraMultiplierX !== undefined &&
                  row.extraMultiplierX > 0);

              // Calcular subtotal
              const subtotal =
                Number(row.totalSales) -
                Number(row.totalCommission) -
                Number(row.totalPrizes);

              const winningCount = Number(row.winningTicketsCount) || 0;
              const paidCount = Number(row.paidTicketsCount) || 0;
              const unpaidCount = winningCount - paidCount;

              // Mapear byMultiplier desde el JSON de la query
              const byMultiplierRaw = row.by_multiplier || [];
              const byMultiplier = byMultiplierRaw.map((m: any) => ({
                multiplierId: m.multiplierId,
                multiplierName: m.multiplierName,
                multiplierValue: Number(m.multiplierValue),
                totalSales: Number(m.totalSales),
                totalCommission: Number(m.totalCommission),
                commissionByNumber: Number(m.commissionByNumber),
                commissionByReventado: Number(m.commissionByReventado),
                totalPrizes: Number(m.totalPrizes),
                ticketCount: Number(m.ticketCount),
                subtotal: Number(m.totalSales) - Number(m.totalCommission) - Number(m.totalPrizes),
                winningTicketsCount: Number(m.winningTicketsCount),
                paidTicketsCount: Number(m.paidTicketsCount),
                unpaidTicketsCount: Number(m.unpaidTicketsCount),
              }));

              // NUEVO: Calcular comisiones por tipo agregadas desde multiplicadores
              const commissionByNumber = byMultiplier.reduce((sum: number, m: any) => sum + m.commissionByNumber, 0);
              const commissionByReventado = byMultiplier.reduce((sum: number, m: any) => sum + m.commissionByReventado, 0);

              return {
                sorteoId: row.sorteoId,
                sorteoName: row.sorteoName,
                scheduledAt: row.scheduledAt, // Guardar Date para ordenar después
                date: formatDateOnly(new Date(row.scheduledAt)),
                time: formatTime12h(new Date(row.scheduledAt)),
                loteriaId: row.loteriaId,
                loteriaName: row.loteriaName || "Desconocida",
                winningNumber: row.winningNumber ?? null,
                isReventado,
                totalSales: Number(row.totalSales),
                totalCommission: Number(row.totalCommission),
                commissionByNumber,
                commissionByReventado,
                totalPrizes: Number(row.totalPrizes),
                ticketCount: Number(row.ticketCount),
                subtotal,
                accumulated: 0, // Se calculará después junto con movimientos
                chronologicalIndex: 0,
                totalChronological: consolidatedMetrics.length,
                winningTicketsCount: winningCount,
                paidTicketsCount: paidCount,
                unpaidTicketsCount: unpaidCount,
                byMultiplier,
              };
            });

            // Log de depuración
            logger.info({
              layer: "service",
              action: "SORTEO_EVALUATED_SUMMARY_CONSOLIDATED_SUCCESS",
              payload: {
                vendedorId,
                sorteosFound: consolidatedMetrics.length,
                message: "Resumen evaluado generado mediante query consolidada",
              },
            });



            // Inyectar movimiento sintético "Saldo del mes anterior" si el rango empieza el día 1
            const firstDayOfRange = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
            if (fromAtComponents.day === 1) {
              const firstDayMovements = movementsByDate.get(firstDayOfRange) || [];
              const movementId = `previous-month-balance-${vendedorId}`;
              const alreadyExists = firstDayMovements.some((m: any) => m.id === movementId);
              const numericPreviousBalance = Number(rangePreviousMonthBalance) || 0;
              if (!alreadyExists && numericPreviousBalance !== 0) {
                firstDayMovements.unshift({
                  id: movementId,
                  type: "payment" as const,
                  amount: numericPreviousBalance,
                  method: "Saldo del mes anterior",
                  notes: `Saldo arrastrado del mes anterior`,
                  isReversed: false,
                  createdAt: new Date(`${firstDayOfRange}T00:00:00.000Z`).toISOString(),
                  date: firstDayOfRange,
                  time: '00:00',
                  isOpeningBalance: true,
                });
                movementsByDate.set(firstDayOfRange, firstDayMovements);
              }
            }

            //  PASO 3: Convertir movimientos a items con la misma estructura que sorteos
            const movementItems: any[] = [];
            for (const [dateStr, movements] of movementsByDate.entries()) {
              for (const movement of movements) {
                if (!movement.isReversed) {
                  //  CRÍTICO: Detectar si es el movimiento especial "Saldo del mes anterior"
                  const isOpeningBalance = movement.id?.startsWith('previous-month-balance-');

                  //  CRÍTICO: Usar movement.time si está disponible (hora real del movimiento)
                  // Si no, fallback a createdAt (hora de registro en BD)
                  let scheduledAt: Date;
                  let timeDisplay: string;

                  const hasValidTime = movement.time && typeof movement.time === 'string' && movement.time.trim().length > 0;
                  const [year, month, day] = movement.date.split('-').map(Number);

                  //  CRÍTICO: El saldo del mes anterior SIEMPRE debe ser el primer evento del día
                  if (isOpeningBalance) {
                    // Forzar hora 00:00:00 para que sea el primer evento cronológicamente
                    scheduledAt = new Date(Date.UTC(year, month - 1, day, 6, 0, 0, 0)); // 00:00 CR = 06:00 UTC
                    timeDisplay = "12:00AM ";
                  } else if (hasValidTime) {
                    // Usar movement.time (formato HH:MM en hora CR)
                    const [hours, minutes] = movement.time.split(':').map(Number);

                    // Convertir hora CR a UTC para scheduledAt (CR es UTC-6, sumar 6 horas)
                    const utcHours = hours + 6;
                    if (utcHours >= 24) {
                      // Día siguiente en UTC
                      scheduledAt = new Date(Date.UTC(year, month - 1, day + 1, utcHours - 24, minutes, 0));
                    } else {
                      scheduledAt = new Date(Date.UTC(year, month - 1, day, utcHours, minutes, 0));
                    }

                    // Formatear hora en 12h
                    const ampm = hours >= 12 ? 'PM' : 'AM';
                    const hours12 = hours % 12 || 12;
                    timeDisplay = `${hours12}:${String(minutes).padStart(2, '0')}${ampm} `;
                  } else {
                    // Fallback: usar createdAt
                    const createdAtDate = new Date(movement.createdAt);
                    // Convertir UTC a CR (UTC-6)
                    const crTime = new Date(createdAtDate.getTime() - (6 * 60 * 60 * 1000));
                    const hour = crTime.getUTCHours();
                    const minute = crTime.getUTCMinutes();
                    const seconds = crTime.getUTCSeconds();
                    //  CRÍTICO: Usar Date.UTC y ajustar offset (UTC-6) para evitar dependencia de la hora local del server
                    scheduledAt = new Date(Date.UTC(year, month - 1, day, hour, minute, seconds) + (6 * 60 * 60 * 1000));
                    timeDisplay = formatTime12h(scheduledAt);
                  }

                  //  CRÍTICO: El movimiento especial tiene subtotal: 0 porque el saldo ya está en eventAccumulated inicial
                  //  CRÍTICO: Usar Number() para garantizar tipo numérico y evitar concatenación de strings
                  //  Si es el saldo del mes anterior, subtotal = 0 (ya está en initialAccumulatedForRange)
                  const subtotal = isOpeningBalance
                    ? 0
                    : (movement.type === 'payment' ? Number(movement.amount || 0) : -Number(movement.amount || 0));

                  movementItems.push({
                    sorteoId: `mov-${movement.id}`,
                    sorteoName: isOpeningBalance
                      ? 'Saldo del mes anterior'
                      : (movement.type === 'payment' ? 'Pago recibido' : 'Cobro realizado'),
                    scheduledAt, //  Fecha del usuario + hora del movimiento (o creación como fallback)
                    date: movement.date, //  Fecha que el usuario indicó
                    time: timeDisplay, //  Usar hora de movement.time si disponible
                    loteriaId: null,
                    loteriaName: null,
                    winningNumber: null,
                    isReventado: false,
                    totalSales: 0,
                    totalCommission: 0,
                    commissionByNumber: 0,
                    commissionByReventado: 0,
                    totalPrizes: 0,
                    ticketCount: 0,
                    subtotal, //  CRÍTICO: Usar variable calculada (normal para saldo inicial)
                    accumulated: 0, // Se recalculará después
                    chronologicalIndex: 0,
                    totalChronological: 0,
                    winningTicketsCount: 0,
                    paidTicketsCount: 0,
                    unpaidTicketsCount: 0,
                    byMultiplier: [],
                    // Campos específicos de movimiento
                    type: movement.type,
                    amount: movement.amount,
                    method: movement.method || (isOpeningBalance ? 'Saldo del mes anterior' : ''),
                    notes: movement.notes || (isOpeningBalance ? 'Saldo arrastrado del mes anterior' : ''),
                  });
                }
              }
            }

            //  PASO 4: Combinar sorteos y movimientos y ordenar cronológicamente
            const allEvents = [...sorteoData, ...movementItems];
            allEvents.sort((a, b) => {
              const timeA = new Date(a.scheduledAt).getTime();
              const timeB = new Date(b.scheduledAt).getTime();
              if (timeA !== timeB) return timeA - timeB;
              const aIsMov = a.sorteoId?.startsWith('mov-');
              const bIsMov = b.sorteoId?.startsWith('mov-');
              if (aIsMov !== bIsMov) return aIsMov ? -1 : 1;
              const aId = a.sorteoId || a.id || '';
              const bId = b.sorteoId || b.id || '';
              return aId.localeCompare(bId);
            });

            let initialAccumulatedForRange = 0;

            // Calcular siempre recursivamente, el frontend ya no nos pasa initialAccumulated
            if (allEvents.length > 0) {
              const firstEventDate = allEvents[0].date;
              const [firstYear, firstMonth, firstDay] = firstEventDate.split('-').map(Number);

              if (firstDay === 1) {
                //  Si el rango empieza el día 1 del mes, usar el saldo del mes anterior
                initialAccumulatedForRange = Number(rangePreviousMonthBalance) || 0;
              } else {
                //  Si el rango NO empieza el día 1, obtener el accumulatedBalance del día anterior
                //  desde AccountStatement (fuente de verdad)
                //  CRÍTICO: Usar fecha local Costa Rica (00:00 CR = 06:00 UTC) para evitar truncamiento por TZ
                const previousDayStr = crDateService.subtractDays(firstEventDate, 1);
                const previousDay = new Date(`${previousDayStr}T06:00:00.000Z`);
                const previousDayStatement = await prisma.accountStatement.findFirst({
                  where: {
                    vendedorId,
                    date: previousDay,
                  },
                  select: { accumulatedBalance: true, remainingBalance: true },
                });

                if (previousDayStatement) {
                  //  Si hay statement del día anterior, empezamos desde su acumulado
                  // Y no hay gap (porque el día anterior ya tiene su cierre, no hay boletos perdidos)
                  initialAccumulatedForRange = Number(previousDayStatement.remainingBalance) || Number(previousDayStatement.accumulatedBalance) || 0;
                  // No sumar gap de tickets.
                } else {
                  //  Si NO hay statement del día anterior, hay que buscar el último statement válido
                  // que exista ANTES del rango consultado, para saber de dónde partir matemáticamente.
                  const lastStatementBeforeRange = await prisma.accountStatement.findFirst({
                    where: {
                      vendedorId,
                      date: { lt: previousDay },
                    },
                    orderBy: { date: 'desc' },
                    select: { date: true, accumulatedBalance: true, remainingBalance: true },
                  });

                  let baseBalance = 0;
                  let gapStartStr = `${firstYear}-${String(firstMonth).padStart(2, '0')}-01`; // Fallback: inicio de mes

                  if (lastStatementBeforeRange) {
                    baseBalance = Number(lastStatementBeforeRange.remainingBalance) || Number(lastStatementBeforeRange.accumulatedBalance) || 0;
                    // El gap empieza el día DESPUÉS de este último statement válido
                    const lsDateStr = crDateService.postgresDateToCRString(lastStatementBeforeRange.date);
                    gapStartStr = crDateService.addDays(lsDateStr, 1);
                  } else {
                    baseBalance = Number(rangePreviousMonthBalance) || 0;
                  }

                  // Si hay un gap de días sin statement, calcular los movimientos faltantes matemáticamente
                  // REGLA 4 AGENTS.md: NUNCA escanear Ticket/Jugada interactivamente. Se usa ResumenCierreDiario (O(1)).
                  if (!params.summaryOnly && gapStartStr <= previousDayStr) {
                    const [gapSalesRes, gapPaymentsRes] = await Promise.all([
                      prisma.$queryRaw<any[]>(Prisma.sql`
                        SELECT COALESCE(SUM("totalVendida" - "comisionVendedor" - "ganado"), 0) as "gapBalance"
                        FROM "ResumenCierreDiario"
                        WHERE "vendedorId" = CAST(${vendedorId} AS uuid)
                          AND "businessDate" >= ${gapStartStr}::date
                          AND "businessDate" <= ${previousDayStr}::date
                      `),
                      prisma.$queryRaw<any[]>(Prisma.sql`
                        SELECT COALESCE(SUM(CASE WHEN m.type = 'payment' THEN m.amount ELSE -m.amount END), 0) as "gapMovements"
                        FROM "AccountPayment" m
                        WHERE m."vendedorId" = CAST(${vendedorId} AS uuid)
                          AND m.date >= ${gapStartStr}::date
                          AND m.date <= ${previousDayStr}::date
                          AND m."isReversed" = false
                      `),
                    ]);

                    const gapBalance = Number(gapSalesRes[0]?.gapBalance) || 0;
                    const gapMovements = Number(gapPaymentsRes[0]?.gapMovements) || 0;
                    initialAccumulatedForRange = baseBalance + gapBalance + gapMovements;
                  } else {
                    initialAccumulatedForRange = baseBalance;
                  }
                }
              }
            }

            //  PASO 5: Calcular acumulado y chronologicalIndex por evento (sorteo/movimiento)
            //  CRÍTICO: Inicializar con el acumulado del día anterior al rango (o saldo mes anterior si es día 1)
            //  Esto garantiza que el accumulated sea ABSOLUTO, no relativo al período consultado
            let balanceResetAt: Date | null = null;
            if (vendedorId) {
              const user = await prisma.user.findUnique({
                where: { id: vendedorId },
                select: { settings: true }
              });
              if (user?.settings && (user.settings as Record<string, any>).balanceResetAt) {
                balanceResetAt = new Date((user.settings as Record<string, any>).balanceResetAt);
              }
            }

            let eventAccumulated = initialAccumulatedForRange;
            let lastProcessedDate = '';
            const totalEvents = allEvents.length;
            let resetApplied = false;

            const dataWithAccumulated = allEvents.map((event, index) => {
              const eventDate = event.date;

              //  CRÍTICO: Si cambiamos de día dentro del rango, verificar si necesitamos
              //  ajustar el acumulado (en caso de gaps entre días sin el movimiento especial)
              if (lastProcessedDate && eventDate !== lastProcessedDate) {
                //  El acumulado ya incluye todos los eventos del día anterior,
                //  así que solo continuamos sumando (el carry-over es automático)
              }
              lastProcessedDate = eventDate;

              // Si hay balanceResetAt, y el evento ocurre en/después del reset, y no lo hemos reiniciado aún
              if (balanceResetAt && !resetApplied && balanceResetAt.getTime() >= dateRange.fromAt.getTime()) {
                const eventTime = new Date(event.scheduledAt).getTime();
                if (eventTime >= balanceResetAt.getTime()) {
                  eventAccumulated = 0;
                  resetApplied = true;
                }
              }

              //  CRÍTICO: Usar Number() para garantizar suma numérica (evitar concatenación de strings)
              eventAccumulated += Number(event.subtotal) || 0;
              return {
                ...event,
                accumulated: eventAccumulated,
                chronologicalIndex: index + 1, // 1 = más antiguo, n = más reciente
                totalChronological: totalEvents,
              };
            });

            //  C3.1 OPTIMIZACIÓN: monthlyRange ya resuelto en Fase 1

            //  C3.1 OPTIMIZACIÓN: Detectar si podemos reusar resultados del rango principal
            // Cuando date=month sin filtro de lotería, las queries mensuales son idénticas a las principales
            const isMonthRange = (params.date === 'month') && !params.fromDate && !params.toDate;
            const canReuseMonthlyMovements = isMonthRange; // movements no dependen de loteriaId
            const monthlyMovementsByDate = canReuseMonthlyMovements
              ? movementsByDate
              : await AccountPaymentRepository.findMovementsByDateRange(
                monthlyStartDate,
                monthlyEndDate,
                "vendedor",
                undefined,
                vendedorId
              );

            //  ACTUALIZADO: Agrupar todos los eventos (sorteos + movimientos) por día
            //  CRÍTICO: Usar dataWithAccumulated (no allEvents) para que tengan el accumulated calculado
            const eventsByDate = new Map<string, any[]>();

            for (const event of dataWithAccumulated) {
              const date = event.date;
              if (!eventsByDate.has(date)) {
                eventsByDate.set(date, []);
              }
              eventsByDate.get(date)!.push(event);
            }

            //  ACTUALIZADO: Ordenar eventos dentro de cada día por chronologicalIndex DESC (más reciente primero)
            for (const [date, eventsDelDia] of eventsByDate.entries()) {
              eventsDelDia.sort((a, b) => {
                const idxA = a.chronologicalIndex || 0;
                const idxB = b.chronologicalIndex || 0;
                if (idxA !== idxB) return idxB - idxA;
                const dateA = new Date(a.scheduledAt).getTime();
                const dateB = new Date(b.scheduledAt).getTime();
                if (dateA !== dateB) return dateB - dateA;
                const aIsMovement = a.sorteoId?.startsWith('mov-');
                const bIsMovement = b.sorteoId?.startsWith('mov-');
                if (aIsMovement !== bIsMovement) return aIsMovement ? 1 : -1;
                return 0;
              });
            }

            //  ACTUALIZADO: Construir respuesta agrupada por día (incluye sorteos + movimientos)
            const daysArray = Array.from(eventsByDate.entries())
              .map(([date, eventsDelDia]) => {
                // Separar sorteos y movimientos para calcular totales
                const sorteosDelDia = eventsDelDia.filter(e => !e.sorteoId?.startsWith('mov-'));
                const movimientosDelDia = eventsDelDia.filter(e => e.sorteoId?.startsWith('mov-'));

                // Calcular dayTotals (suma de todos los sorteos del día)
                const totalSales = sorteosDelDia.reduce((sum, s) => sum + (s.totalSales || 0), 0);
                const totalCommission = sorteosDelDia.reduce((sum, s) => sum + (s.totalCommission || 0), 0);
                const commissionByNumber = sorteosDelDia.reduce((sum, s) => sum + (s.commissionByNumber || 0), 0);
                const commissionByReventado = sorteosDelDia.reduce((sum, s) => sum + (s.commissionByReventado || 0), 0);
                const totalPrizes = sorteosDelDia.reduce((sum, s) => sum + (s.totalPrizes || 0), 0);
                const totalTickets = sorteosDelDia.reduce((sum, s) => sum + (s.ticketCount || 0), 0);

                // Calcular totalPaid y totalCollected desde movimientos del día
                // Excluir el movimiento especial "Saldo del mes anterior" del cálculo
                const totalPaid = movimientosDelDia
                  .filter((m: any) => m.type === "payment" && !m.sorteoId?.includes('previous-month-balance'))
                  .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);
                const totalCollected = movimientosDelDia
                  .filter((m: any) => m.type === "collection" && !m.sorteoId?.includes('previous-month-balance'))
                  .reduce((sum: number, m: any) => sum + (m.amount || 0), 0);

                // Calcular totalBalance y totalRemainingBalance
                const totalBalance = totalSales - totalPrizes - totalCommission;
                const totalRemainingBalance = totalBalance - totalCollected + totalPaid;

                // El acumulado real de cierre del día es el del evento más reciente (mayor chronologicalIndex)
                const closingEvent = eventsDelDia.length > 0
                  ? eventsDelDia.reduce((max, e) => ((e.chronologicalIndex || 0) > (max.chronologicalIndex || 0) ? e : max), eventsDelDia[0])
                  : null;
                const dynamicAccumulated = closingEvent ? closingEvent.accumulated : 0;

                const dayTotals = {
                  totalSales,
                  totalCommission,
                  commissionByNumber,
                  commissionByReventado,
                  totalPrizes,
                  totalTickets,
                  totalPaid,
                  totalCollected,
                  totalBalance,
                  totalRemainingBalance,
                  totalSubtotal: totalRemainingBalance,
                  accumulated: dynamicAccumulated, // Se inicializa con el calculado del evento de cierre
                };

                //  ACTUALIZADO: Formatear todos los eventos (sorteos + movimientos)
                const eventsFormatted = eventsDelDia.map((e) => ({
                  ...e,
                  scheduledAt: formatIsoLocal(e.scheduledAt),
                }));

                return {
                  date,
                  sorteos: params.summaryOnly ? [] : eventsFormatted, // Vacío si es solo resumen
                  dayTotals,
                };
              })
              .sort((a, b) => {
                // Ordenar días descendente (más reciente primero)
                return b.date.localeCompare(a.date);
              });

            //  CRÍTICO: Obtener accumulatedBalance desde AccountStatement para cada día
            // Esto asegura que el acumulado sea consistente independiente del período consultado
            // (el acumulado a una fecha X siempre será el mismo sin importar los filtros)

            //  FIX: Si no hay eventos pero hay saldo acumulado inicial (arrastre de días anteriores),
            //  inyectar un día vacío para "hoy" con ese acumulado visible para el vendedor.
            if (daysArray.length === 0 && vendedorId && initialAccumulatedForRange !== 0) {
              const todayDateStr = `${fromAtComponents.year}-${String(fromAtComponents.month).padStart(2, '0')}-${String(fromAtComponents.day).padStart(2, '0')}`;
              daysArray.push({
                date: todayDateStr,
                sorteos: [],
                dayTotals: {
                  totalSales: 0,
                  totalCommission: 0,
                  commissionByNumber: 0,
                  commissionByReventado: 0,
                  totalPrizes: 0,
                  totalTickets: 0,
                  totalPaid: 0,
                  totalCollected: 0,
                  totalBalance: 0,
                  totalRemainingBalance: 0,
                  totalSubtotal: 0,
                  accumulated: initialAccumulatedForRange,
                },
              });
            }

            const datesToQuery = daysArray.map(d => {
              const [year, month, day] = d.date.split('-').map(Number);
              return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
            });

            const statementsForAccumulated = await prisma.accountStatement.findMany({
              where: {
                vendedorId,
                date: { in: datesToQuery },
              },
              select: {
                date: true,
                accumulatedBalance: true,
                remainingBalance: true,
              },
            });

            // Crear mapa de fecha -> accumulatedBalance
            const accumulatedByDate = new Map<string, number>();
            for (const stmt of statementsForAccumulated) {
              const dateStr = crDateService.postgresDateToCRString(stmt.date);
              const valToUse = Number(stmt.remainingBalance) || Number(stmt.accumulatedBalance) || 0;
              accumulatedByDate.set(dateStr, valToUse);
            }

            // Asignar accumulated a cada día desde AccountStatement.
            // Para días pasados (< hoy), el valor de DB es la fuente de verdad definitiva (incluso si es 0).
            // Para hoy, si la DB tiene un valor != 0 se usa, si no, se mantiene el dynamicAccumulated.
            const todayStr = crDateService.dateUTCToCRString(new Date());
            for (const day of daysArray) {
              const fromDb = accumulatedByDate.get(day.date);
              const isPastDay = day.date < todayStr;
              if (fromDb !== undefined && (isPastDay || fromDb !== 0)) {
                day.dayTotals.accumulated = fromDb;
              }
            }

            // Ocultar días anteriores al reset únicamente para el vendedor si ignoreReset no está activo
            let finalDaysArray = daysArray;
            if (balanceResetAt && params.userRole === Role.VENDEDOR && !params.ignoreReset) {
              const resetAtDayStr = crDateService.dateUTCToCRString(balanceResetAt);
              finalDaysArray = daysArray.filter(day => day.date >= resetAtDayStr);
            }

            // Calcular totales agregados (suma de todos los días filtrados)
            const totals = {
              totalSales: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalSales, 0),
              totalCommission: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCommission, 0),
              commissionByNumber: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByNumber || 0), 0),
              commissionByReventado: finalDaysArray.reduce((sum, d) => sum + (d.dayTotals.commissionByReventado || 0), 0),
              totalPrizes: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPrizes, 0),
              totalTickets: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalTickets, 0),
              totalPaid: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalPaid, 0),
              totalCollected: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalCollected, 0),
              totalBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalBalance, 0),
              totalRemainingBalance: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
              totalSubtotal: finalDaysArray.reduce((sum, d) => sum + d.dayTotals.totalRemainingBalance, 0),
            };

            //  C3.1 OPTIMIZACIÓN: Calcular monthlyAccumulated
            // Cuando date=month sin filtro de lotería ni isActive=false, los datos son idénticos
            // al rango principal → reusar directamente y ahorrar ~4 queries + 1 findMany
            const canSkipMonthlyQueries = isMonthRange && !params.loteriaId && ticketIsActive;

            //  CRÍTICO: previousMonthBalance se necesita siempre para monthlyAccumulated
            // Cuando date=month, rangeEffectiveMonth === effectiveMonth, así que reusamos rangePreviousMonthBalance
            const monthlyStartComponents = getCRLocalComponents(monthlyStartDate);
            const effectiveMonth = `${monthlyStartComponents.year}-${String(monthlyStartComponents.month).padStart(2, '0')}`;

            let monthlyAccumulated;

            if (canSkipMonthlyQueries) {
              const previousMonthBalance = isMonthRange
                ? rangePreviousMonthBalance  // Mismo mes → reusar
                : await getPreviousMonthFinalBalance(effectiveMonth, "vendedor", undefined, vendedorId, undefined);
              const numericPreviousMonthBalance = Number(previousMonthBalance) || 0;

              const realMonthlyRemainingBalance = vendedorId
                ? await getMonthlyRemainingBalance(effectiveMonth, "vendedor", undefined, vendedorId)
                : null;

              //  C3.1: date=month sin filtros → reusar totals del rango principal (ahorra 4+ queries)
              // Calcular totalPaid y totalCollected desde movimientos (ya disponibles)
              let monthlyTotalPaid = 0;
              let monthlyTotalCollected = 0;
              for (const movements of monthlyMovementsByDate.values()) {
                monthlyTotalPaid += movements
                  .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                  .reduce((sum: number, m: any) => sum + m.amount, 0);
                monthlyTotalCollected += movements
                  .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                  .reduce((sum: number, m: any) => sum + m.amount, 0);
              }

              // Reusar comisiones por tipo desde sorteoData (ya calculados en Paso 2)
              const monthlyCommissionByNumber = sorteoData.reduce((sum: number, s: any) => sum + s.commissionByNumber, 0);
              const monthlyCommissionByReventado = sorteoData.reduce((sum: number, s: any) => sum + s.commissionByReventado, 0);

              const monthlyTotalBalance = totals.totalSales - totals.totalPrizes - totals.totalCommission;
              const monthlyTotalRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

              monthlyAccumulated = {
                totalSales: totals.totalSales,
                totalCommission: totals.totalCommission,
                commissionByNumber: monthlyCommissionByNumber,
                commissionByReventado: monthlyCommissionByReventado,
                totalPrizes: totals.totalPrizes,
                totalTickets: totals.totalTickets,
                totalPaid: monthlyTotalPaid,
                totalCollected: monthlyTotalCollected,
                totalBalance: numericPreviousMonthBalance + monthlyTotalBalance,
                totalRemainingBalance: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
                totalSubtotal: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
              };
            } else {
              // ⚡ OPTIMIZACIÓN EXTREMA: Lecturas paralelas O(1) desde ResumenCierreDiario y AccountStatement
              // Resuelve ventas, premios, comisiones y balances en un solo Promise.all (< 2 ms)
              const monthlyStartDateStr = crDateService.dateUTCToCRString(monthlyStartDate);
              const monthlyEndDateStr = crDateService.dateUTCToCRString(monthlyEndDate);

              const [previousMonthBalance, realMonthlyRemainingBalance, rcdTotals] = await Promise.all([
                isMonthRange
                  ? Promise.resolve(rangePreviousMonthBalance)
                  : getPreviousMonthFinalBalance(effectiveMonth, "vendedor", undefined, vendedorId, undefined),
                vendedorId
                  ? getMonthlyRemainingBalance(effectiveMonth, "vendedor", undefined, vendedorId)
                  : Promise.resolve(null),
                prisma.$queryRaw<Array<{
                  total_sales: number;
                  total_commission: number;
                  commission_by_number: number;
                  commission_by_reventado: number;
                  total_prizes: number;
                  total_tickets: bigint;
                }>>(Prisma.sql`
            SELECT 
              COALESCE(SUM("totalVendida"), 0) as total_sales,
              COALESCE(SUM("comisionVendedor"), 0) as total_commission,
              COALESCE(SUM(CASE WHEN tipo = 'NUMERO' THEN "comisionVendedor" ELSE 0 END), 0) as commission_by_number,
              COALESCE(SUM(CASE WHEN tipo = 'REVENTADO' THEN "comisionVendedor" ELSE 0 END), 0) as commission_by_reventado,
              COALESCE(SUM(ganado), 0) as total_prizes,
              COALESCE(SUM("ticketsCount"), 0) as total_tickets
            FROM "ResumenCierreDiario"
            WHERE "businessDate" >= ${monthlyStartDateStr}::date
              AND "businessDate" <= ${monthlyEndDateStr}::date
              ${vendedorId ? Prisma.sql`AND "vendedorId" = CAST(${vendedorId} AS uuid)` : Prisma.empty}
              ${params.loteriaId ? Prisma.sql`AND "loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
          `),
              ]);
              const numericPreviousMonthBalance = Number(previousMonthBalance) || 0;

              const monthlyTotals = rcdTotals[0] || {
                total_sales: 0,
                total_commission: 0,
                commission_by_number: 0,
                commission_by_reventado: 0,
                total_prizes: 0,
                total_tickets: BigInt(0),
              };

              const monthlyTotalSales = Number(monthlyTotals.total_sales) || 0;
              const monthlyTotalCommission = Number(monthlyTotals.total_commission) || 0;
              const monthlyCommissionByNumber = Number(monthlyTotals.commission_by_number) || 0;
              const monthlyCommissionByReventado = Number(monthlyTotals.commission_by_reventado) || 0;
              const monthlyTotalPrizes = Number(monthlyTotals.total_prizes) || 0;
              const monthlyTotalTickets = Number(monthlyTotals.total_tickets) || 0;

              let monthlyTotalPaid = 0;
              let monthlyTotalCollected = 0;
              for (const movements of monthlyMovementsByDate.values()) {
                monthlyTotalPaid += movements
                  .filter((m: any) => m.type === "payment" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                  .reduce((sum: number, m: any) => sum + m.amount, 0);
                monthlyTotalCollected += movements
                  .filter((m: any) => m.type === "collection" && !m.isReversed && !m.id?.startsWith('previous-month-balance-'))
                  .reduce((sum: number, m: any) => sum + m.amount, 0);
              }

              const monthlyTotalBalance = monthlyTotalSales - monthlyTotalPrizes - monthlyTotalCommission;
              const monthlyTotalRemainingBalance = monthlyTotalBalance - monthlyTotalCollected + monthlyTotalPaid;

              monthlyAccumulated = {
                totalSales: monthlyTotalSales,
                totalCommission: monthlyTotalCommission,
                commissionByNumber: monthlyCommissionByNumber,
                commissionByReventado: monthlyCommissionByReventado,
                totalPrizes: monthlyTotalPrizes,
                totalTickets: monthlyTotalTickets,
                totalPaid: monthlyTotalPaid,
                totalCollected: monthlyTotalCollected,
                totalBalance: numericPreviousMonthBalance + monthlyTotalBalance,
                totalRemainingBalance: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
                totalSubtotal: realMonthlyRemainingBalance !== null ? realMonthlyRemainingBalance : (numericPreviousMonthBalance + monthlyTotalRemainingBalance),
              };
            }
            const result = {
              data: finalDaysArray,
              meta: {
                totals,
                monthlyAccumulated, //  NUEVO: Acumulado del mes completo
                dateFilter: params.date || "today",
                ...(params.fromDate ? { fromDate: params.fromDate } : {}),
                ...(params.toDate ? { toDate: params.toDate } : {}),
                totalSorteos: sorteoData.length,
                totalDays: finalDaysArray.length,
              },
            };

            // Log de depuración final
            logger.info({
              layer: "service",
              action: "SORTEO_EVALUATED_SUMMARY_RESULT",
              payload: {
                vendedorId,
                totalSorteos: sorteoData.length,
                totalDays: daysArray.length,
                totalTickets: totals.totalTickets,
                message: "Resultado final del resumen evaluado",
              },
            });

            return result;
          } catch (err: any) {
            logger.error({
              layer: "service",
              action: "SORTEO_EVALUATED_SUMMARY_FAIL",
              payload: { message: err.message, params },
            });
            throw err;
          } finally {
            if (acquiredDistLock && redis) {
              await redis.del(inflightLockKey).catch(() => { });
            }
          }
        },
        // TTL L2: 24 horas (86400s) si es ayer o rango histórico pasado; 1200s (20m) si involucra hoy
        (effectiveDate === 'yesterday' || (effectiveDate === 'range' && effectiveToDate !== null && effectiveToDate < currentDayStr)) ? 86400 : 1200,
        tags,
        false, // useL1: false — resúmenes contables no ocupan slots de L1 (reservado para hot-path /tickets)
        // l1TtlMs: no aplica (useL1: false)
        undefined,
        isForceRefresh
      ),
      timeoutPromise,
    ]);
  });
} finally {
  if (timeoutHandle) clearTimeout(timeoutHandle);
}
  }
}

