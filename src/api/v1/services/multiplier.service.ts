// src/api/v1/services/multiplier.service.ts
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
    const dup = await prisma.loteriaMultiplier.findFirst({
      where: { loteriaId: data.loteriaId, name: data.name, isActive: true },
      select: { id: true },
    });
    if (dup) {
      throw new AppError(
        "A multiplier with the same name is already active for this loteria",
        409
      );
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
      //  devuelve también la lotería al crear (opcional pero útil para front)
      include: { loteria: { select: { id: true, name: true } } },
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
        throw new AppError(
          "A multiplier with the same name is already active for this loteria",
          409
        );
      }
    }

    const updated = await prisma.loteriaMultiplier.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        valueX: data.valueX ?? existing.valueX,
        kind: data.kind ?? existing.kind,
        appliesToDate:
          data.appliesToDate === undefined
            ? existing.appliesToDate
            : data.appliesToDate,
        appliesToSorteoId:
          data.appliesToSorteoId === undefined
            ? existing.appliesToSorteoId
            : data.appliesToSorteoId,
        isActive: data.isActive ?? existing.isActive,
      },
      //  devuelve también la lotería al actualizar
      include: { loteria: { select: { id: true, name: true } } },
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

    if (existing.isActive === enable) {
      // Devuelve con include consistente
      return prisma.loteriaMultiplier.findUnique({
        where: { id },
        include: { loteria: { select: { id: true, name: true } } },
      }) as any;
    }

    const updated = await prisma.loteriaMultiplier.update({
      where: { id },
      data: { isActive: enable },
      include: { loteria: { select: { id: true, name: true } } },
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
    if (existing.isActive) {
      return prisma.loteriaMultiplier.findUnique({
        where: { id },
        include: { loteria: { select: { id: true, name: true } } },
      }) as any;
    }

    const restored = await prisma.loteriaMultiplier.update({
      where: { id },
      data: { isActive: true },
      include: { loteria: { select: { id: true, name: true } } },
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

  //  incluye lotería para detalle
  async getById(id: string) {
    const r = await prisma.loteriaMultiplier.findUnique({
      where: { id },
      include: { loteria: { select: { id: true, name: true } } },
    });
    if (!r) throw new AppError("Multiplier not found", 404);
    return r;
  },

  async list(query: ListMultiplierQueryInput) {
    const q = query;

    //  construir where con búsqueda por name y por nombre de lotería
    const and: any[] = [];
    if (q.q?.trim()) {
      const s = q.q.trim();
      and.push({
        OR: [
          { name: { contains: s, mode: "insensitive" } },
          { loteria: { name: { contains: s, mode: "insensitive" } } as any },
        ],
      });
    }

    const where: any = {
      ...(q.loteriaId ? { loteriaId: q.loteriaId } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(typeof q.isActive === "boolean" ? { isActive: q.isActive } : {}),
      ...(q.appliesToSorteoId ? { appliesToSorteoId: q.appliesToSorteoId } : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      prisma.loteriaMultiplier.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { updatedAt: "desc" },
        include: { loteria: { select: { id: true, name: true } } },
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
