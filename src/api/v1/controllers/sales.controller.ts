// src/api/v1/controllers/sales.controller.ts
import { Response } from "express";
import { AuthenticatedRequest } from "../../../core/types";
import { SalesService } from "../services/sales.service";

export const SalesController = {
  async getDailyStats(req: AuthenticatedRequest, res: Response) {
    const { vendedorId, ventanaId, bancaId, date } = req.query;

    const stats = await SalesService.getDailyStats({
      vendedorId: vendedorId as string | undefined,
      ventanaId: ventanaId as string | undefined,
      bancaId: bancaId as string | undefined,
      date: date as string | undefined,
    });

    res.json({ success: true, data: stats });
  },
};










