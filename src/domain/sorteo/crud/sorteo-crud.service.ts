import { ActivityType, Prisma, Role, SorteoStatus, BetType } from "../../../generated/prisma/client";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import logger from "../../../core/logger";
import ActivityService from "../../../core/activity.service";
import SorteoRepository from "../../../repositories/sorteo.repository";
import { CacheService } from "../../../core/cache.service";
import { SocketService } from "../../../core/socket.service";
import { ConcurrencyManager } from "../../../utils/concurrency";
import { resolveDigits } from "../../../utils/loteriaRules";
import { formatDateCRWithTZ, normalizeDateCR } from "../../../utils/datetime";
import { commissionResolver } from "../../commission/CommissionResolver";
import { CommissionPolicy } from "../../commission/types/CommissionTypes";
import {
  CreateSorteoDTO,
  UpdateSorteoDTO,
  FINAL_STATES,
  serializeSorteo,
  serializeSorteos,
  formatDateOnly,
} from "../types/sorteo.types";

export class SorteoCrudService {
  /**
   * Valida si un usuario tiene acceso a un sorteo según su bancaId
   */
  static async validateSorteoOwnership(sorteoId: string, bancaId?: string, role?: Role) {
    const sorteo = await prisma.sorteo.findUnique({
      where: { id: sorteoId },
      select: {
        id: true,
        bancaId: true,
        status: true,
        name: true,
        scheduledAt: true,
        loteriaId: true,
        winningNumber: true,
        extraMultiplierId: true,
        isActive: true,
        digits: true,
        loteria: { select: { name: true } },
      },
    });

    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);

    if (role === Role.ADMIN && !bancaId) return sorteo;

    if (bancaId) {
      if (sorteo.bancaId && sorteo.bancaId !== bancaId) {
        throw new AppError("Acceso denegado: El sorteo pertenece a otra banca", 403);
      }
    }

