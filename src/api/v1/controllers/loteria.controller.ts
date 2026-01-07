// src/api/v1/controllers/loteria.controller.ts
import { Request, Response } from "express";
import { ActivityType } from "@prisma/client";
import LoteriaService from "../services/loteria.service";
import ActivityService from "../../../core/activity.service";
import { success, created } from "../../../utils/responses";
import { computeOccurrences } from "../../../utils/schedule";
import { formatIsoLocal, parseCostaRicaDateTime, startOfLocalDay, endOfLocalDay, addLocalDays } from "../../../utils/datetime";
import prisma from "../../../core/prismaClient";

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
      typeof req.query.search === "string" ? req.query.search : undefined; //  nuevo

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
    const now = new Date(); // Hora actual del servidor
    const start = req.query.start ? parseCostaRicaDateTime(String(req.query.start)) : now;
    const days = req.query.days ? Number(req.query.days) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const allowPast = req.query.allowPast === "true"; //  NUEVO: permitir fechas pasadas

    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: "start inválido" });
    }

    const loteria = await LoteriaService.getById(loteriaId);
    const rules = (loteria.rulesJson ?? {}) as any;

    //  Calcular rango de fechas usando el parámetro 'start' (no 'now')
    const startOfDay = startOfLocalDay(start);
    const endOfDays = endOfLocalDay(addLocalDays(startOfDay, days - 1));

    const occurrences = computeOccurrences({
      loteriaName: loteria.name,
      schedule: {
        frequency: rules?.drawSchedule?.frequency,
        times: rules?.drawSchedule?.times,
        daysOfWeek: rules?.drawSchedule?.daysOfWeek,
      },
      start: startOfDay,
      days,
      limit,
    });

    //  Filtrar por rango calculado (no por "ahora")
    // Si allowPast=true, mostrar todos; si false, solo futuros respecto a now
    let filteredOccurrences = occurrences;
    if (!allowPast) {
      filteredOccurrences = occurrences.filter((o: any) => o.scheduledAt >= now);
    }

    // Verificar duplicados en la base de datos
    const scheduledDates = filteredOccurrences.map((o: any) => o.scheduledAt);

    let existingDatesSet = new Set<number>();

    if (scheduledDates.length > 0) {
      const existingSorteos = await prisma.sorteo.findMany({
        where: {
          loteriaId,
          scheduledAt: { in: scheduledDates },
        },
        select: { scheduledAt: true },
      });

      existingDatesSet = new Set(
        existingSorteos.map((s) => s.scheduledAt.getTime())
      );
    }

    // Mapear con campo alreadyExists
    const data = filteredOccurrences.map((o: any) => {
      const scheduledAtTime = o.scheduledAt.getTime();
      return {
        scheduledAt: formatIsoLocal(o.scheduledAt),
        name: o.name,
        loteriaId,
        alreadyExists: existingDatesSet.has(scheduledAtTime),
      };
    });

    return success(res, data.slice(0, limit), {
      count: data.length,
      from: formatIsoLocal(startOfDay),
      to: formatIsoLocal(endOfDays),
      allowPast, //  NUEVO: indicar al cliente si se permitieron fechas pasadas
    });
  },

  async seedSorteos(req: Request, res: Response) {
    const loteriaId = req.params.id
    const start = req.query.start ? parseCostaRicaDateTime(String(req.query.start)) : new Date()
    const days = req.query.days ? Number(req.query.days) : 1 // Cambiado de 7 a 1
    const dryRun = req.query.dryRun === "true"

    if (isNaN(start.getTime())) {
      return res.status(400).json({ success: false, message: "start inválido" })
    }
    if (days < 1 || days > 31) {
      return res.status(400).json({ success: false, message: "days debe ser 1..31" })
    }

    // El body ya está validado por el middleware, puede ser {} o tener scheduledDates
    const body = (req as any).body || {}
    let subset: Date[] | undefined = undefined;
    
    if (Array.isArray(body.scheduledDates) && body.scheduledDates.length > 0) {
      const parsedDates = (body.scheduledDates as Array<string | Date | number>)
        .map((d: string | Date | number): Date | null => {
          try {
            // Si ya es un Date, usarlo directamente
            if (d instanceof Date) {
              return d;
            }
            // Si es string, parsearlo
            if (typeof d === 'string') {
              return parseCostaRicaDateTime(d);
            }
            // Si es número (timestamp), convertirlo
            if (typeof d === 'number') {
              return new Date(d);
            }
            return null;
          } catch (err: any) {
            req.logger?.warn({
              layer: "controller",
              action: "LOTERIA_SEED_SORTEOS_PARSE_DATE_ERROR",
              payload: {
                loteriaId,
                dateValue: d,
                error: err.message,
              },
            });
            return null;
          }
        })
        .filter((d: Date | null): d is Date => !!d);
      
      if (parsedDates.length > 0) {
        subset = parsedDates;
        req.logger?.info({
          layer: "controller",
          action: "LOTERIA_SEED_SORTEOS_SUBSET_PARSED",
          payload: {
            loteriaId,
            originalCount: body.scheduledDates.length,
            parsedCount: parsedDates.length,
            parsedDates: parsedDates.map(d => d.toISOString()),
          },
        });
      } else {
        req.logger?.warn({
          layer: "controller",
          action: "LOTERIA_SEED_SORTEOS_NO_VALID_DATES",
          payload: {
            loteriaId,
            scheduledDates: body.scheduledDates,
            message: "No se pudieron parsear las fechas del body",
          },
        });
      }
    }

    (req as any)?.logger?.info({
      layer: "controller",
      action: "LOTERIA_SEED_SORTEOS",
      requestId: (req as any)?.requestId ?? null,
      payload: {
        loteriaId,
        start: start.toISOString(),
        days,
        dryRun,
        hasSubset: subset !== undefined,
        subsetLength: subset ? subset.length : 0,
      },
    });

    try {
      // Cuando se llama manualmente desde el endpoint, siempre forzar la creación
      // (ignorar la bandera autoCreateSorteos que solo aplica para autogeneración automática)
      const result = await LoteriaService.seedSorteosFromRules(loteriaId, start, days, dryRun, subset, true)
      
      // Log del resultado
      req.logger?.info({
        layer: "controller",
        action: "LOTERIA_SEED_SORTEOS_RESULT",
        payload: {
          loteriaId,
          dryRun,
          result: {
            created: Array.isArray(result.created) ? result.created.length : (typeof result.created === 'number' ? result.created : 0),
            skipped: Array.isArray(result.skipped) ? result.skipped.length : (typeof result.skipped === 'number' ? result.skipped : 0),
            alreadyExists: Array.isArray(result.alreadyExists) ? result.alreadyExists.length : 0,
            processed: Array.isArray(result.processed) ? result.processed.length : 0,
            note: (result as any).note,
          },
        },
      });

      return res.json({ success: true, data: result })
    } catch (error: any) {
      req.logger?.error({
        layer: "controller",
        action: "LOTERIA_SEED_SORTEOS_ERROR",
        payload: {
          loteriaId,
          error: error.message,
          stack: error.stack,
        },
      });
      throw error;
    }
  }

};

export default LoteriaController;
