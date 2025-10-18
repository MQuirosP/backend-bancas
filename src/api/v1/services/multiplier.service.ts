import { AppError } from "../../../core/errors";
import { ActivityType } from "@prisma/client";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";
import {
  CreateMultiplierInput,
  UpdateMultiplierInput,
  ListMultiplierQueryInput,
} from "../dto/multiplier.dto";

const MultiplierService = {
  async create(userId: string, data: CreateMultiplierInput) {
    // Unicidad lógica: (loteriaId, name) activos
    const dup = await prisma.loteriaMultiplier.findFirst({
      where: { loteriaId: data.loteriaId, name: data.name, isActive: true },
      select: { id: true },
    });
    if (dup) {
      throw new AppError("A multiplier with the same name is already active for this loteria", 409);
    }

    const created = await prisma.loteriaMultiplier.create({
      data: {
        loteriaId: data.loteriaId,
        name: data.name,
        valueX: data.valueX,
        kind: data.kind ?? "NUMERO",
        appliesToDate: data.appliesToDate ?? null,
        appliesToSorteoId: data.appliesToSorteoId ?? null,
        isActive: data.isActive ?? true,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER",
      targetId: created.id,
      details: { op: "create", data },
    });

    return created;
  },

  async update(userId: string, id: string, data: UpdateMultiplierInput) {
    const existing = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!existing) throw new AppError("Multiplier not found", 404);

    // Evitar duplicado activo si cambian el name
    if (data.name && data.name !== existing.name) {
      const dup = await prisma.loteriaMultiplier.findFirst({
        where: {
          loteriaId: existing.loteriaId,
          name: data.name,
          isActive: true,
          NOT: { id },
        },
        select: { id: true },
      });
      if (dup) {
        throw new AppError("A multiplier with the same name is already active for this loteria", 409);
      }
    }

    const updated = await prisma.loteriaMultiplier.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        valueX: data.valueX ?? existing.valueX,
        kind: data.kind ?? existing.kind,
        appliesToDate:
          data.appliesToDate === undefined ? existing.appliesToDate : data.appliesToDate, // respeta null explícito
        appliesToSorteoId:
          data.appliesToSorteoId === undefined ? existing.appliesToSorteoId : data.appliesToSorteoId,
        isActive: data.isActive ?? existing.isActive,
      },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER",
      targetId: id,
      details: { op: "update", before: existing, after: data },
    });

    return updated;
  },

  async softDelete(userId: string, id: string, enable: boolean) {
    const existing = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!existing) throw new AppError("Multiplier not found", 404);

    if (existing.isActive === enable) return existing;

    const updated = await prisma.loteriaMultiplier.update({
      where: { id },
      data: { isActive: enable },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER",
      targetId: id,
      details: { op: "toggle", isActive: enable },
    });

    return updated;
  },

  async restore(userId: string, id: string) {
    const existing = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!existing) throw new AppError("Multiplier not found", 404);
    if (existing.isActive) return existing;

    const restored = await prisma.loteriaMultiplier.update({
      where: { id },
      data: { isActive: true },
    });

    await ActivityService.log({
      userId,
      action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER",
      targetId: id,
      details: { op: "restore", wasActive: false, nowActive: true },
    });

    return restored;
  },

  async getById(id: string) {
    const r = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!r) throw new AppError("Multiplier not found", 404);
    return r;
  },

  async list(query: ListMultiplierQueryInput) {
    const q = query;

    const where: any = {};
    if (q.loteriaId) where.loteriaId = q.loteriaId;
    if (q.kind) where.kind = q.kind;
    if (typeof q.isActive === "boolean") where.isActive = q.isActive;
    if (q.appliesToSorteoId) where.appliesToSorteoId = q.appliesToSorteoId;
    if (q.q) where.name = { contains: q.q, mode: "insensitive" };

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.loteriaMultiplier.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.loteriaMultiplier.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      },
    };
  },
};

export default MultiplierService;
