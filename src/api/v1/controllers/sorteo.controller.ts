import { Response } from "express";
import { SorteoService } from "../services/sorteo.service";
import { AuthenticatedRequest } from "../../../core/types";

export const SorteoController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: s });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.update(req.params.id, req.body, req.user!.id);
    res.json({ success: true, data: s });
  },

  async open(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.open(req.params.id, req.user!.id);
    res.json({ success: true, data: s });
  },

  async close(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.close(req.params.id, req.user!.id);
    res.json({ success: true, data: s });
  },

  async evaluate(req: AuthenticatedRequest, res: Response) {
    // Body ya validado por validateEvaluateSorteo
    const s = await SorteoService.evaluate(
      req.params.id,
      req.body,
      req.user!.id
    );
    res.json({ success: true, data: s });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.remove(
      req.params.id,
      req.user!.id,
      req.body?.reason
    );
    res.json({ success: true, data: s });
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const loteriaId = req.query.loteriaId
      ? String(req.query.loteriaId)
      : undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize
      ? Number(req.query.pageSize)
      : undefined;
    const status =
      typeof req.query.status === "string"
        ? (req.query.status as any)
        : undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined; // ✅

    const result = await SorteoService.list({
      loteriaId,
      page,
      pageSize,
      status,
      search,
    });
    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async findById(req: AuthenticatedRequest, res: Response) {
    const s = await SorteoService.findById(req.params.id);
    res.json({ success: true, data: s });
  },

};