    return sorteo;
  }

  static async create(data: CreateSorteoDTO, userId: string, bancaId?: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { id: true, isActive: true, rulesJson: true },
    });
    if (!loteria || !loteria.isActive)
      throw new AppError("Lotería no encontrada", 404);

    const loteriaRules = loteria.rulesJson as any;
    const inheritedDigits = resolveDigits(loteriaRules);
    const finalDigits = data.digits ?? inheritedDigits;

    const s = await SorteoRepository.create({
      ...data,
      digits: finalDigits,
      bancaId,
    });

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${s.id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId, action: "created", sorteoId: s.id });

    const loteriaObj = await prisma.loteria.findUnique({
      where: { id: data.loteriaId },
      select: { name: true },
    });
    const scheduledAtFormatted = formatDateCRWithTZ(
      normalizeDateCR(data.scheduledAt, "scheduledAt"),
    );

    const details: Prisma.InputJsonObject = {
      loteriaId: data.loteriaId,
      loteriaName: loteriaObj?.name || "N/A",
      scheduledAt: scheduledAtFormatted,
      digits: finalDigits,
      digitsSource: data.digits ? "explicit" : "inherited",
      description: `Sorteo creado para ${loteriaObj?.name || "N/A"} programado para el ${scheduledAtFormatted}`,
    };

    await ActivityService.log({
      userId,
      bancaId: s.bancaId,
      action: ActivityType.SORTEO_CREATE,
      targetType: "SORTEO",
      targetId: s.id,
      details,
    });

    return serializeSorteo(s);
  }

  static async update(
    id: string,
    data: UpdateSorteoDTO,
    userId: string,
    bancaId?: string,
    role?: Role,
  ) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para modificar un sorteo global", 403);
    }
    if (FINAL_STATES.has(existing.status)) {
      throw new AppError("No se puede editar un sorteo evaluado o cerrado", 409);
    }

    if (data.loteriaId && data.loteriaId !== existing.loteriaId) {
      if (existing.status !== "SCHEDULED") {
        throw new AppError("Solo se puede cambiar la lotería en estado SCHEDULED", 409);
      }
      const loteria = await prisma.loteria.findUnique({
        where: { id: data.loteriaId },
        select: { id: true, isActive: true },
      });
      if (!loteria || !loteria.isActive)
        throw new AppError("Lotería no encontrada", 404);
    }

    const s = await SorteoRepository.update(id, {
      name: data.name,
      loteriaId: data.loteriaId,
      scheduledAt: data.scheduledAt,
      digits: data.digits,
      isActive: data.isActive,
    } as UpdateSorteoDTO);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });
    SocketService.notifySorteosUpdated({ bancaId: existing.bancaId, action: "updated", sorteoId: id });

    const details: Record<string, any> = {};
    if (data.name && data.name !== existing.name) details.name = data.name;
    if (data.loteriaId && data.loteriaId !== existing.loteriaId)
      details.loteriaId = data.loteriaId;
    if (data.scheduledAt) {
      details.scheduledAt = formatDateCRWithTZ(
        normalizeDateCR(data.scheduledAt, "scheduledAt"),
      );
    }
    if (data.digits && data.digits !== existing.digits) {
      details.digits = data.digits;
    }
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      details.isActive = data.isActive;
    }

    const sFormattedAt = formatDateCRWithTZ(existing.scheduledAt);
    const lotName = existing.loteria?.name || "Lotería";
    const sorteoDesc = `${existing.name || "Sorteo"} (${lotName}) del ${sFormattedAt}`;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SORTEO_UPDATE,
      targetType: "SORTEO",
      targetId: id,
      details: {
        ...details,
        description: `Actualización de datos para ${sorteoDesc}`,
      },
    });

    return serializeSorteo(s);
  }

  static async remove(id: string, userId: string, reason?: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para eliminar un sorteo global", 403);
    }

    const s = await SorteoRepository.softDelete(id, userId, reason, false);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag("sorteos").catch(() => { });
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });

    const details: Record<string, any> = {};
    if (reason) details.reason = reason;

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.SOFT_DELETE,
      targetType: "SORTEO",
      targetId: id,
      details: details as Prisma.InputJsonObject,
    });

    return serializeSorteo(s);
  }

  static async restore(id: string, userId: string, bancaId?: string, role?: Role) {
    const existing = await this.validateSorteoOwnership(id, bancaId, role);

    if (bancaId && !existing.bancaId && role !== Role.ADMIN) {
      throw new AppError("No tiene permisos para restaurar un sorteo global", 403);
    }
    const s = await SorteoRepository.restore(id);

    const { clearSorteoCache } = require("../../../utils/sorteoCache");
    clearSorteoCache();
    CacheService.invalidateTag(`sorteo:${id}`).catch(() => { });

    await ActivityService.log({
      userId,
      bancaId: existing.bancaId,
      action: ActivityType.RESTORE,
      targetType: "SORTEO",
      targetId: id,
      details: { restored: true },
    });

    return serializeSorteo(s);
  }

  static async findById(id: string, role?: string, userId?: string, ventanaId?: string | null) {
    const sorteo = await SorteoRepository.findById(id, role, userId, ventanaId);
    if (!sorteo) throw new AppError("Sorteo no encontrado", 404);
    return serializeSorteo(sorteo);
  }

  static async getActiveMultipliers(loteriaId: string): Promise<Array<{ id: string; valueX: number }>> {
    return CacheService.wrap<Array<{ id: string; valueX: number }>>(
      `loteria:${loteriaId}:active_multipliers`,
      async () => {
        const multipliers = await prisma.loteriaMultiplier.findMany({
          where: {
            loteriaId,
            kind: BetType.NUMERO,
            isActive: true,
          },
          select: {
            id: true,
            valueX: true,
          },
        });
        return multipliers;
      },
      3600,
      [`loteria:${loteriaId}`],
      false,
    );
  }

  static async getCommissionPolicy(userId: string, ventanaId: string | null | undefined): Promise<CommissionPolicy | null> {
    const policyJson = await CacheService.wrap<any>(
      `user:comm_policy:${userId}`,
      async () => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { commissionPolicyJson: true },
        });
        return user?.commissionPolicyJson ?? null;
      },
      300,
      [`user:${userId}`],
      false,
    );

    if (!policyJson) {
      return null;
    }

    return commissionResolver.parsePolicy(policyJson, "USER");
  }

  static async shouldShowSorteo(
    sorteo: { id: string; loteriaId: string },
    activeMultipliers: Array<{ id: string; valueX: number }>,
    commissionPolicy: CommissionPolicy,
  ): Promise<boolean> {
    if (!activeMultipliers || activeMultipliers.length === 0) {
      return false;
    }

    const hasPolicyForAnyMultiplier = activeMultipliers.some((multiplier) => {
      const multiplierValue = multiplier.valueX;

      const matchingRule = commissionPolicy.rules.find((rule) => {
        if (!rule.multiplierRange) {
          return false;
        }

        const inRange =
          multiplierValue >= rule.multiplierRange.min &&
          multiplierValue <= rule.multiplierRange.max;

        if (!inRange) return false;

        if (rule.loteriaId !== null && rule.loteriaId !== sorteo.loteriaId) {
          return false;
        }

        if (rule.betType !== null && rule.betType !== BetType.NUMERO) {
          return false;
        }

        return true;
      });

      return matchingRule !== undefined;
    });

    return hasPolicyForAnyMultiplier;
  }

  static async filterSorteosByCommissionPolicy(
    sorteos: Array<{ id: string; loteriaId: string }>,
    userId: string,
    ventanaId: string,
  ): Promise<{ filteredSorteos: Array<{ id: string; loteriaId: string }>; filteredTotal: number }> {
    const commissionPolicy = await this.getCommissionPolicy(userId, ventanaId);

    if (!commissionPolicy) {
      logger.debug({
        layer: "service",
        action: "SORTEO_FILTERED_NO_POLICY",
        payload: {
          userId,
          reason: "NO_COMMISSION_POLICY",
          hiddenCount: sorteos.length,
        },
      });

      return {
        filteredSorteos: [],
        filteredTotal: 0,
      };
    }

    const filteredSorteos: Array<{ id: string; loteriaId: string }> = [];
    const loteriaIds = [...new Set(sorteos.map((s) => s.loteriaId))];
    const multipliersByLoteria = new Map<string, Array<{ id: string; valueX: number }>>();

    const multiplierTasks = loteriaIds.map((loteriaId) => async () => {
      const multipliers = await this.getActiveMultipliers(loteriaId);
      multipliersByLoteria.set(loteriaId, multipliers);
    });

    await ConcurrencyManager.runLimited(multiplierTasks, { limit: 5 });

    for (const sorteo of sorteos) {
      const multipliers = multipliersByLoteria.get(sorteo.loteriaId) || [];
      const shouldShow = await this.shouldShowSorteo(sorteo, multipliers, commissionPolicy);

      if (shouldShow) {
        filteredSorteos.push(sorteo);
      } else {
        logger.debug({
          layer: "service",
          action: "SORTEO_FILTERED_NO_SPECIFIC_RULE",
          payload: {
            sorteoId: sorteo.id,
            loteriaId: sorteo.loteriaId,
            userId,
            multipliersCount: multipliers.length,
            reason: "NO_SPECIFIC_RULE_FOR_MULTIPLIERS",
          },
        });
      }
    }

    return {
      filteredSorteos,
      filteredTotal: filteredSorteos.length,
    };
  }

  static async list(params: {
    loteriaId?: string;
    page?: number;
    pageSize?: number;
    status?: SorteoStatus;
    search?: string;
    isActive?: boolean;
    includeDeleted?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    groupBy?: "hour" | "loteria-hour";
    lastId?: string;
    lastScheduledAt?: Date;
    userId?: string;
    role?: Role;
    ventanaId?: string | null;
    bancaId?: string;
  }) {
    if (!params.groupBy) {
      const p = params.page && params.page > 0 ? params.page : 1;
      const ps = params.pageSize && params.pageSize > 0 ? params.pageSize : 10;
      const isVendedor = params.role === Role.VENDEDOR;

      const cacheKey = `sorteos:list:v3:${params.loteriaId || "all"}:${params.status || "all"}:${params.role || "all"}:${params.bancaId || "all"}:${params.ventanaId || "all"}:${params.userId || "all"}:${p}:${ps}:${params.search || ""}:${params.isActive ?? "all"}:${params.includeDeleted ? "incDel" : "noDel"}:${params.dateFrom?.getTime() || ""}:${params.dateTo?.getTime() || ""}`;

      const tags = ["sorteos"];
      if (params.userId) tags.push(`user:${params.userId}`);
      if (params.ventanaId) tags.push(`ventana:${params.ventanaId}`);
      if (params.bancaId) tags.push(`banca:${params.bancaId}`);

      return CacheService.wrap(
        cacheKey,
        async () => {
          const { data, total } = await SorteoRepository.list({
            page: p,
            pageSize: ps,
            loteriaId: params.loteriaId,
            status: params.status,
            search: params.search?.trim() || undefined,
            isActive: params.isActive,
            includeDeleted: params.includeDeleted,
            dateFrom: params.dateFrom,
            dateTo: params.dateTo,
            lastId: params.lastId,
            lastScheduledAt: params.lastScheduledAt,
            role: params.role,
            userId: params.userId,
            ventanaId: params.ventanaId,
            bancaId: params.bancaId,
          });

          let filteredData = data;
          let filteredTotal = total;

          if (isVendedor && params.userId && params.ventanaId) {
            const filterResult = await this.filterSorteosByCommissionPolicy(
              data.map((s) => ({ id: s.id, loteriaId: s.loteriaId })),
              params.userId,
              params.ventanaId,
            );

            const filteredIds = new Set(filterResult.filteredSorteos.map((s) => s.id));
            filteredData = data.filter((s) => filteredIds.has(s.id));
            filteredTotal = filterResult.filteredTotal;

            logger.info({
              layer: "service",
              action: "SORTEO_LIST_FILTERED_BY_COMMISSION_POLICY",
              payload: {
                userId: params.userId,
                role: params.role,
                originalCount: data.length,
                filteredCount: filteredData.length,
                hiddenCount: data.length - filteredData.length,
              },
            });
          }

          const serialized = serializeSorteos(filteredData);
          const totalPages = Math.ceil(filteredTotal / ps);
          return {
            data: serialized,
            meta: {
              total: filteredTotal,
              page: p,
              pageSize: ps,
              totalPages,
              hasNextPage: p < totalPages,
              hasPrevPage: p > 1,
              grouped: false,
              groupBy: null,
            },
          };
        },
        60,
        tags,
        true,
        8_000,
      );
    }

    if (params.groupBy === "loteria-hour") {
      return this.groupedByLoteriaHour(params);
    }

    if (params.groupBy === "hour") {
      return this.groupedByHour(params);
    }

    throw new AppError(`Unsupported groupBy: ${params.groupBy}`, 400);
  }

  static async groupedByLoteriaHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    bancaId?: string;
  }) {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}::uuid`);
    }
    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}::text`);
    }
    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive}`);
    }
    if (params.dateFrom) {
      whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'`);
    }
    if (params.dateTo) {
      whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'`);
    }
    if (!params.bancaId) {
      whereConditions.push(Prisma.sql`s."bancaId" IS NULL`);
    } else {
      whereConditions.push(Prisma.sql`s."bancaId" = CAST(${params.bancaId} AS uuid)`);
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

    const query = Prisma.sql`
      WITH grouped_sorteos AS (
        SELECT
          s."loteriaId",
          l.name as "loteriaName",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ) as "hour24",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          ) as "hour12",
          COUNT(*)::int as count,
          MAX(s."scheduledAt") as "mostRecentDate",
          STRING_AGG(s.id::text, ',') as "sorteoIds"
        FROM "Sorteo" s
        INNER JOIN "Loteria" l ON l.id = s."loteriaId"
        ${whereClause}
        GROUP BY 
          s."loteriaId",
          l.name,
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ),
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          )
      )
      SELECT
        gs."loteriaId",
        gs."loteriaName",
        gs."hour24",
        gs."hour12",
        gs.count,
        gs."mostRecentDate",
        gs."sorteoIds",
        (
          SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."loteriaId" = gs."loteriaId"
            AND s2."deletedAt" IS NULL
            AND TO_CHAR(
                s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
                'HH24:MI'
              ) = gs."hour24"
            ${params.dateFrom ? Prisma.sql`AND s2."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'` : Prisma.empty}
            ${params.dateTo ? Prisma.sql`AND s2."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'` : Prisma.empty}
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY
        gs."loteriaName" ASC,
        gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      loteriaId: string;
      loteriaName: string;
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    const dataTasks = results.map((row) => async () => {
      const sorteoIdsArray = row.sorteoIds.split(",");
      const sorteosWithDates = await prisma.sorteo.findMany({
        where: {
          id: { in: sorteoIdsArray },
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          ...(params.bancaId ? { bancaId: params.bancaId } : { bancaId: null }),
        },
        select: {
          id: true,
          scheduledAt: true,
        },
        orderBy: {
          scheduledAt: "desc",
        },
      });
      const sortedIds = sorteosWithDates.map((s) => s.id);

      return {
        loteriaId: row.loteriaId,
        loteriaName: row.loteriaName,
        hour: row.hour12.trim(),
        hour24: row.hour24,
        sorteoIds: sortedIds,
        count: row.count,
        mostRecentSorteoId: row.mostRecentSorteoId,
        mostRecentDate: formatDateOnly(row.mostRecentDate),
      };
    });

    const data = await ConcurrencyManager.runLimited(dataTasks, { limit: 5 });

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "loteria-hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  }

  static async groupedByHour(params: {
    loteriaId?: string;
    status?: SorteoStatus;
    isActive?: boolean;
    dateFrom?: Date;
    dateTo?: Date;
    bancaId?: string;
  }) {
    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`s."deletedAt" IS NULL`,
    ];

    if (params.loteriaId) {
      whereConditions.push(Prisma.sql`s."loteriaId" = ${params.loteriaId}::uuid`);
    }
    if (params.status) {
      whereConditions.push(Prisma.sql`s."status" = ${params.status}::text`);
    }
    if (params.isActive !== undefined) {
      whereConditions.push(Prisma.sql`s."isActive" = ${params.isActive}`);
    }
    if (params.dateFrom) {
      whereConditions.push(Prisma.sql`s."scheduledAt" >= ${params.dateFrom} AT TIME ZONE 'UTC'`);
    }
    if (params.dateTo) {
      whereConditions.push(Prisma.sql`s."scheduledAt" <= ${params.dateTo} AT TIME ZONE 'UTC'`);
    }
    if (!params.bancaId) {
      whereConditions.push(Prisma.sql`s."bancaId" IS NULL`);
    } else {
      whereConditions.push(Prisma.sql`s."bancaId" = CAST(${params.bancaId} AS uuid)`);
    }

    const whereClause = whereConditions.length
      ? Prisma.sql`WHERE ${Prisma.join(whereConditions, " AND ")}`
      : Prisma.empty;

    const query = Prisma.sql`
      WITH grouped_sorteos AS (
        SELECT
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ) as "hour24",
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          ) as "hour12",
          COUNT(*)::int as count,
          MAX(s."scheduledAt") as "mostRecentDate",
          STRING_AGG(s.id::text, ',') as "sorteoIds"
        FROM "Sorteo" s
        INNER JOIN "Loteria" l ON l.id = s."loteriaId"
        ${whereClause}
        GROUP BY 
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH24:MI'
          ),
          TO_CHAR(
            s."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
            'HH12:MI AM'
          )
      )
      SELECT
        gs."hour24",
        gs."hour12",
        gs.count,
        gs."mostRecentDate",
        gs."sorteoIds",
        (
          SELECT s2.id 
          FROM "Sorteo" s2 
          WHERE s2."deletedAt" IS NULL
            AND TO_CHAR(
                s2."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica',
                'HH24:MI'
              ) = gs."hour24"
            ${params.loteriaId ? Prisma.sql`AND s2."loteriaId" = CAST(${params.loteriaId} AS uuid)` : Prisma.empty}
            ${params.dateFrom ? Prisma.sql`AND s2."scheduledAt" >= ${params.dateFrom}` : Prisma.empty}
            ${params.dateTo ? Prisma.sql`AND s2."scheduledAt" <= ${params.dateTo}` : Prisma.empty}
          ORDER BY s2."scheduledAt" DESC
          LIMIT 1
        ) as "mostRecentSorteoId"
      FROM grouped_sorteos gs
      ORDER BY
        gs."hour24" ASC
    `;

    const results = await prisma.$queryRaw<Array<{
      hour24: string;
      hour12: string;
      count: number;
      mostRecentDate: Date;
      sorteoIds: string;
      mostRecentSorteoId: string;
    }>>(query);

    const dataTasks = results.map((row) => async () => {
      const sorteoIdsArray = row.sorteoIds.split(",");
      const sorteosWithDates = await prisma.sorteo.findMany({
        where: {
          id: { in: sorteoIdsArray },
          ...(params.loteriaId ? { loteriaId: params.loteriaId } : {}),
          ...(params.bancaId ? { bancaId: params.bancaId } : { bancaId: null }),
        },
        select: {
          id: true,
          scheduledAt: true,
        },
        orderBy: {
          scheduledAt: "desc",
        },
      });
      const sortedIds = sorteosWithDates.map((s) => s.id);

      return {
        hour: row.hour12.trim(),
        hour24: row.hour24,
        sorteoIds: sortedIds,
        count: row.count,
        mostRecentSorteoId: row.mostRecentSorteoId,
        mostRecentDate: formatDateOnly(row.mostRecentDate),
      };
    });

    const data = await ConcurrencyManager.runLimited(dataTasks, { limit: 5 });

    return {
      data,
      meta: {
        total: data.length,
        grouped: true,
        groupBy: "hour",
        ...(params.dateFrom ? { fromDate: formatDateOnly(params.dateFrom) } : {}),
        ...(params.dateTo ? { toDate: formatDateOnly(params.dateTo) } : {}),
      },
    };
  }
}
