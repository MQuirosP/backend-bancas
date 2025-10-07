import { Role, ActivityType } from "@prisma/client";
import { AppError } from "../../../core/errors";
import prisma from "../../../core/prismaClient";
import ActivityService from "../../../core/activity.service";
import MultiplierOverrideRepository from "../../../repositories/multiplierOverride.repository";

type CreateDTO = {
  userId: string;
  loteriaId: string;
  baseMultiplierX: number;
  multiplierType: string;
};

type UpdateDTO = {
  baseMultiplierX: number;
};

export const MultiplierOverrideService = {
  // ADMIN: sin restricciones
  // VENTANA: solo si el user.target pertenece a su ventana
  // VENDEDOR: no permitido
  assertCanManage: async (actor: { id: string; role: Role; ventanaId?: string | null }, targetUserId: string) => {
    if (actor.role === Role.ADMIN) return;

    if (actor.role === Role.VENTANA) {
      // verificar que el usuario destino pertenece a su ventana
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
    await this.assertCanManage(actor, dto.userId);

    // evitar duplicados (userId+loteriaId únicos de facto)
    const existing = await MultiplierOverrideRepository.findByUserAndLoteria(dto.userId, dto.loteriaId);
    if (existing) {
      throw new AppError("Override already exists for this user and lottery", 409);
    }

    const created = await MultiplierOverrideRepository.create(dto);

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
    const current = await MultiplierOverrideRepository.getById(id);
    if (!current) throw new AppError("Override not found", 404);

    await this.assertCanManage(actor, current.userId);

    const updated = await MultiplierOverrideRepository.update(id, dto);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_UPDATE,
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: id,
      details: { before: current, after: updated },
    });

    return updated;
  },

  async remove(actor: { id: string; role: Role; ventanaId?: string | null }, id: string) {
    const current = await MultiplierOverrideRepository.getById(id);
    if (!current) throw new AppError("Override not found", 404);

    await this.assertCanManage(actor, current.userId);

    const deleted = await MultiplierOverrideRepository.delete(id);

    await ActivityService.log({
      userId: actor.id,
      action: ActivityType.MULTIPLIER_SETTING_DELETE,
      targetType: "USER_MULTIPLIER_OVERRIDE",
      targetId: id,
      details: { deleted },
    });

    return true;
  },

  async getById(actor: { id: string; role: Role; ventanaId?: string | null }, id: string) {
    const current = await MultiplierOverrideRepository.getById(id);
    if (!current) throw new AppError("Override not found", 404);

    // lectura: VENTANA solo si pertenece a su ventana; VENDEDOR solo si es suyo; ADMIN libre
    if (actor.role === Role.ADMIN) return current;

    if (actor.role === Role.VENTANA) {
      const target = await prisma.user.findUnique({
        where: { id: current.userId },
        select: { ventanaId: true },
      });
      if (!target || target.ventanaId !== actor.ventanaId) {
        throw new AppError("Forbidden", 403);
      }
      return current;
    }

    // VENDEDOR: solo su propio override
    if (actor.role === Role.VENDEDOR) {
      if (current.userId !== actor.id) throw new AppError("Forbidden", 403);
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

    // restricciones por rol
    if (actor.role === Role.ADMIN) {
      return MultiplierOverrideRepository.list({ ...params, skip, take: pageSize });
    }

    if (actor.role === Role.VENTANA) {
      // limitar por su ventana: userId de esa ventana
      const users = await prisma.user.findMany({
        where: { ventanaId: actor.ventanaId ?? undefined },
        select: { id: true },
      });
      const allowedUserIds = users.map((u) => u.id);

      const whereUserId = params.userId
        ? allowedUserIds.includes(params.userId) ? params.userId : "__blocked__"
        : undefined;

      return MultiplierOverrideRepository.list({
        userId: whereUserId,
        loteriaId: params.loteriaId,
        skip,
        take: pageSize,
      });
    }

    // VENDEDOR: solo los suyos
    if (actor.role === Role.VENDEDOR) {
      return MultiplierOverrideRepository.list({
        userId: actor.id,
        loteriaId: params.loteriaId,
        skip,
        take: pageSize,
      });
    }

    throw new AppError("Forbidden", 403);
  },
};

export default MultiplierOverrideService;
