import { Request, Response } from "express";
import { ActivityType, Role } from "@prisma/client";
import UserService from "../services/user.service";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { success, created } from "../../../utils/responses";

export const UserController = {
  async create(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.create(req.body);

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
    const queryParams: any = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      role: (req.query.role as Role) ?? undefined,
      search:
        typeof req.query.search === "string" ? req.query.search : undefined,
      isActive:
        req.query.isActive !== undefined
          ? String(req.query.isActive) === "true"
          : undefined,
    };

    // Scoping por rol: VENTANA solo ve sus vendedores activos
    if (currentUser && currentUser.role === Role.VENTANA) {
      Object.assign(queryParams, {
        role: Role.VENDEDOR,
        ventanaId: currentUser.ventanaId,
        isActive: true,
      });
    }

    const { data, meta } = await UserService.list(queryParams);
    return success(res, data, meta);
  },

  async update(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.update(req.params.id, req.body);

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
    const actorId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.softDelete(
      req.params.id,
      actorId!,
      "Deleted by admin"
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
    const actorId = (req as any)?.user?.id ?? null;
    const requestId = (req as any)?.requestId ?? null;

    const user = await UserService.restore(req.params.id);

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
};

export default UserController;
