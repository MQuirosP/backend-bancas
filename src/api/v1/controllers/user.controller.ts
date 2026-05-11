import { Request, Response } from "express";
import { ActivityType, Role } from "@prisma/client";
import UserService from "../services/user.service";
import ActivityService from "../../../core/activity.service";
import logger from "../../../core/logger";
import { success, created } from "../../../utils/responses";
import prisma from "../../../core/prismaClient";
import { AppError } from "../../../core/errors";
import { AuthenticatedRequest } from "../../../core/types";
import { applyRbacFilters, AuthContext } from "../../../utils/rbac";

export const UserController = {
  async create(req: AuthenticatedRequest, res: Response) {
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

  async getById(req: AuthenticatedRequest, res: Response) {
    const user = await UserService.getById(req.params.id);
    return success(res, user);
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const currentUser = req.user!;

    // Valores directamente del query validado por Zod
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 10;
    const role = (req.query.role as Role) ?? undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const isActive = req.query.isActive !== undefined ? String(req.query.isActive) === "true" : (currentUser.role === Role.VENTANA ? true : undefined);

    // 1. Aplicar RBAC para determinar qué usuarios puede ver el actor
    const context: AuthContext = {
      userId: currentUser.id,
      role: currentUser.role,
      ventanaId: currentUser.ventanaId || undefined,
      bancaId: req.bancaContext?.bancaId || undefined, // Usar contexto dinámico
    };

    const effectiveFilters = await applyRbacFilters(context, {
      ventanaId: req.query.ventanaId as string,
      bancaId: req.query.bancaId as string,
      scope: (req.query.scope as string) || "mine",
    });

    // 2. Ejecutar listado con los filtros efectivos
    const { data, meta } = await UserService.list({
      page,
      pageSize,
      role,
      search,
      isActive,
      ventanaId: effectiveFilters.ventanaId || undefined,
      bancaId: effectiveFilters.bancaId || undefined,
      actor: currentUser,
    });

    return success(res, data, meta);
  },

  async update(req: AuthenticatedRequest, res: Response) {
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

  async remove(req: AuthenticatedRequest, res: Response) {
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

  async restore(req: AuthenticatedRequest, res: Response) {
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

  async changePassword(req: AuthenticatedRequest, res: Response) {
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

  async getAllowedMultipliers(req: AuthenticatedRequest, res: Response) {
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

  async getAllowedMultipliersBatch(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { betType, isActive } = req.query;

    const result = await UserService.getAllowedMultipliersBatch(
      id,
      betType as 'NUMERO' | 'REVENTADO' | undefined,
      isActive as any
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "GET_ALLOWED_MULTIPLIERS_BATCH",
      userId: (req as any)?.user?.id,
      payload: { 
        targetUserId: id, 
        betType, 
        isActive, 
        multipliersCount: result.data.length 
      },
    });

    return success(res, result.data, result.meta);
  },
};

export default UserController;
