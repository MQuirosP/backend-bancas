// src/api/v1/services/multiplierOverride.service.ts
import { Role, ActivityType } from "@prisma/client";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";
import VentanaMultiplierOverrideRepository from "../../../repositories/ventanaMultiplierOverride.repository";

type CreateDTO = {
  ventanaId: string;
  loteriaId: string;
  baseMultiplierX: number;
  multiplierType: string;
};

type UpdateDTO = {
  baseMultiplierX: number;
};

export const VentanaMultiplierOverrideService = {
  async assertCanManage(
    actor: { id: string; role: Role; ventanaId?: string | null },
    targetUserId: string
  ) {
    if (actor.role === Role.ADMIN) return;

    if (actor.role === Role.VENTANA) {
      const target = await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { ventanaId: true },
      });
      if (!target) throw new AppError("Target user not found", 404);
      if (!actor.ventanaId || target.ventanaId !== actor.ventanaId) {
        throw new AppError("Not allowed to manage this user", 403);
      }
      return;
    }

    throw new AppError("Forbidden", 403);
  },

  async create(actor: { id: string; role: Role; ventanaId?: string | null }, dto: CreateDTO) {
    await this.assertCanManage(actor, dto.ventanaId);

    const existing = await VentanaMultiplierOverrideRepository.findByVentanaAndLoteria(
      dto.ventanaId,
      dto.loteriaId,
      dto.multiplierType
    );
    if (existing) throw new AppError("Override already exists for this user/lottery/type", 409);

    const created = await VentanaMultiplierOverrideRepository.create(dto);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_CREATE,
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: created.id,
      details: dto,
    });

    return created;
  },

  async update(actor: { id: string; role: Role; ventanaId?: string | null }, id: string, dto: UpdateDTO) {
    const current = await VentanaMultiplierOverrideRepository.getById(id);
    if (!current || !current.isActive) throw new AppError("Override not found", 404);

    await this.assertCanManage(actor, current.ventanaId);

    const updated = await VentanaMultiplierOverrideRepository.update(id, dto);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_UPDATE,
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: id,
      details: { before: current, after: updated },
    });

    return updated;
  },

  // Renombrado semánticamente a "deactivate" (antes softDelete con isDeleted)
  async deactivate(
    actor: { id: string; role: Role; ventanaId?: string | null },
    id: string,
    reason?: string
  ) {
    const current = await VentanaMultiplierOverrideRepository.getById(id);
    if (!current || !current.isActive) throw new AppError("Override not found", 404);

    await this.assertCanManage(actor, current.ventanaId);

    const deactivated = await VentanaMultiplierOverrideRepository.delete(id, actor.id, reason);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_DELETE, // conservamos el tipo de actividad
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: id,
      details: { deactivated, reason: reason ?? null },
    });

    return true;
  },

  async restore(actor: { id: string; role: Role; ventanaId?: string | null }, id: string) {
    const current = await VentanaMultiplierOverrideRepository.getById(id);
    if (!current) throw new AppError("Override not found", 404);

    await this.assertCanManage(actor, current.ventanaId);

    const restored = await VentanaMultiplierOverrideRepository.restore(id);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_RESTORE,
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: id,
      details: { restored },
    });

    return restored;
  },

  async getById(actor: { id: string; role: Role; ventanaId?: string | null }, id: string) {
    const current = await VentanaMultiplierOverrideRepository.getById(id);
    if (!current || !current.isActive) throw new AppError("Override not found", 404);

    if (actor.role === Role.ADMIN) return current;

    if (actor.role === Role.VENTANA) {
      const target = await prisma.user.findUnique({
        where: { id: current.ventanaId },
        select: { ventanaId: true },
      });
      if (!target || target.ventanaId !== actor.ventanaId) throw new AppError("Forbidden", 403);
      return current;
    }

    if (actor.role === Role.VENDEDOR) {
      if (current.ventanaId !== actor.id) throw new AppError("Forbidden", 403);
      return current;
    }

    throw new AppError("Forbidden", 403);
  },

  async list(
    actor: { id: string; role: Role; ventanaId?: string | null },
    params: { userId?: string; loteriaId?: string; page?: number; pageSize?: number }
  ) {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 10;
    const skip = (page - 1) * pageSize;

    if (actor.role === Role.ADMIN) {
      const { data, total } = await VentanaMultiplierOverrideRepository.list({
        ...params,
        skip,
        take: pageSize,
      } as any);
      return { data, meta: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
    }

    if (actor.role === Role.VENTANA) {
      const users = await prisma.user.findMany({
        where: { ventanaId: actor.ventanaId ?? undefined },
        select: { id: true },
      });
      const allowedUserIds = new Set(users.map((u) => u.id));

      const whereUserId =
        params.userId != null
          ? allowedUserIds.has(params.userId) ? params.userId : "__blocked__"
          : undefined;

      const { data, total } = await VentanaMultiplierOverrideRepository.list({
        ventanaId: whereUserId,
        loteriaId: params.loteriaId,
        skip,
        take: pageSize,
      });
      return { data, meta: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
    }

    if (actor.role === Role.VENDEDOR) {
      const { data, total } = await VentanaMultiplierOverrideRepository.list({
        ventanaId: actor.id,
        loteriaId: params.loteriaId,
        skip,
        take: pageSize,
      });
      return { data, meta: { page, pageSize, total, pages: Math.ceil(total / pageSize) } };
    }

    throw new AppError("Forbidden", 403);
  },
};

export default VentanaMultiplierOverrideService;
