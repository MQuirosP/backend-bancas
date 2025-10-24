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
    const start = req.query.start ? new Date(String(req.query.start)) : new Date();
    const days = req.query.days ? Number(req.query.days) : 7;
    const limit = req.query.limit ? Number(req.query.limit) : 200;

    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: "start inválido" });
    }

    const loteria = await LoteriaService.getById(loteriaId);
    const rules = (loteria.rulesJson ?? {}) as any;

    // Normalizar drawSchedule con tus claves en español
    const frequency: 'diario'|'semanal'|'personalizado' = rules?.drawSchedule?.frequency ?? 'diario';
    const times: string[] = Array.isArray(rules?.drawSchedule?.times) ? rules.drawSchedule.times : [];
    const daysOfWeek: number[] = Array.isArray(rules?.drawSchedule?.daysOfWeek) ? rules.drawSchedule.daysOfWeek : [0,1,2,3,4,5,6];

    if (times.length === 0) {
      return success(res, [], { count: 0 });
    }

    // Helpers locales
    const pad = (n: number) => String(n).padStart(2, "0");
    const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const atTime = (base: Date, hhmm: string) => {
      const [h, m] = hhmm.split(":").map((x: string) => parseInt(x, 10));
      const d = new Date(base);
      d.setHours(isNaN(h) ? 0 : h, isNaN(m) ? 0 : m, 0, 0);
      return d;
    };

    const from = new Date(start); from.setSeconds(0,0);
    const to = addDays(from, days);

    const out: Array<{ scheduledAt: string; name: string }> = [];
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);

    while (cursor <= to && out.length < limit) {
      const dow = cursor.getDay(); // 0..6 (0=Domingo)
      const includeDay =
        frequency === 'diario'
          ? true
          : frequency === 'semanal'
            ? daysOfWeek.includes(dow)
            : true; // personalizado: mostramos 'times' cada día; si luego necesitas otra semántica, se ajusta aquí

      if (includeDay) {
        for (const t of times) {
          const dt = atTime(cursor, t);
          if (dt >= from && dt <= to) {
            out.push({
              scheduledAt: dt.toISOString(),
              name: `${loteria.name} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
            });
            if (out.length >= limit) break;
          }
        }
      }
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0,0,0,0);
    }

    out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return success(res, out, { count: out.length, from: from.toISOString(), to: to.toISOString() });
  },

  async seedSorteos(req: Request, res: Response) {
  const loteriaId = req.params.id
  const start = req.query.start ? new Date(String(req.query.start)) : new Date()
  const days = req.query.days ? Number(req.query.days) : 7
  const dryRun = req.query.dryRun === "true"

  if (isNaN(start.getTime())) {
    return res.status(400).json({ success: false, message: "start inválido" })
  }
  if (days < 1 || days > 31) {
    return res.status(400).json({ success: false, message: "days debe ser 1..31" })
  }

  const result = await LoteriaService.seedSorteosFromRules(loteriaId, start, days, dryRun)
  return res.json({ success: true, data: result })
}

};

export default LoteriaController;
