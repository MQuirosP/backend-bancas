import { Request, Response } from "express";
import { VentanaService } from "../services/ventana.service";
import { AuthenticatedRequest } from "../../../core/types";

export const VentanaController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const ventana = await VentanaService.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: ventana });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const ventana = await VentanaService.update(id, req.body, req.user!.id);
    res.json({ success: true, data: ventana });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const ventana = await VentanaService.softDelete(id, req.user!.id, reason);
    res.json({ success: true, data: ventana });
  },

  async findAll(req: Request, res: Response) {
  const page     = req.query.page ? Number(req.query.page) : undefined;
  const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
  const search   = typeof req.query.search === "string" ? req.query.search : undefined;

  const result = await VentanaService.findAll(page, pageSize, search);
  res.json({ success: true, data: result.data, meta: result.meta });
},

  async findById(req: Request, res: Response) {
    const { id } = req.params;
    const ventana = await VentanaService.findById(id);
    res.json({ success: true, data: ventana });
  },

  async restore(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const ventana = await VentanaService.restore(id, req.user!.id, reason);
    res.json({ success: true, data: ventana });
  },
};
