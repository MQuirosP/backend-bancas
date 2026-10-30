import crypto from "crypto";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { Role, Prisma, TicketStatus, BetType } from "../../../generated/prisma/client";
import { resolveDateRange } from "../../../utils/dateRange";
import { ConcurrencyManager } from "../../../utils/concurrency";
import { CacheService } from "../../../core/cache.service";
import { UserService } from "../../user/user.service";
import { getExclusionWhereCondition } from "../../sorteo/sorteo-listas.helpers";
import { NumbersSummaryParams, NumbersSummaryFilterOptionsParams, FilterOptionsContext } from "../types/ticket.types";

const _filterOptionsInFlight = new Map<string, Promise<any>>();

export class TicketNumbersSummaryService {
  /**
   * Obtiene resumen de números dinámicamente (0-99 o 0-999) con montos por tipo (NÚMERO vs REVENTADO)
   * GET /api/v1/tickets/numbers-summary
   */
  static async numbersSummary(
    params: NumbersSummaryParams,
    role: string,
    userId: string,
  ) {
    try {
      // 1. Pre-flight checking: Validar parámetros mínimos para evitar queries inútiles
      if (
        !params.sorteoId &&
        !params.loteriaId &&
        !params.date &&
        !params.fromDate
      ) {
        throw new AppError("Parámetros insuficientes para el resumen", 400);
      }

      // 2. Caché L1 en memoria (RAM) + Redis L2 con Request Coalescing
      const cacheUserScope = params.scope === "mine" ? `user:${userId}` : "scope:all";
      const cacheKey = `ns:${crypto
        .createHash("md5")
        .update(JSON.stringify({ params, role, cacheUserScope }))
        .digest("hex")}`;

      const tags = ["ticket:numbers-summary", `user-sales:${userId}`, `user:${userId}`];
      if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);
      if (params.bancaId) tags.push(`banca:${params.bancaId}`);
      if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
      if (params.vendedorId) tags.push(`user:${params.vendedorId}`);

      return await CacheService.wrap(
        cacheKey,
        async () => {
          // 3. Consolidar Metadatos en una sola ráfaga controlada al inicio
          const [metadataResults, exclusionCondition] = await Promise.all([
            Promise.all([
              ...(params.sorteoId
                ? [
                  prisma.sorteo.findUnique({
                    where: { id: params.sorteoId },
                    select: {
                      id: true,
                      name: true,
                      status: true,
                      winningNumber: true,
                      scheduledAt: true,
                      loteria: { select: { name: true, rulesJson: true } },
                    },
                  }),
                ]
                : []),
              ...(params.loteriaId && !params.sorteoId
                ? [
                  prisma.loteria.findUnique({
                    where: { id: params.loteriaId },
                    select: { name: true, rulesJson: true },
                  }),
                ]
                : []),
              ...(params.ventanaId
                ? [
                  prisma.ventana.findUnique({
                    where: { id: params.ventanaId },
                    select: { name: true },
                  }),
                ]
                : []),
              ...(params.vendedorId
                ? [
                  prisma.user.findUnique({
                    where: { id: params.vendedorId },
                    select: { name: true, code: true },
                  }),
                ]
                : []),
              ...(params.multiplierId
                ? [
                  prisma.loteriaMultiplier.findUnique({
                    where: { id: params.multiplierId },
                    select: { name: true },
                  }),
                ]
                : []),
            ]),
            params.sorteoId
              ? getExclusionWhereCondition(params.sorteoId)
              : Promise.resolve<Prisma.TicketWhereInput>({}),
          ]);

          let idx = 0;
          const sorteo = params.sorteoId ? (metadataResults[idx++] as any) : null;
          const loteria =
            params.loteriaId && !params.sorteoId
              ? (metadataResults[idx++] as any)
              : sorteo?.loteria || null;
          const ventana = params.ventanaId ? (metadataResults[idx++] as any) : null;
          const vendedor = params.vendedorId
            ? (metadataResults[idx++] as any)
            : null;
          const multiplier = params.multiplierId
            ? (metadataResults[idx++] as any)
            : null;

          // 4. Resolver Reglas y Configuración (Fuera del pool)
          const loteriaRules = loteria?.rulesJson as any;
          const reventadoEnabled = loteriaRules?.reventadoConfig?.enabled ?? true;
          const { resolveDigits } = await import("../../../utils/loteriaRules");
          const sorteoDigits = resolveDigits(loteriaRules, 2);
          const maxNumber = Math.pow(10, sorteoDigits) - 1;

          // 5. Resolver Rango de Fechas
          const hasSorteoId = !!params.sorteoId;
          const hasExplicitDateRange = !!(params.fromDate || params.toDate);
          const dateRange =
            hasSorteoId && !hasExplicitDateRange
              ? null
              : resolveDateRange(
                params.date || "today",
                params.fromDate,
                params.toDate,
              );

          const isExcludedRequest =
            params.isExcluded === "true" || params.isExcluded === true;

          // 6. Construir Query de SQL Raw (Lean & Fast)
          const sqlWhere: Prisma.Sql[] = [];
          if (!isExcludedRequest) {
            sqlWhere.push(Prisma.sql`t."deletedAt" IS NULL`);
            sqlWhere.push(Prisma.sql`t."isActive" = true`);
          }

          if (params.sorteoStatus)
            sqlWhere.push(Prisma.sql`s.status::text = ${params.sorteoStatus}`);
          if (params.status)
            sqlWhere.push(Prisma.sql`t."status" = ${params.status}`);
          else if (!isExcludedRequest)
            sqlWhere.push(Prisma.sql`t."status" NOT IN (${TicketStatus.CANCELLED}::"TicketStatus", ${TicketStatus.EXCLUDED}::"TicketStatus")`);

          if (dateRange) {
            const fromDateStr = dateRange.fromBusinessDate
              .toISOString()
              .split("T")[0];
            const toDateStr = dateRange.toBusinessDate.toISOString().split("T")[0];
            sqlWhere.push(
              Prisma.sql`t."businessDate" BETWEEN CAST(${fromDateStr} AS DATE) AND CAST(${toDateStr} AS DATE)`,
            );
          }

          if (params.loteriaId)
            sqlWhere.push(
              Prisma.sql`t."loteriaId" = CAST(${params.loteriaId} AS uuid)`,
            );
          if (params.sorteoId)
            sqlWhere.push(
              Prisma.sql`t."sorteoId" = CAST(${params.sorteoId} AS uuid)`,
            );
          if (params.ventanaId)
            sqlWhere.push(
              Prisma.sql`t."ventanaId" = CAST(${params.ventanaId} AS uuid)`,
            );
          if (params.bancaId) {
            sqlWhere.push(
              Prisma.sql`t."ventanaId" IN (SELECT id FROM "Ventana" WHERE "bancaId" = CAST(${params.bancaId} AS uuid))`,
            );
          }

          if (params.vendedorId) {
            sqlWhere.push(
              Prisma.sql`t."vendedorId" = CAST(${params.vendedorId} AS uuid)`,
            );
          } else if (params.scope === "mine" && role === "VENDEDOR") {
            sqlWhere.push(Prisma.sql`t."vendedorId" = CAST(${userId} AS uuid)`);
          }

          // Aplicar exclusiones
          const notClause = exclusionCondition.NOT;
          if (!isExcludedRequest && notClause && typeof notClause === 'object' && !Array.isArray(notClause) && Array.isArray(notClause.OR)) {
            const exclusions = notClause.OR.map((ex: any) => {
              let cond = Prisma.sql`t."ventanaId" = CAST(${ex.ventanaId} AS uuid)`;
              if (ex.vendedorId)
                cond = Prisma.sql`${cond} AND t."vendedorId" = CAST(${ex.vendedorId} AS uuid)`;
              if (ex.multiplierId) {
                cond = Prisma.sql`${cond} AND EXISTS (
                  SELECT 1 FROM "Jugada" j_ex 
                  WHERE j_ex."ticketId" = t.id 
                  AND j_ex."multiplierId" = CAST(${ex.multiplierId} AS uuid)
                  AND j_ex."deletedAt" IS NULL
                )`;
              }
              return Prisma.sql`(${cond})`;
            });
            sqlWhere.push(Prisma.sql`NOT (${Prisma.join(exclusions, " OR ")})`);
          }

          const combinedWhere = Prisma.join(sqlWhere, " AND ");
          const multiplierFilterExact = params.multiplierId
            ? Prisma.sql`AND t.id IN (
                SELECT j2."ticketId" 
                FROM "Jugada" j2 
                WHERE j2."multiplierId" = CAST(${params.multiplierId} AS uuid)
                  AND j2.type::text = ${BetType.NUMERO}
                  ${isExcludedRequest ? Prisma.sql`AND j2."isExcluded" = true` : Prisma.sql`AND j2."isActive" = true`}
                  AND j2."deletedAt" IS NULL
              )`
            : Prisma.empty;

          // 7. Aggregation Query Principal (GROUPING SETS)
          const results = await prisma.$queryRaw<any[]>`
              SELECT 
                j.number,
                SUM(CASE WHEN j.type::text = ${BetType.NUMERO} ${params.multiplierId ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)` : Prisma.empty} THEN j.amount ELSE 0 END)::FLOAT as "amountByNumber",
                SUM(CASE WHEN j.type::text = ${BetType.REVENTADO} THEN j.amount ELSE 0 END)::FLOAT as "amountByReventado",
                COUNT(DISTINCT t.id)::INT as "ticketCount",
                COUNT(DISTINCT CASE WHEN j.type::text = ${BetType.NUMERO} THEN t.id END)::INT as "ticketsByNumber",
                COUNT(DISTINCT CASE WHEN j.type::text = ${BetType.REVENTADO} THEN t.id END)::INT as "ticketsByReventado",
                SUM(CASE WHEN j.type::text = ${BetType.NUMERO} ${params.multiplierId ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)` : Prisma.empty} 
                  THEN ${params.dimension === "listero" || (params.ventanaId && !params.vendedorId) ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} 
                  ELSE 0 END)::FLOAT as "commissionByNumber",
                SUM(CASE WHEN j.type::text = ${BetType.REVENTADO} 
                  THEN ${params.dimension === "listero" || (params.ventanaId && !params.vendedorId) ? Prisma.sql`j."listeroCommissionAmount"` : Prisma.sql`j."commissionAmount"`} 
                  ELSE 0 END)::FLOAT as "commissionByReventado"
              FROM "Ticket" t
              ${params.sorteoStatus ? Prisma.sql`INNER JOIN "Sorteo" s ON t."sorteoId" = s.id` : Prisma.empty}
              INNER JOIN "Jugada" j ON t.id = j."ticketId"
              WHERE ${combinedWhere}
                ${isExcludedRequest ? Prisma.empty : Prisma.sql`AND j."isActive" = true`}
                AND j."deletedAt" IS NULL
                ${isExcludedRequest ? Prisma.sql`AND j."isExcluded" = true` : Prisma.sql`AND j."isExcluded" = false`}
                ${multiplierFilterExact}
              GROUP BY GROUPING SETS ((j.number), ())
              ORDER BY j.number ASC NULLS LAST
          `;

          // 8. Post-Procesamiento en memoria
          const metadataInfo: any = {
            ventanaName: ventana?.name,
            vendedorName: vendedor?.name,
            vendedorCode: vendedor?.code,
            loteriaName: loteria?.name,
            sorteoDate: sorteo?.scheduledAt || null,
            sorteoName: sorteo?.name || "",
            multiplierName: multiplier?.name || "",
          };

          if (params.dimension === "listero" && !params.vendedorId) {
            delete metadataInfo.vendedorName;
            delete metadataInfo.vendedorCode;
          }

          let winningNumbersInfo: any = undefined;
          if (sorteo && sorteo.status === "EVALUATED" && sorteo.winningNumber) {
            winningNumbersInfo = {
              sorteoId: sorteo.id,
              sorteoName: sorteo.name,
              sorteoStatus: sorteo.status,
              isEvaluated: true,
              digits: sorteoDigits,
              winners: [
                {
                  number: sorteo.winningNumber.padStart(sorteoDigits, "0"),
                  position: 1,
                  prizeType: "PRIMERO",
                },
              ],
            };
          }

          const grandTotalRow = results.find(
            (row) => row.number === null || row.number === undefined
          );

          let totalTicketsCount = 0;
          let totalAmountByNumber = 0;
          let totalAmountByReventado = 0;
          let commissionByNumber = 0;
          let commissionByReventado = 0;

          if (grandTotalRow) {
            totalTicketsCount = Number(grandTotalRow.ticketCount || 0);
            totalAmountByNumber = Number(grandTotalRow.amountByNumber || 0);
            totalAmountByReventado = Number(grandTotalRow.amountByReventado || 0);
            commissionByNumber = Number(grandTotalRow.commissionByNumber || 0);
            commissionByReventado = Number(grandTotalRow.commissionByReventado || 0);
          }

          const numbersMap = new Map<string, any>();
          const numbersWithBetsSet = new Set<string>();

          for (const row of results) {
            if (row.number === null || row.number === undefined) continue;

            const numStr = row.number.padStart(sorteoDigits, "0");
            const numValue = parseInt(numStr, 10);
            if (numValue < 0 || numValue > maxNumber) continue;

            numbersMap.set(numStr, row);
            if (!grandTotalRow) {
              totalAmountByNumber += row.amountByNumber || 0;
              totalAmountByReventado += row.amountByReventado || 0;
              commissionByNumber += row.commissionByNumber || 0;
              commissionByReventado += row.commissionByReventado || 0;
            }

            if (row.amountByNumber > 0 || row.amountByReventado > 0) {
              numbersWithBetsSet.add(numStr);
            }
          }

          const pageSize = params.pageSize || 100;
          const page = params.page;
          let startNumber = 0;
          let endNumber = maxNumber;

          if (page !== undefined) {
            startNumber = page * pageSize;
            endNumber = Math.min(startNumber + pageSize - 1, maxNumber);
          }

          const data = Array.from(
            { length: endNumber - startNumber + 1 },
            (_, i) => {
              const numValue = startNumber + i;
              const numStr = String(numValue).padStart(sorteoDigits, "0");
              const row = numbersMap.get(numStr) || {
                amountByNumber: 0,
                amountByReventado: 0,
                ticketCount: 0,
                ticketsByNumber: 0,
                ticketsByReventado: 0,
              };

              return {
                number: numStr,
                amountByNumber: Number(row.amountByNumber),
                amountByReventado: Number(row.amountByReventado),
                totalAmount:
                  Number(row.amountByNumber) + Number(row.amountByReventado),
                ticketCount: Number(row.ticketCount),
                ticketsByNumber: Number(row.ticketsByNumber),
                ticketsByReventado: Number(row.ticketsByReventado),
              };
            },
          );

          const numbersWithBets = Array.from(numbersWithBetsSet).sort(
            (a, b) => parseInt(a, 10) - parseInt(b, 10),
          );

          return {
            data,
            meta: {
              dateFilter: params.date || "today",
              ...(params.fromDate ? { fromDate: params.fromDate } : {}),
              ...(params.toDate ? { toDate: params.toDate } : {}),
              totalNumbers: maxNumber + 1,
              sorteoDigits,
              maxNumber,
              reventadoEnabled,
              ...(page !== undefined
                ? {
                  pagination: {
                    page,
                    pageSize,
                    startNumber,
                    endNumber,
                    totalPages: Math.ceil((maxNumber + 1) / pageSize),
                    returnedCount: data.length,
                  },
                }
                : {}),
              totalAmountByNumber,
              totalAmountByReventado,
              totalAmount: totalAmountByNumber + totalAmountByReventado,
              totalTickets: totalTicketsCount,
              commissionByNumber,
              commissionByReventado,
              totalCommission: commissionByNumber + commissionByReventado,
              numbersWithBets,
              ...(winningNumbersInfo ? { winningNumbers: winningNumbersInfo } : {}),
              ...(params.dimension ? { dimension: params.dimension } : {}),
              ...(params.ventanaId ? { ventanaId: params.ventanaId } : {}),
              ...(params.vendedorId ? { vendedorId: params.vendedorId } : {}),
              ...metadataInfo,
            },
          };
        },
        60,
        tags,
        true,
        30_000
      );
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_NUMBERS_SUMMARY_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  }

  /**
   * Resuelve los multiplicadores a usar en el batch (por sorteo o lotería)
   */
  static async resolveMultipliersForBatch(params: {
    loteriaId?: string | null;
    sorteoId?: string | null;
    multiplierIds?: string[];
  }) {
    let loteriaId = params.loteriaId;
    if (!loteriaId && params.sorteoId) {
      const sorteo = await prisma.sorteo.findUnique({
        where: { id: params.sorteoId },
        select: { loteriaId: true },
      });
      loteriaId = sorteo?.loteriaId || null;
    }

    if (!loteriaId) {
      throw new AppError(
        "Se requiere loteriaId o sorteoId para groupBy=multiplier",
        400,
      );
    }

    const multipliers = await prisma.loteriaMultiplier.findMany({
      where: {
        loteriaId,
        ...(params.multiplierIds && params.multiplierIds.length > 0
          ? { id: { in: params.multiplierIds } }
          : {}),
      },
      select: { id: true, name: true, valueX: true },
      orderBy: { valueX: "desc" },
    });

    return multipliers;
  }

  /**
   * Batch numbers summary por multiplicador: genera PNGs
   */
  static async numbersSummaryBatch(
    params: any,
    role: string,
    userId: string,
    format: "pdf" | "png" = "png",
  ) {
    try {
      const multipliers: Array<{
        id: string;
        name: string;
        valueX: number | null;
      }> = params.multipliers || [];
      if (!multipliers.length) {
        throw new AppError("No hay multiplicadores para procesar", 400);
      }

      if (format !== "png") {
        throw new AppError("Solo se admite format='png' en batch", 400);
      }

      const { generateListImages } =
        await import("../../../api/v1/services/worker.service");

      const pages: Array<{
        page: number;
        filename: string;
        image: string;
        multiplierId: string;
        multiplierName: string;
        multiplierValue: number | null;
      }> = [];

      const CONCURRENCY_LIMIT = 2;
      const allPagesResults: any[][] = [];

      for (let i = 0; i < multipliers.length; i += CONCURRENCY_LIMIT) {
        const chunk = multipliers.slice(i, i + CONCURRENCY_LIMIT);

        const chunkPromises = chunk.map(async (multiplier) => {
          const result = await TicketNumbersSummaryService.numbersSummary(
            {
              ...params,
              multiplierId: multiplier.id,
            },
            role,
            userId,
          );

          const listPages = await generateListImages({
            meta: {
              ...result.meta,
              multiplierName: multiplier.name,
            },
            numbers: result.data,
          });

          if (!listPages || listPages.length === 0) {
            throw new AppError(
              `No se pudo generar PNG para el multiplicador ${multiplier.name}`,
              422,
            );
          }

          return listPages.map((p) => ({
            page: p.page,
            filename: `lista-${multiplier.name || multiplier.valueX || "mult"}-${p.page + 1}.png`,
            image: p.buffer.toString("base64"),
            multiplierId: multiplier.id,
            multiplierName: multiplier.name,
            multiplierValue: multiplier.valueX,
          }));
        });

        const chunkResults = await Promise.all(chunkPromises);
        allPagesResults.push(...chunkResults);
      }

      allPagesResults.forEach((multiplierPages) => {
        pages.push(...multiplierPages);
      });

      return {
        format: "png",
        pages,
        meta: { multipliers: multipliers.length, totalPages: pages.length },
      };
    } catch (err: any) {
      logger.error({
        layer: "service",
        action: "TICKET_NUMBERS_SUMMARY_BATCH_FAIL",
        payload: { message: err.message, params },
      });
      throw err;
    }
  }

  /**
   * Obtiene las opciones disponibles para los filtros de numbers-summary
   * basándose en los tickets reales del usuario según su rol
   * GET /api/v1/tickets/numbers-summary/filter-options
   */
  static async getNumbersSummaryFilterOptions(
    params: NumbersSummaryFilterOptionsParams,
    context: FilterOptionsContext,
  ) {
    const cacheKey = `banca:${context.bancaId || "all"}:ventana:${context.ventanaId || "all"}:user:${context.userId}:numbers-summary-filters:${crypto
      .createHash("md5")
      .update(JSON.stringify({ params, context }))
      .digest("hex")}`;

    const tags = [
      "ticket:numbers-summary-filter-options",
      `user:${context.userId}`,
    ];
    if (context.bancaId) tags.push(`banca:${context.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    const inFlight = _filterOptionsInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = CacheService.wrap(
      cacheKey,
      async () => {
        try {
          const { applyRbacFilters } = require("../../../utils/rbac");
          const authContext = {
            userId: context.userId,
            role: context.role,
            ventanaId: context.ventanaId,
            bancaId: context.bancaId,
          };

          const effectiveFilters = await applyRbacFilters(authContext, {
            scope: params.scope || "mine",
            vendedorId: params.vendedorId,
            ventanaId: params.ventanaId,
            loteriaId: params.loteriaId,
            sorteoId: params.sorteoId,
          });

          let dateFrom: Date | undefined;
          let dateTo: Date | undefined;

          const hasExplicitDateRange = !!(params.fromDate || params.toDate);
          const shouldSkipDateFilter =
            !!params.sorteoId && !hasExplicitDateRange;

          if (!shouldSkipDateFilter && (params.date || hasExplicitDateRange)) {
            const dateRange = resolveDateRange(
              params.date || "today",
              params.fromDate,
              params.toDate,
            );
            dateFrom = dateRange.fromBusinessDate;
            dateTo = dateRange.toBusinessDate;
          }

          // Construir JOINs condicionales
          const sqlJoins: Prisma.Sql[] = [];
          if (params.sorteoStatus) {
            sqlJoins.push(
              Prisma.sql`INNER JOIN "Sorteo" s ON t."sorteoId" = s.id`,
            );
          }
          if (effectiveFilters.bancaId) {
            sqlJoins.push(
              Prisma.sql`INNER JOIN "Ventana" v ON t."ventanaId" = v.id`,
            );
          }
          const joinsSQL =
            sqlJoins.length > 0 ? Prisma.join(sqlJoins, " ") : Prisma.empty;

          // Construir condiciones WHERE
          const sqlConditions: Prisma.Sql[] = [];
          if (params.status === "CANCELLED") {
            sqlConditions.push(
              Prisma.sql`t."status" = ${TicketStatus.CANCELLED}::"TicketStatus"`,
            );
          } else {
            sqlConditions.push(Prisma.sql`t."deletedAt" IS NULL`);
            sqlConditions.push(Prisma.sql`t."isActive" = true`);
            sqlConditions.push(
              Prisma.sql`t."status" <> ${TicketStatus.CANCELLED}::"TicketStatus"`,
            );
          }
          if (params.sorteoStatus) {
            sqlConditions.push(
              Prisma.sql`s.status::text = ${params.sorteoStatus}`,
            );
          }
          if (effectiveFilters.bancaId) {
            sqlConditions.push(
              Prisma.sql`v."bancaId" = CAST(${effectiveFilters.bancaId} AS uuid)`,
            );
          }
          if (effectiveFilters.vendedorId) {
            sqlConditions.push(
              Prisma.sql`t."vendedorId" = CAST(${effectiveFilters.vendedorId} AS uuid)`,
            );
          }
          if (effectiveFilters.ventanaId) {
            sqlConditions.push(
              Prisma.sql`t."ventanaId" = CAST(${effectiveFilters.ventanaId} AS uuid)`,
            );
          }
          if (dateFrom) {
            const fromStr = dateFrom.toISOString().split("T")[0];
            sqlConditions.push(
              Prisma.sql`t."businessDate" >= CAST(${fromStr} AS DATE)`,
            );
          }
          if (dateTo) {
            const toStr = dateTo.toISOString().split("T")[0];
            sqlConditions.push(
              Prisma.sql`t."businessDate" <= CAST(${toStr} AS DATE)`,
            );
          }
          if (params.loteriaId && params.loteriaId !== "all") {
            sqlConditions.push(
              Prisma.sql`t."loteriaId" = CAST(${params.loteriaId} AS uuid)`,
            );
          }
          if (params.sorteoId && params.sorteoId !== "all") {
            sqlConditions.push(
              Prisma.sql`t."sorteoId" = CAST(${params.sorteoId} AS uuid)`,
            );
          }
          if (params.status && params.status !== "all") {
            sqlConditions.push(Prisma.sql`t.status::text = ${params.status}`);
          }
          if (params.multiplierId && params.multiplierId !== "all") {
            sqlConditions.push(Prisma.sql`EXISTS (
          SELECT 1 FROM "Jugada" jf
          WHERE jf."ticketId" = t.id
            AND jf."multiplierId" = CAST(${params.multiplierId} AS uuid)
            AND jf."deletedAt" IS NULL
            AND jf."isActive" = true
            AND jf.type::text = ${BetType.NUMERO}
        )`);
          }
          const whereSQL = Prisma.join(sqlConditions, " AND ");

          // CTEs opcionales según rol
          const multiplierFilter =
            params.multiplierId && params.multiplierId !== "all"
              ? Prisma.sql`AND j."multiplierId" = CAST(${params.multiplierId} AS uuid)`
              : Prisma.empty;
          const vendedorCte =
            context.role === Role.ADMIN || context.role === Role.VENTANA
              ? Prisma.sql`, vendedor_counts AS (SELECT "vendedorId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "vendedorId")`
              : Prisma.empty;
          const ventanaCte =
            context.role === Role.ADMIN
              ? Prisma.sql`, ventana_counts AS (SELECT "ventanaId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "ventanaId")`
              : Prisma.empty;
          const vendedorSelect =
            context.role === Role.ADMIN || context.role === Role.VENTANA
              ? Prisma.sql`, (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM vendedor_counts) AS vendedor_groups`
              : Prisma.sql`, '[]'::json AS vendedor_groups`;
          const ventanaSelect =
            context.role === Role.ADMIN
              ? Prisma.sql`, (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM ventana_counts) AS ventana_groups`
              : Prisma.sql`, '[]'::json AS ventana_groups`;

          type RawAggGroup = { id: string; cnt: number };
          type RawAggResult = {
            total_tickets: bigint;
            loteria_groups: RawAggGroup[] | null;
            sorteo_groups: RawAggGroup[] | null;
            multiplier_groups: RawAggGroup[] | null;
            vendedor_groups: RawAggGroup[] | null;
            ventana_groups: RawAggGroup[] | null;
          };

          const [rawAgg] = await prisma.$queryRaw<RawAggResult[]>`
        WITH filtered_tickets AS (
          SELECT t.id, t."loteriaId", t."sorteoId", t."vendedorId", t."ventanaId"
          FROM "Ticket" t
          ${joinsSQL}
          WHERE ${whereSQL}
        ),
        loteria_counts AS (
          SELECT "loteriaId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "loteriaId"
        ),
        sorteo_counts AS (
          SELECT "sorteoId"::text AS id, COUNT(*)::int AS cnt FROM filtered_tickets GROUP BY "sorteoId"
        ),
        multiplier_counts AS (
          SELECT j."multiplierId"::text AS id, COUNT(DISTINCT j."ticketId")::int AS cnt
          FROM "Jugada" j
          INNER JOIN filtered_tickets ft ON j."ticketId" = ft.id
          WHERE j."deletedAt" IS NULL AND j."isActive" = true
            AND j.type::text = ${BetType.NUMERO} AND j."multiplierId" IS NOT NULL
            ${multiplierFilter}
          GROUP BY j."multiplierId"
        )
        ${vendedorCte}
        ${ventanaCte}
        SELECT
          (SELECT COUNT(*) FROM filtered_tickets)::bigint AS total_tickets,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM loteria_counts)    AS loteria_groups,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM sorteo_counts)     AS sorteo_groups,
          (SELECT COALESCE(json_agg(json_build_object('id', id, 'cnt', cnt)), '[]'::json) FROM multiplier_counts) AS multiplier_groups
          ${vendedorSelect}
          ${ventanaSelect}
      `;

          const totalTickets = Number(rawAgg.total_tickets);
          const loteriaGroups = (rawAgg.loteria_groups || []).map((g) => ({
            loteriaId: g.id,
            _count: { id: g.cnt },
          }));
          const sorteoGroups = (rawAgg.sorteo_groups || []).map((g) => ({
            sorteoId: g.id,
            _count: { id: g.cnt },
          }));
          const multiplierGroups = (rawAgg.multiplier_groups || []).map(
            (g) => ({ multiplierId: g.id, _count: { ticketId: g.cnt } }),
          );
          const vendedorGroups = (rawAgg.vendedor_groups || []).map((g) => ({
            vendedorId: g.id,
            _count: { id: g.cnt },
          }));
          const ventanaGroups = (rawAgg.ventana_groups || []).map((g) => ({
            ventanaId: g.id,
            _count: { id: g.cnt },
          }));

          const masterTasks: (() => Promise<any>)[] = [
            () =>
              prisma.loteria.findMany({
                where: {
                  id: {
                    in: loteriaGroups
                      .map((g: any) => g.loteriaId)
                      .filter(Boolean),
                  },
                },
                select: { id: true, name: true },
              }),
            () =>
              prisma.sorteo.findMany({
                where: {
                  id: {
                    in: sorteoGroups
                      .map((g: any) => g.sorteoId)
                      .filter(Boolean),
                  },
                },
                select: {
                  id: true,
                  name: true,
                  scheduledAt: true,
                  loteriaId: true,
                  loteria: { select: { name: true } },
                },
              }),
            () =>
              prisma.loteriaMultiplier.findMany({
                where: {
                  id: {
                    in: multiplierGroups
                      .map((g: any) => g.multiplierId)
                      .filter(Boolean),
                  },
                  isActive: true,
                },
                select: {
                  id: true,
                  name: true,
                  valueX: true,
                  loteriaId: true,
                  loteria: { select: { id: true, name: true } },
                },
              }),
          ];

          if (vendedorGroups.length > 0 || effectiveFilters.bancaId) {
            masterTasks.push(() =>
              prisma.user.findMany({
                where: {
                  role: Role.VENDEDOR,
                  isActive: true,
                  deletedAt: null,
                  ...(effectiveFilters.bancaId
                    ? { ventana: { bancaId: effectiveFilters.bancaId } }
                    : {
                      id: {
                        in: vendedorGroups
                          .map((g: any) => g.vendedorId)
                          .filter(Boolean),
                      },
                    }),
                },
                select: {
                  id: true,
                  name: true,
                  ventanaId: true,
                  ventana: { select: { id: true, name: true } },
                },
              }),
            );
          }

          if (ventanaGroups.length > 0 || effectiveFilters.bancaId) {
            masterTasks.push(() =>
              prisma.ventana.findMany({
                where: {
                  isActive: true,
                  deletedAt: null,
                  ...(effectiveFilters.bancaId
                    ? { bancaId: effectiveFilters.bancaId }
                    : {
                      id: {
                        in: ventanaGroups
                          .map((g: any) => g.ventanaId)
                          .filter(Boolean),
                      },
                    }),
                },
                select: { id: true, name: true, code: true },
              }),
            );
          }

          const masterResults = await ConcurrencyManager.runLimited(
            masterTasks,
            { limit: 2, label: "numbers-summary-filter-options-masters" },
          );
          const loteriasMaster = masterResults[0] as any[];
          const sorteosMaster = masterResults[1] as any[];
          const multipliers = masterResults[2] as any[];
          let masterNextIdx = 3;
          const vendedoresMaster =
            vendedorGroups.length > 0 || effectiveFilters.bancaId
              ? (masterResults[masterNextIdx++] as any[])
              : [];
          const ventanasMaster =
            ventanaGroups.length > 0 || effectiveFilters.bancaId
              ? (masterResults[masterNextIdx] as any[])
              : [];

          let allowedMultiplierIds: Set<string> | null = null;
          if (context.role === Role.VENDEDOR && multipliers.length > 0) {
            const loteriasConMultipliers = Array.from(
              new Set(multipliers.map((m: any) => m.loteriaId).filter(Boolean)),
            );
            allowedMultiplierIds = new Set<string>();

            const allowedTasks: (() => Promise<any>)[] = [];
            loteriasConMultipliers.forEach((loteriaId) => {
              allowedTasks.push(() =>
                UserService.getAllowedMultipliers(
                  context.userId,
                  loteriaId as string,
                  "NUMERO",
                ),
              );
              allowedTasks.push(() =>
                UserService.getAllowedMultipliers(
                  context.userId,
                  loteriaId as string,
                  "REVENTADO",
                ),
              );
            });

            const allowedResults = await ConcurrencyManager.runLimited(
              allowedTasks,
              { limit: 2, label: "numbers-summary-filter-options-allowed" },
            );
            allowedResults.forEach((res: any) => {
              res.data.forEach((m: any) => allowedMultiplierIds!.add(m.id));
            });
          }

          const loterias = loteriasMaster
            .map((l: any) => ({
              id: l.id,
              name: l.name,
              ticketCount:
                loteriaGroups.find((g: any) => g.loteriaId === l.id)?._count
                  .id || 0,
            }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name));

          const sorteos = sorteosMaster
            .map((s: any) => ({
              id: s.id,
              name: s.name,
              loteriaId: s.loteriaId,
              loteriaName: s.loteria?.name || "",
              scheduledAt: s.scheduledAt.toISOString(),
              ticketCount:
                sorteoGroups.find((g: any) => g.sorteoId === s.id)?._count.id ||
                0,
            }))
            .sort(
              (a: any, b: any) =>
                new Date(b.scheduledAt).getTime() -
                new Date(a.scheduledAt).getTime(),
            );

          const multipliersFiltered = multipliers
            .filter((m: any) => {
              if (context.role === Role.VENDEDOR && allowedMultiplierIds) {
                return allowedMultiplierIds.has(m.id);
              }
              return true;
            })
            .map((m: any) => ({
              id: m.id,
              name: m.name,
              valueX: m.valueX,
              loteriaId: m.loteriaId,
              loteriaName: m.loteria?.name || "",
              ticketCount:
                multiplierGroups.find((g: any) => g.multiplierId === m.id)
                  ?._count.ticketId || 0,
            }))
            .sort((a: any, b: any) => a.valueX - b.valueX);

          const vendedores = vendedoresMaster
            .map((v: any) => ({
              id: v.id,
              name: v.name,
              ventanaId: v.ventanaId,
              ventanaName: v.ventana?.name,
              ticketCount:
                vendedorGroups.find((g: any) => g.vendedorId === v.id)?._count
                  .id || 0,
            }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name));

          const ventanas = ventanasMaster
            .map((v: any) => ({
              id: v.id,
              name: v.name,
              code: v.code,
              ticketCount:
                ventanaGroups.find((g: any) => g.ventanaId === v.id)?._count
                  .id || 0,
            }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name));

          return {
            loterias,
            sorteos,
            multipliers: multipliersFiltered,
            vendedores,
            ventanas,
            meta: {
              totalTickets,
            },
          };
        } catch (err: any) {
          logger.error({
            layer: "service",
            action: "TICKET_NUMBERS_SUMMARY_FILTER_OPTIONS_FAIL",
            payload: {
              params,
              error: err.message,
            },
          });

          if (err instanceof AppError) {
            throw err;
          }

          throw new AppError(
            "Error al obtener opciones de filtros para numbers-summary",
            500,
            "INTERNAL_ERROR",
          );
        }
      },
      300,
      tags,
    );

    _filterOptionsInFlight.set(cacheKey, promise);
    promise
      .finally(() => _filterOptionsInFlight.delete(cacheKey))
      .catch(() => { });
    return promise;
  }
}
