// src/api/v1/controllers/loteria.controller.ts
import { Request, Response } from "express";
import { ActivityType } from "@prisma/client";
import LoteriaService from "../services/loteria.service";
import ActivityService from "../../../core/activity.service";
import { success, created } from "../../../utils/responses";
import { computeOccurrences } from "../../../utils/schedule";
import { formatIsoLocal, parseCostaRicaDateTime } from "../../../utils/datetime";

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
    const isActive =
      typeof req.query.isActive === "string"
        ? req.query.isActive === "true"
        : undefined;

    const search =
      typeof req.query.search === "string" ? req.query.search : undefined; // ✅ nuevo

    const { data, meta } = await LoteriaService.list({
      page,
      pageSize,
      isActive,
      search,
    });

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_LIST",
      requestId: (req as any)?.requestId ?? null,
      payload: {
        page,
        pageSize,
        isActive,
        hasSearch: Boolean(search && search.trim()),
      },
    });
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

    async previewSchedule(req: Request, res: Response) {
    const loteriaId = req.params.id;
    const start = req.query.start ? parseCostaRicaDateTime(String(req.query.start)) : new Date();
    const days = req.query.days ? Number(req.query.days) : 7;
    const limit = req.query.limit ? Number(req.query.limit) : 200;

    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: "start inválido" });
    }

    const loteria = await LoteriaService.getById(loteriaId);
    const rules = (loteria.rulesJson ?? {}) as any;

    const occurrences = computeOccurrences({
      loteriaName: loteria.name,
      schedule: {
        frequency: rules?.drawSchedule?.frequency,
        times: rules?.drawSchedule?.times,
        daysOfWeek: rules?.drawSchedule?.daysOfWeek,
      },
      start,
      days,
      limit,
    });

    const data = occurrences.map((o: any) => ({
      scheduledAt: formatIsoLocal(o.scheduledAt),
      name: o.name,
    }));

    return success(res, data, { count: data.length });
  },

  async seedSorteos(req: Request, res: Response) {
  const loteriaId = req.params.id
  const start = req.query.start ? parseCostaRicaDateTime(String(req.query.start)) : new Date()
  const days = req.query.days ? Number(req.query.days) : 7
  const dryRun = req.query.dryRun === "true"

  if (isNaN(start.getTime())) {
    return res.status(400).json({ success: false, message: "start inválido" })
  }
  if (days < 1 || days > 31) {
    return res.status(400).json({ success: false, message: "days debe ser 1..31" })
  }

  const subset: Date[] | undefined = Array.isArray((req as any).body?.scheduledDates)
    ? (req as any).body.scheduledDates
        .map((d: any) => {
          try {
            return parseCostaRicaDateTime(d);
          } catch {
            return null;
          }
        })
        .filter((d: Date | null): d is Date => !!d)
    : undefined

  const result = await LoteriaService.seedSorteosFromRules(loteriaId, start, days, dryRun, subset)
  return res.json({ success: true, data: result })
}

};

export default LoteriaController;
