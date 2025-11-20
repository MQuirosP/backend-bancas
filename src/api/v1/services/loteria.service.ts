import prisma from "../../../core/prismaClient";
import { ActivityType, Prisma } from "@prisma/client";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { AppError } from "../../../core/errors";
import { paginateOffset } from "../../../utils/pagination";
import { computeOccurrences } from '../../../utils/schedule';
import { formatIsoLocal } from '../../../utils/datetime';
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
    isActive,
    search,
  }: {
    page?: number;
    pageSize?: number;
    isActive?: boolean;
    search?: string;
  }) {
    const where: Prisma.LoteriaWhereInput = {};

    if (typeof isActive === "boolean") {
      where.isActive = isActive;
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
        isActive: true,
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

    // Detectar cambio en isActive para activar cascada
    const isActiveChanged = data.isActive !== undefined && data.isActive !== existing.isActive;
    const isBeingInactivated = isActiveChanged && data.isActive === false;
    const isBeingRestored = isActiveChanged && data.isActive === true;

    // Si hay cambio en isActive, usar transacción para cascada
    if (isActiveChanged) {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Actualizar la lotería
        const updated = await tx.loteria.update({
          where: { id },
          data: {
            name: data.name ?? existing.name,
            rulesJson:
              (data.rulesJson as Prisma.InputJsonValue) ?? existing.rulesJson,
            isActive: data.isActive ?? existing.isActive,
          },
        });

        // 2. Aplicar cascada según el cambio (solo cambiar isActive, sin soft delete)
        let cascadeResult = { count: 0, sorteosIds: [] as string[] };
        if (isBeingInactivated) {
          // Inactivar sorteos asociados (solo isActive=false)
          cascadeResult = await SorteoRepository.setInactiveSorteosByLoteria(id, tx);
        } else if (isBeingRestored) {
          // Restaurar sorteos que fueron inactivados por cascada (solo isActive=true)
          cascadeResult = await SorteoRepository.setActiveSorteosByLoteria(id, tx);
        }

        return { updated, cascadeResult };
      });

      logger.info({
        layer: "service",
        action: "LOTERIA_UPDATE_WITH_CASCADE",
        userId,
        requestId,
        payload: {
          id,
          changes: Object.keys(data),
          isActiveChanged,
          isBeingInactivated,
          isBeingRestored,
          sorteosAffected: result.cascadeResult.count,
          sorteosIds: result.cascadeResult.sorteosIds,
        },
      });

      await ActivityService.log({
        userId,
        action: ActivityType.LOTERIA_UPDATE,
        targetType: "LOTERIA",
        targetId: id,
        details: {
          ...data,
          sorteosAffected: result.cascadeResult.count,
          sorteosIds: result.cascadeResult.sorteosIds,
        },
        requestId,
        layer: "service",
      });

      return result.updated;
    }

    // Si no hay cambio en isActive, actualización normal sin cascada
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

    // Transacción atómica: inactivar lotería + sorteos relacionados
    const result = await prisma.$transaction(async (tx) => {
      // 1. Inactivar la lotería
      const deleted = await tx.loteria.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: new Date(),
          deletedBy: userId,
        },
      });

      // 2. Inactivar sorteos relacionados por cascada (usando el cliente de transacción)
      const cascadeResult = await SorteoRepository.inactivateSorteosByLoteria(id, userId, tx);

      return { deleted, cascadeResult };
    });

    logger.warn({
      layer: "service",
      action: "LOTERIA_DELETE",
      userId,
      requestId,
      payload: {
        id,
        sorteosInactivated: result.cascadeResult.count,
        sorteosIds: result.cascadeResult.sorteosIds,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_DELETE,
      targetType: "LOTERIA",
      targetId: id,
      details: {
        isActive: false,
        sorteosInactivated: result.cascadeResult.count,
        sorteosIds: result.cascadeResult.sorteosIds,
      },
      requestId,
      layer: "service",
    });

    return result.deleted;
  },

  async restore(id: string, userId: string, requestId?: string) {
    const existing = await prisma.loteria.findUnique({ where: { id } });
    if (!existing) throw new AppError("Lotería not found", 404);

    // Transacción atómica: restaurar lotería + sorteos relacionados que fueron inactivados por cascada
    const result = await prisma.$transaction(async (tx) => {
      // 1. Restaurar la lotería
      const restored = await tx.loteria.update({
        where: { id },
        data: {
          isActive: true,
          deletedAt: null,
          deletedBy: null,
        },
      });

      // 2. Restaurar sorteos relacionados que fueron inactivados por cascada (usando el cliente de transacción)
      const cascadeResult = await SorteoRepository.restoreSorteosByLoteria(id, tx);

      return { restored, cascadeResult };
    });

    logger.info({
      layer: "service",
      action: "LOTERIA_RESTORE",
      userId,
      requestId,
      payload: {
        id,
        sorteosRestored: result.cascadeResult.count,
        sorteosIds: result.cascadeResult.sorteosIds,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.LOTERIA_RESTORE,
      targetType: "LOTERIA",
      targetId: id,
      details: {
        isActive: true,
        sorteosRestored: result.cascadeResult.count,
        sorteosIds: result.cascadeResult.sorteosIds,
      },
      requestId,
      layer: "service",
    });

    return result.restored;
  },

  async seedSorteosFromRules(loteriaId: string, start: Date, days: number, dryRun = false, scheduledDates?: Date[], forceCreate = false) {
    const loteria = await prisma.loteria.findUnique({
      where: { id: loteriaId },
      select: { name: true, rulesJson: true, isActive: true },
    })
    if (!loteria) throw new Error("Lotería no encontrada")
    if (!loteria.isActive) throw new Error("Lotería inactiva")

    const rules = (loteria.rulesJson ?? {}) as any
    // Si forceCreate=true (llamada manual desde endpoint), ignorar la bandera autoCreateSorteos
    // La bandera solo aplica para la autogeneración automática (cron jobs)
    if (!forceCreate && rules?.autoCreateSorteos === false) {
      logger.info({
        layer: "service",
        action: "LOTERIA_SEED_SORTEOS_SKIPPED_AUTO_CREATE_FLAG",
        payload: {
          loteriaId,
          loteriaName: loteria.name,
          autoCreateSorteos: false,
          message: "autoCreateSorteos=false, solo se crean manualmente o con forceCreate=true",
        },
      });
      return { created: 0, skipped: 0, alreadyExists: [], processed: [], note: "autoCreateSorteos=false (usa forceCreate para crear manualmente)" }
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

    logger.info({
      layer: "service",
      action: "LOTERIA_SEED_SORTEOS_FROM_RULES",
      payload: {
        loteriaId,
        loteriaName: loteria.name,
        start: start.toISOString(),
        days,
        dryRun,
        totalOccurrences: occurrences.length,
        hasScheduledDates: Array.isArray(scheduledDates) && scheduledDates.length > 0,
        scheduledDatesCount: scheduledDates?.length ?? 0,
      },
    });

    // Si viene subset, filtrar por timestamps exactos (idempotente)
    let subset = occurrences
    if (Array.isArray(scheduledDates) && scheduledDates.length > 0) {
      const subsetKeys = new Set(scheduledDates.map(d => new Date(d).getTime()))
      subset = occurrences.filter(o => subsetKeys.has(o.scheduledAt.getTime()))
      
      logger.info({
        layer: "service",
        action: "LOTERIA_SEED_SORTEOS_FILTERED",
        payload: {
          loteriaId,
          originalOccurrences: occurrences.length,
          filteredOccurrences: subset.length,
        },
      });
    }

    if (dryRun) {
      return {
        created: [],
        skipped: [],
        alreadyExists: [],
        preview: subset.map(o => ({ name: o.name, scheduledAt: formatIsoLocal(o.scheduledAt) })),
        processedSubset: (scheduledDates ?? []).map((d) => formatIsoLocal(d)),
      }
    }

    if (subset.length === 0) {
      logger.warn({
        layer: "service",
        action: "LOTERIA_SEED_SORTEOS_EMPTY_SUBSET",
        payload: {
          loteriaId,
          message: "No hay ocurrencias para crear sorteos",
        },
      });
      return {
        created: [],
        skipped: [],
        alreadyExists: [],
        processed: [],
        note: "No hay ocurrencias para crear",
      };
    }

    const result = await SorteoRepository.bulkCreateIfMissing(loteriaId, subset)
    
    // Invalidar cache de sorteos si se crearon nuevos
    const createdCount = Array.isArray(result.created) ? result.created.length : (typeof result.created === 'number' ? result.created : 0);
    if (createdCount > 0) {
      const { clearSorteoCache } = require('../../../utils/sorteoCache');
      clearSorteoCache();
    }
    
    logger.info({
      layer: "service",
      action: "LOTERIA_SEED_SORTEOS_RESULT",
      payload: {
        loteriaId,
        created: createdCount,
        skipped: Array.isArray(result.skipped) ? result.skipped.length : (typeof result.skipped === 'number' ? result.skipped : 0),
        alreadyExists: Array.isArray(result.alreadyExists) ? result.alreadyExists.length : 0,
        processed: Array.isArray(result.processed) ? result.processed.length : 0,
      },
    });

    return result
  },
};

export default LoteriaService;
