// src/api/v1/controllers/loteria.controller.ts
import { Request, Response } from "express";
import { ActivityType } from "@prisma/client";
import LoteriaService from "../services/loteria.service";
import ActivityService from "../../../core/activity.service";
import { success, created } from "../../../utils/responses";

export const LoteriaController = {
  async create(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id as string;
    const requestId = (req as any)?.requestId ?? null;

    const loteria = await LoteriaService.create(
      req.body,
      actorId,
      requestId ?? undefined
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_CREATE",
      userId: actorId,
      requestId,
      payload: { id: loteria.id, name: loteria.name },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.LOTERIA_CREATE,
      targetType: "LOTERIA",
      targetId: loteria.id,
      details: { name: loteria.name },
      requestId,
      layer: "controller",
    });

    return created(res, loteria);
  },

  async list(req: Request, res: Response) {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize
      ? Number(req.query.pageSize)
      : undefined;
    const isDeleted =
      typeof req.query.isDeleted === "string"
        ? req.query.isDeleted === "true"
        : undefined;

    const search =
      typeof req.query.search === "string" ? req.query.search : undefined; // ✅ nuevo

    const { data, meta } = await LoteriaService.list({
      page,
      pageSize,
      isDeleted,
      search,
    });

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_LIST",
      requestId: (req as any)?.requestId ?? null,
      payload: {
        page,
        pageSize,
        isDeleted,
        hasSearch: Boolean(search && search.trim()),
      },
    });
    console.log("Loteria list meta:", meta, "search:", search, "data:", data);
    return success(res, data, meta);
  },

  async getById(req: Request, res: Response) {
    const loteria = await LoteriaService.getById(req.params.id);

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_GET_BY_ID",
      requestId: (req as any)?.requestId ?? null,
      payload: { id: req.params.id },
    });

    return success(res, loteria);
  },

  async update(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id as string;
    const requestId = (req as any)?.requestId ?? null;

    const updated = await LoteriaService.update(
      req.params.id,
      req.body,
      actorId,
      requestId ?? undefined
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_UPDATE",
      userId: actorId,
      requestId,
      payload: { id: updated.id, changes: Object.keys(req.body) },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.LOTERIA_UPDATE,
      targetType: "LOTERIA",
      targetId: updated.id,
      details: { fields: Object.keys(req.body) },
      requestId,
      layer: "controller",
    });

    return success(res, updated);
  },

  async remove(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id as string;
    const requestId = (req as any)?.requestId ?? null;

    const loteria = await LoteriaService.softDelete(
      req.params.id,
      actorId,
      requestId ?? undefined
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_DELETE",
      userId: actorId,
      requestId,
      payload: { id: req.params.id },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.LOTERIA_DELETE,
      targetType: "LOTERIA",
      targetId: req.params.id,
      details: { reason: "Deleted by admin" },
      requestId,
      layer: "controller",
    });

    return success(res, loteria);
  },

  async restore(req: Request, res: Response) {
    const actorId = (req as any)?.user?.id as string;
    const requestId = (req as any)?.requestId ?? null;

    const loteria = await LoteriaService.restore(
      req.params.id,
      actorId,
      requestId ?? undefined
    );

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_RESTORE",
      userId: actorId,
      requestId,
      payload: { id: req.params.id },
    });

    await ActivityService.log({
      userId: actorId,
      action: ActivityType.LOTERIA_RESTORE,
      targetType: "LOTERIA",
      targetId: req.params.id,
      details: null,
      requestId,
      layer: "controller",
    });

    return success(res, loteria);
  },
};

export default LoteriaController;
