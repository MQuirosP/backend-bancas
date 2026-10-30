import crypto from "crypto";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import { Role, Prisma } from "../../../generated/prisma/client";
import { resolveDateRange } from "../../../utils/dateRange";
import { ConcurrencyManager } from "../../../utils/concurrency";
import { CacheService } from "../../../core/cache.service";
import { UserService } from "../../user/user.service";
import { buildTicketFilterClause } from "../helpers/ticket-filter.helper";
import { FilterOptionsParams, FilterOptionsContext } from "../types/ticket.types";

const _filterOptionsInFlight = new Map<string, Promise<any>>();

export class TicketWinnerQueryService {
  /**
   * Obtiene las jugadas de un ticket existente mediante su número de ticket
   * GET /api/v1/tickets/by-number/:ticketNumber
   * Endpoint público/inter-vendedor (no filtra por vendedor)
   */
  static async getByTicketNumber(ticketNumber: string) {
    try {
      // Buscar el ticket por número (sin filtrar por vendedor)
      const ticket = await prisma.ticket.findUnique({
        where: {
          ticketNumber,
          deletedAt: null,
        },
        select: {
          id: true,
          ticketNumber: true,
          sorteoId: true,
          loteriaId: true,
          createdAt: true,
          clienteNombre: true,
          jugadas: {
            where: {
              deletedAt: null,
            },
            select: {
              id: true,
              type: true,
              number: true,
              reventadoNumber: true,
              amount: true,
              multiplierId: true,
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });

      if (!ticket) {
        throw new AppError(
          `No se encontró un ticket con el número ${ticketNumber}`,
          404,
          "TICKET_NOT_FOUND",
        );
      }

      // Separar jugadas NUMERO y REVENTADO para poder hacer el matching
      const jugadasNumero = ticket.jugadas.filter((j) => j.type === "NUMERO");
      const jugadasReventado = ticket.jugadas.filter(
        (j) => j.type === "REVENTADO",
      );

      // Consolidar defensivamente montos de jugadas NUMERO por número
      const numeroDataMap = new Map<
        string,
        { amount: number; multiplierId: string | null }
      >();
      jugadasNumero.forEach((j) => {
        const prev = numeroDataMap.get(j.number);
        if (prev) {
          prev.amount += j.amount;
          if (!prev.multiplierId && j.multiplierId) prev.multiplierId = j.multiplierId;
        } else {
          numeroDataMap.set(j.number, {
            amount: j.amount,
            multiplierId: j.multiplierId,
          });
        }
      });

      // Consolidar defensivamente montos de jugadas REVENTADO por número (evita duplicidad histórica)
      const reventadoDataMap = new Map<
        string,
        { amountReventado: number; reventadoNumber: string }
      >();
      jugadasReventado.forEach((j) => {
        const key = j.number;
        const prev = reventadoDataMap.get(key);
        if (prev) {
          prev.amountReventado += j.amount;
        } else {
          reventadoDataMap.set(key, {
            amountReventado: j.amount,
            reventadoNumber: j.reventadoNumber || j.number,
          });
        }
      });

      // Formatear jugadas para el frontend
      // Agrupar: si hay NUMERO + REVENTADO del mismo número, devolver solo REVENTADO con ambos montos
      const jugadas: any[] = [];

      // Procesar jugadas NUMERO que NO tienen REVENTADO asociado
      jugadasNumero.forEach((jugada) => {
        if (!reventadoDataMap.has(jugada.number)) {
          if (numeroDataMap.has(jugada.number)) {
            const numData = numeroDataMap.get(jugada.number)!;
            const baseJugada: any = {
              type: "NUMERO",
              number: jugada.number,
              amount: numData.amount,
            };

            if (numData.multiplierId) {
              baseJugada.multiplierId = numData.multiplierId;
            }

            jugadas.push(baseJugada);
            numeroDataMap.delete(jugada.number); // Evitar duplicar si venían varias filas de NUMERO
          }
        }
      });

      // Procesar jugadas REVENTADO (1 sola jugada unificada por número con su respectivo amount de NUMERO)
      for (const [number, revData] of reventadoDataMap.entries()) {
        const baseJugada: any = {
          type: "REVENTADO",
          number,
          reventadoNumber: revData.reventadoNumber,
          amountReventado: revData.amountReventado,
        };

        const numeroData = numeroDataMap.get(number);
        if (numeroData !== undefined) {
          baseJugada.amount = numeroData.amount;

          if (numeroData.multiplierId) {
            baseJugada.multiplierId = numeroData.multiplierId;
          }
        } else {
          baseJugada.amount = revData.amountReventado;
        }

        jugadas.push(baseJugada);
      }

      return {
        ticketNumber: ticket.ticketNumber,
        jugadas,
        sorteoId: ticket.sorteoId,
        loteriaId: ticket.loteriaId,
        clienteNombre: ticket.clienteNombre,
        createdAt: ticket.createdAt.toISOString(),
      };
    } catch (err: any) {
      if (err instanceof AppError) {
        throw err;
      }

      logger.error({
        layer: "service",
        action: "TICKET_GET_BY_NUMBER_FAIL",
        payload: { message: err.message, ticketNumber },
      });

      throw new AppError("Error al obtener el ticket", 500, "INTERNAL_ERROR");
    }
  }

  /**
   * Obtiene las opciones disponibles para los filtros de tickets
   * basándose en los tickets reales del usuario según su rol
   * GET /api/v1/tickets/filter-options
   */
  static async getFilterOptions(
    params: FilterOptionsParams,
    context: FilterOptionsContext,
  ) {
    const cacheKey = `banca:${context.bancaId || "all"}:ventana:${context.ventanaId || "all"}:user:${context.userId}:filters:${crypto
      .createHash("md5")
      .update(JSON.stringify({ params, context }))
      .digest("hex")}`;

    const tags = ["ticket:filter-options", `user:${context.userId}`];
    if (context.bancaId) tags.push(`banca:${context.bancaId}`);
    if (params.sorteoId) tags.push(`sorteo:${params.sorteoId}`);

    // Deduplicación en vuelo (Request Coalescing)
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
          });

          let dateFrom: Date | undefined;
          let dateTo: Date | undefined;

          const hasSorteoId = !!params.sorteoId;
          const hasExplicitDateRange = !!(params.fromDate || params.toDate);

          if (!hasSorteoId || hasExplicitDateRange) {
            const dateRange = resolveDateRange(
              params.date || "today",
              params.fromDate,
              params.toDate,
            );
            dateFrom = dateRange.fromBusinessDate;
            dateTo = dateRange.toBusinessDate;
          }

          const isNumbersSummary = false;
          const filterClause = buildTicketFilterClause(
            params,
            effectiveFilters,
            dateFrom,
            dateTo,
            isNumbersSummary,
          );
          const jugadaBancaFilter = effectiveFilters.bancaId
            ? Prisma.sql`AND j."bancaId" = CAST(${effectiveFilters.bancaId} AS uuid)`
            : Prisma.empty;

          let groupingSetsSQL = Prisma.sql`GROUP BY GROUPING SETS (("loteriaId"), ("sorteoId"), ("vendedorId"), ("ventanaId"), ())`;

          type RawGroupRow = {
            loteriaId: string | null;
            sorteoId: string | null;
            vendedorId: string | null;
            ventanaId: string | null;
            cnt: number;
          };

          type RawMultiplierRow = { multiplierId: string; cnt: number };

          const [rows, multiplierRows] = await Promise.all([
            prisma.$queryRaw<RawGroupRow[]>`
              SELECT
                "loteriaId",
                "sorteoId",
                "vendedorId",
                "ventanaId",
                COUNT(*)::int AS cnt
              FROM "Ticket" t
              ${filterClause}
              ${groupingSetsSQL}
            `,
            prisma.$queryRaw<RawMultiplierRow[]>`
              SELECT j."multiplierId", COUNT(*)::int AS cnt
              FROM "Jugada" j
              INNER JOIN "Ticket" t ON t.id = j."ticketId"
              ${filterClause}
                ${jugadaBancaFilter}
                AND j."deletedAt" IS NULL
                AND j."isActive" = true
                AND j.type = CAST(${"NUMERO"} AS "BetType")
                AND j."multiplierId" IS NOT NULL
              GROUP BY j."multiplierId"
            `,
          ]);

          let totalTickets = 0;
          const loteriaGroups: { loteriaId: string; _count: { id: number } }[] = [];
          const sorteoGroups: { sorteoId: string; _count: { id: number } }[] = [];
          const vendedorGroups: { vendedorId: string; _count: { id: number } }[] = [];
          const ventanaGroups: { ventanaId: string; _count: { id: number } }[] = [];

          for (const row of rows) {
            if (
              row.loteriaId === null &&
              row.sorteoId === null &&
              row.vendedorId === null &&
              row.ventanaId === null
            ) {
              totalTickets = row.cnt;
              continue;
            }
            if (row.loteriaId !== null)
              loteriaGroups.push({
                loteriaId: row.loteriaId,
                _count: { id: row.cnt },
              });
            if (row.sorteoId !== null)
              sorteoGroups.push({
                sorteoId: row.sorteoId,
                _count: { id: row.cnt },
              });
            if (row.vendedorId !== null)
              vendedorGroups.push({
                vendedorId: row.vendedorId,
                _count: { id: row.cnt },
              });
            if (row.ventanaId !== null)
              ventanaGroups.push({
                ventanaId: row.ventanaId,
                _count: { id: row.cnt },
              });
          }

          const multiplierGroups = multiplierRows.map((g) => ({
            multiplierId: g.multiplierId,
            _count: { ticketId: g.cnt },
          }));

          // Fase 2: Obtener información de las entidades maestras en paralelo
          const masterTasks: (() => Promise<any>)[] = [
            () =>
              prisma.loteria.findMany({
                where: {
                  id: {
                    in: loteriaGroups
                      .map((g) => g.loteriaId)
                      .filter((id) => !!id),
                  },
                },
                select: { id: true, name: true },
              }),
            () =>
              prisma.sorteo.findMany({
                where: {
                  id: {
                    in: sorteoGroups
                      .map((g) => g.sorteoId)
                      .filter((id) => !!id),
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
                      .map((g) => g.multiplierId)
                      .filter((id) => !!id),
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

          if (vendedorGroups.length > 0) {
            masterTasks.push(() =>
              prisma.user.findMany({
                where: {
                  id: {
                    in: vendedorGroups
                      .map((g) => g.vendedorId)
                      .filter((id) => !!id),
                  },
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

          if (ventanaGroups.length > 0) {
            masterTasks.push(() =>
              prisma.ventana.findMany({
                where: {
                  id: {
                    in: ventanaGroups
                      .map((g) => g.ventanaId)
                      .filter((id) => !!id),
                  },
                },
                select: { id: true, name: true, code: true },
              }),
            );
          }

          const masterResults = await ConcurrencyManager.runLimited(
            masterTasks,
            { limit: 2, label: "ticket-filter-options-masters" },
          );
          const loteriasMaster = masterResults[0] as any[];
          const sorteosMaster = masterResults[1] as any[];
          const multipliers = masterResults[2] as any[];
          let masterNextIdx = 3;
          const vendedoresMaster =
            vendedorGroups.length > 0
              ? (masterResults[masterNextIdx++] as any[])
              : [];
          const ventanasMaster =
            ventanaGroups.length > 0
              ? (masterResults[masterNextIdx] as any[])
              : [];

          // Fase 3: Para vendedores, filtrar multiplicadores según política de comisión
          let allowedMultiplierIds: Set<string> | null = null;
          if (context.role === Role.VENDEDOR && multipliers.length > 0) {
            const loteriasConMultipliers = Array.from(
              new Set(multipliers.map((m) => m.loteriaId).filter((id) => !!id)),
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
              { limit: 2, label: "ticket-filter-options-allowed" },
            );
            allowedResults.forEach((res) => {
              res.data.forEach((m: any) => allowedMultiplierIds!.add(m.id));
            });
          }

          // Fase 4: Construir respuesta mapeando los counts de las agrupaciones
          const loterias = loteriasMaster
            .map((l) => ({
              id: l.id,
              name: l.name,
              ticketCount:
                loteriaGroups.find((g) => g.loteriaId === l.id)?._count.id || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

          const sorteos = sorteosMaster
            .map((s) => ({
              id: s.id,
              name: s.name,
              loteriaId: s.loteriaId,
              loteriaName: s.loteria?.name || "",
              scheduledAt: s.scheduledAt.toISOString(),
              ticketCount:
                sorteoGroups.find((g) => g.sorteoId === s.id)?._count.id || 0,
            }))
            .sort(
              (a, b) =>
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
                multiplierGroups.find((g) => g.multiplierId === m.id)?._count
                  .ticketId || 0,
            }))
            .sort((a, b) => a.valueX - b.valueX);

          const vendedores = vendedoresMaster
            .map((v) => ({
              id: v.id,
              name: v.name,
              ventanaId: v.ventanaId,
              ventanaName: v.ventana?.name,
              ticketCount:
                vendedorGroups.find((g) => g.vendedorId === v.id)?._count.id || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

          const ventanas = ventanasMaster
            .map((v) => ({
              id: v.id,
              name: v.name,
              code: v.code,
              ticketCount:
                ventanaGroups.find((g) => g.ventanaId === v.id)?._count.id || 0,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

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
            action: "TICKET_FILTER_OPTIONS_FAIL",
            payload: {
              params,
              error: err.message,
            },
          });

          if (err instanceof AppError) {
            throw err;
          }

          throw new AppError(
            "Error al obtener opciones de filtros",
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
