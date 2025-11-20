import { Request, Response } from "express";
import { ActivityType, Role } from "@prisma/client";
import UserService from "../services/user.service";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { success, created } from "../../../utils/responses";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";

export const UserController = {
  async create(req: Request, res: Response) {
    const actor = (req as any)?.user ?? null;
    const actorId = actor?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.create(req.body, actor ?? undefined);

    (req as any)?.logger?.info({
      layer: "controller",
      action: "USER_CREATE",
      userId: actorId,
      payload: {
        createdUserId: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
      },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.USER_CREATE,
      targetType: "USER",
      targetId: user.id,
      details: { email: user.email, role: user.role },
      requestId,
      layer: "controller",
    });

    return created(res, user);
  },

  async getById(req: Request, res: Response) {
    const user = await UserService.getById(req.params.id);
    return success(res, user);
  },

  async list(req: Request, res: Response) {
    const currentUser = (req as any)?.user;

    // Valores directamente del query validado por Zod
    let page = req.query.page ? Number(req.query.page) : 1;
    let pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;
    let role = (req.query.role as Role) ?? undefined;
    let search = typeof req.query.search === "string" ? req.query.search : undefined;
    let isActive = req.query.isActive as any; // Ya es boolean | undefined

    // Si es VENTANA: solo vendedores de su ventana
    if (currentUser?.role === Role.VENTANA) {
      role = Role.VENDEDOR;

      // Si no especificó isActive, default = true
      if (isActive === undefined) {
        isActive = true;
      }

      // Obtener ventanaId
      let ventanaId = currentUser.ventanaId;
      if (!ventanaId) {
        const user = await prisma.user.findUnique({
          where: { id: currentUser.id },
          select: { ventanaId: true },
        });
        ventanaId = user?.ventanaId ?? null;
      }

      if (!ventanaId) {
        throw new AppError("El usuario VENTANA no tiene una ventana asignada", 403, "NO_VENTANA");
      }

      const { data, meta } = await UserService.list({ page, pageSize, role, search, isActive, ventanaId });
      return success(res, data, meta);
    }

    // Si es ADMIN: sin restricciones
    const { data, meta } = await UserService.list({ page, pageSize, role, search, isActive });
    return success(res, data, meta);
  }
  ,

  async update(req: Request, res: Response) {
    const actor = (req as any)?.user ?? null;
    const actorId = actor?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.update(req.params.id, req.body, actor ?? undefined);

    (req as any)?.logger?.info({
      layer: "controller",
      action: "USER_UPDATE",
      userId: actorId,
      payload: { updatedUserId: user.id, changes: Object.keys(req.body) },
    });

    // si cambió el role, registramos evento específico
    if (req.body.role) {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_ROLE_CHANGE,
        targetType: "USER",
        targetId: user.id,
        details: { newRole: req.body.role },
        requestId,
        layer: "controller",
      });
    } else {
      await ActivityService.log({
        userId: actorId,
        action: ActivityType.USER_UPDATE,
        targetType: "USER",
        targetId: user.id,
        details: { fields: Object.keys(req.body) },
        requestId,
        layer: "controller",
      });
    }

    return success(res, user);
  },

  async remove(req: Request, res: Response) {
    const actor = (req as any)?.user ?? null;
    const actorId = actor?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.softDelete(
      req.params.id,
      actor ?? undefined,
      actorId ?? undefined,
      actor?.role === Role.ADMIN ? "Deleted by admin" : "Deleted by ventana"
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "USER_DELETE",
      userId: actorId,
      payload: { deletedUserId: user.id },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.USER_DELETE,
      targetType: "USER",
      targetId: user.id,
      details: { reason: "Deleted by admin" },
      requestId,
      layer: "controller",
    });

    return success(res, user);
  },

  async restore(req: Request, res: Response) {
    const actor = (req as any)?.user ?? null;
    const actorId = actor?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.restore(req.params.id, actor ?? undefined);

    (req as any)?.logger?.info({
      layer: "controller",
      action: "USER_RESTORE",
      userId: actorId,
      payload: { restoredUserId: user.id },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.USER_RESTORE,
      targetType: "USER",
      targetId: user.id,
      details: null,
      requestId,
      layer: "controller",
    });

    return success(res, user);
  },

  async changePassword(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id;
    const requestId = (req as any)?.requestId ?? null;
    const { currentPassword, newPassword } = req.body;

    // Solo el usuario autenticado puede cambiar su propia contraseña
    if (!actorId) {
      throw new (require("../../../core/errors").AppError)(
        "Usuario no autenticado",
        401,
        { code: "UNAUTHORIZED" }
      );
    }

    const result = await UserService.changePassword(
      actorId,
      currentPassword,
      newPassword
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "PASSWORD_CHANGE",
      userId: actorId,
      payload: { success: true },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.PASSWORD_CHANGE,
      targetType: "USER",
      targetId: actorId,
      details: null,
      requestId,
      layer: "controller",
    });

    return success(res, result);
  },

  async getAllowedMultipliers(req: Request, res: Response) {
    const { userId } = req.params;
    const { loteriaId, betType } = req.query;

    const result = await UserService.getAllowedMultipliers(
      userId,
      loteriaId as string,
      (betType as 'NUMERO' | 'REVENTADO') || 'NUMERO'
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "GET_ALLOWED_MULTIPLIERS",
      userId: (req as any)?.user?.id,
      payload: { userId, loteriaId, betType, multipliersCount: result.data.length },
    });

    return success(res, result.data, result.meta);
  },
};

export default UserController;
