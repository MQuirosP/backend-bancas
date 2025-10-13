import { AppError } from "../../../core/errors";
import { ActivityType } from "@prisma/client";
import { CreateMultiplierDTO, UpdateMultiplierDTO, ListMultiplierQuery } from "../dto/multiplier.dto";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";

const MultiplierService = {
  async create(userId: string, body: unknown) {
    const dto = CreateMultiplierDTO.parse(body);

    // Garantiza unicidad (opcional): name + loteriaId activos
    const dup = await prisma.loteriaMultiplier.findFirst({
      where: { loteriaId: dto.loteriaId, name: dto.name, isActive: true },
      select: { id: true }
    });
    if (dup) throw new AppError("A multiplier with the same name is already active for this loteria", 409);

    const created = await prisma.loteriaMultiplier.create({ data: dto });

    await ActivityService.log({
      userId, action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER", targetId: created.id,
      details: { op: "create", data: dto }
    });

    return created;
  },

  async update(userId: string, id: string, body: unknown) {
    const dto = UpdateMultiplierDTO.parse(body);

    const existing = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!existing) throw new AppError("Multiplier not found", 404);

    const updated = await prisma.loteriaMultiplier.update({ where: { id }, data: dto });

    await ActivityService.log({
      userId, action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER", targetId: id,
      details: { op: "update", before: existing, after: dto }
    });

    return updated;
  },

  async toggle(userId: string, id: string, enable: boolean) {
    const existing = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!existing) throw new AppError("Multiplier not found", 404);

    const updated = await prisma.loteriaMultiplier.update({
      where: { id }, data: { isActive: enable }
    });

    await ActivityService.log({
      userId, action: ActivityType.SYSTEM_ACTION,
      targetType: "LOTERIA_MULTIPLIER", targetId: id,
      details: { op: "toggle", isActive: enable }
    });

    return updated;
  },

  async getById(id: string) {
    const r = await prisma.loteriaMultiplier.findUnique({ where: { id } });
    if (!r) throw new AppError("Multiplier not found", 404);
    return r;
  },

  async list(query: unknown) {
    const q = ListMultiplierQuery.parse(query);
    const where: any = {};
    if (q.loteriaId) where.loteriaId = q.loteriaId;
    if (q.kind) where.kind = q.kind;
    if (typeof q.isActive === "boolean") where.isActive = q.isActive;
    if (q.appliesToSorteoId) where.appliesToSorteoId = q.appliesToSorteoId;
    if (q.q) where.name = { contains: q.q, mode: "insensitive" };

    const skip = (q.page - 1) * q.pageSize;
    const [data, total] = await Promise.all([
      prisma.loteriaMultiplier.findMany({
        where, skip, take: q.pageSize, orderBy: { updatedAt: "desc" }
      }),
      prisma.loteriaMultiplier.count({ where })
    ]);

    return {
      data,
      meta: { page: q.page, pageSize: q.pageSize, total, pages: Math.ceil(total / q.pageSize) }
    };
  }
};

export default MultiplierService;
