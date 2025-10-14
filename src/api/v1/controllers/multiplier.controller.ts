import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import MultiplierService from "../services/mulriplier.service";

export const MultiplierController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const r = await MultiplierService.create(req.user!.id, req.body);
    return res.status(201).json({ success: true, data: r });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const r = await MultiplierService.update(req.user!.id, req.params.id, req.body);
    return res.json({ success: true, data: r });
  },

  async softDelete(req: AuthenticatedRequest, res: Response) {
    const enable = req.body?.isActive === true;
    const r = await MultiplierService.softDelete(req.user!.id, req.params.id, enable);
    return res.json({ success: true, data: r });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const r = await MultiplierService.restore(req.user!.id, req.params.id);
    return res.json({ success: true, data: r });
  },

  async getById(req: AuthenticatedRequest, res: Response) {
    const r = await MultiplierService.getById(req.params.id);
    return res.json({ success: true, data: r });
  },

  async list(req: AuthenticatedRequest, res: Response) {
    const r = await MultiplierService.list(req.query);
    return res.json({ success: true, data: r.data, meta: r.meta });
  },
};

export default MultiplierController;
