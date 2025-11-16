import { Request, Response } from "express";
import { BancaService } from "../services/banca.service";
import { AuthenticatedRequest } from "../../../core/types";

export const BancaController = {
  async create(req: AuthenticatedRequest, res: Response) {
    const banca = await BancaService.create(req.body, req.user!.id);
    res.status(201).json({ success: true, data: banca });
  },

  async update(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const banca = await BancaService.update(id, req.body, req.user!.id);
    res.json({ success: true, data: banca });
  },

  async delete(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body;
    const banca = await BancaService.softDelete(id, req.user!.id, reason);
    res.json({ success: true, data: banca });
  },

  async findAll(req: AuthenticatedRequest, res: Response) {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
    const search = req.query.search?.toString().trim();
    const user = req.user;
    const result = await BancaService.findAll(
      page, 
      pageSize, 
      search, 
      undefined, 
      user?.id, 
      user?.role
    );
    res.json({ success: true, data: result.data, meta: result.meta });
  },

  async findById(req: Request, res: Response) {
    const { id } = req.params;
    const banca = await BancaService.findById(id);
    res.json({ success: true, data: banca });
  },

   async restore(req: AuthenticatedRequest, res: Response) {
    const { id } = req.params;
    const { reason } = req.body; // opcional, solo para auditoría
    const banca = await BancaService.restore(id, req.user!.id, reason);
    res.json({ success: true, data: banca });
  },
};
