import { is } from 'zod/locales';
import prisma from "../../../core/prismaClient";
import { ActivityType, Prisma } from "@prisma/client";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { paginateOffset } from "../../../utils/pagination";
import { computeOccurrences } from '../../../utils/schedule';
import SorteoRepository from '../../../repositories/sorteo.repository';

export const LoteriaService = {
  async create(
    data: { name: string; rulesJson?: Record<string, any>, isActive?: boolean },
    userId: string,
    requestId?: string
  ) {
    try {
      const loteria = await prisma.loteria.create({
        data: {
          name: data.name,
          rulesJson: data.rulesJson ?? {},
          isActive: data.isActive ?? true,
        },
      });

      logger.info({
        layer: "service",
        action: "LOTERIA_CREATE",
        userId,
        requestId,
        payload: { id: loteria.id, name: loteria.name },
      });

      await ActivityService.log({
        userId,
        action: ActivityType.LOTERIA_CREATE,
        targetType: "LOTERIA",
        targetId: loteria.id,
        details: { name: loteria.name },
        requestId,
        layer: "service",
      });

      return loteria;
    } catch (err) {
      logger.error({
        layer: "service",
        action: "LOTERIA_CREATE_ERROR",
        userId,
        requestId,
        meta: { message: (err as Error).message },
      });
      throw new AppError("Failed to create Lotería", 500);
    }
  },

  async getById(id: string) {
    const loteria = await prisma.loteria.findUnique({
      where: { id },
    });

    if (!loteria) {
      throw new AppError("Lotería not found", 404);
    }

    return loteria;
  },

  async list({
    page = 1,
    pageSize = 10,
    isDeleted,
    search,
  }: {
    page?: number;
    pageSize?: number;
    isDeleted?: boolean;
    search?: string;
  }) {
    const where: Prisma.LoteriaWhereInput = {};

    if (typeof isDeleted === "boolean") {
      where.isDeleted = isDeleted;
    }

    const s = typeof search === "string" ? search.trim() : "";
    if (s.length > 0) {
      // Normaliza AND a arreglo aunque Prisma permita objeto o arreglo
      const existingAnd = where.AND
        ? Array.isArray(where.AND)
          ? where.AND
          : [where.AND]
        : [];

      where.AND = [
        ...existingAnd,
        { name: { contains: s, mode: "insensitive" } },
      ];
    }

    const result = await paginateOffset(prisma.loteria, {
      where,
      select: {
        id: true,
        name: true,
        rulesJson: true,
        isDeleted: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
      pagination: { page, pageSize },
    });

    return result;
  },

  async update(
    id: string,
    data: Partial<{ name: string; rulesJson: Record<string, any>, isActive: boolean }>,
    userId: string,
    requestId?: string
  ) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError("Lotería not found", 404);

    const updated = await prisma.loteria.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        rulesJson:
          (data.rulesJson as Prisma.InputJsonValue) ?? existing.rulesJson,
        isActive: data.isActive ?? existing.isActive,
      },
    });

    logger.info({
      layer: "service",
      action: "LOTERIA_UPDATE",
      userId,
      requestId,
      payload: { id, changes: Object.keys(data) },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_UPDATE,
      targetType: "LOTERIA",
      targetId: id,
      details: data,
      requestId,
      layer: "service",
    });

    return updated;
  },

  async softDelete(id: string, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError("Lotería not found", 404);

    const deleted = await prisma.loteria.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        deletedReason: "Deleted by admin",
      },
    });

    logger.warn({
      layer: "service",
      action: "LOTERIA_DELETE",
      userId,
      requestId,
      payload: { id },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_DELETE,
      targetType: "LOTERIA",
      targetId: id,
      details: { reason: "Deleted by admin" },
      requestId,
      layer: "service",
    });

    return deleted;
  },

  async restore(id: string, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError("Lotería not found", 404);

    const restored = await prisma.loteria.update({
      where: { id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      },
    });

    logger.info({
      layer: "service",
      action: "LOTERIA_RESTORE",
      userId,
      requestId,
      payload: { id },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_RESTORE,
      targetType: "LOTERIA",
      targetId: id,
      details: null,
      requestId,
      layer: "service",
    });

    return restored;
  },

  async seedSorteosFromRules(loteriaId: string, start: Date, days: number, dryRun = false) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: loteriaId },
      select: { name: true, rulesJson: true, isActive: true },
    })
    if (!loteria) throw new Error("Lotería no encontrada")
    if (!loteria.isActive) throw new Error("Lotería inactiva")

    const rules = (loteria.rulesJson ?? {}) as any
    if (rules?.autoCreateSorteos === false) {
      // Si quieres, permite override via query param; por ahora respetamos bandera.
      return { created: 0, skipped: 0, note: "autoCreateSorteos=false" }
    }

    const schedule = rules?.drawSchedule ?? {}
    const occurrences = computeOccurrences({
      loteriaName: loteria.name,
      schedule: {
        frequency: schedule.frequency,
        times: schedule.times,
        daysOfWeek: schedule.daysOfWeek,
      },
      start,
      days,
      limit: 1000,
    })

    if (dryRun) {
      return { created: 0, skipped: 0, preview: occurrences.map(o => ({ name: o.name, scheduledAt: o.scheduledAt.toISOString() })) }
    }

    const result = await SorteoRepository.bulkCreateIfMissing(loteriaId, occurrences)
    return result
  },
};

export default LoteriaService;
